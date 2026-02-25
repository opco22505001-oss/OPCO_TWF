import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.7.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(payload: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function sumScore(scoreObj: Record<string, unknown> | null | undefined) {
  return Object.values(scoreObj || {}).reduce((sum, value) => sum + (Number(value) || 0), 0);
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const requestId = crypto.randomUUID();
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const body = await req.json().catch(() => ({}));

    // 디버깅: 헤더 확인
    const authHeader = req.headers.get("Authorization");
    console.log(`[admin-event-action] [${requestId}] Headers:`, Object.fromEntries(req.headers.entries()));

    // 토큰 추출 로직: Body의 accessToken을 최우선으로 함
    let token = "";
    if (typeof body?.accessToken === "string" && body.accessToken) {
      token = body.accessToken;
      console.log(`[admin-event-action] [${requestId}] Token source: Body`);
    } else if (authHeader?.startsWith("Bearer ")) {
      token = authHeader.substring(7);
      console.log(`[admin-event-action] [${requestId}] Token source: Authorization Header`);
    }

    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    if (!token) {
      console.error(`[admin-event-action] [${requestId}] No token found`);
      return jsonResponse({
        error: "인증 토큰이 누락되었습니다.",
        code: "TOKEN_MISSING",
        request_id: requestId,
        status: 401
      }, 401);
    }

    // 서비스 롤 클라이언트로 직접 사용자 토큰 검증 (수동 JWT 검증)
    const { data: authData, error: authError } = await adminClient.auth.getUser(token);

    if (authError || !authData?.user) {
      console.error(`[admin-event-action] [${requestId}] JWT Verification failed:`, authError);
      return jsonResponse({
        error: "유효하지 않은 세션이거나 토큰이 만료되었습니다.",
        code: "AUTH_FAILED",
        detail: authError?.message,
        request_id: requestId,
        status: 401
      }, 401);
    }

    const requesterId = authData.user.id;
    const requesterEmail = authData.user.email ?? "";
    const requesterMetaRole = String(authData.user.user_metadata?.role ?? "");
    const requesterEmpno = requesterEmail.includes("@") ? requesterEmail.split("@")[0] : "";

    // DB에서 관리자 권한 최종 확인
    const { data: meById, error: meError } = await adminClient
      .from("users")
      .select("role")
      .eq("id", requesterId)
      .maybeSingle();

    let roleByEmail = "";
    if (requesterEmail) {
      const { data: meByEmail } = await adminClient
        .from("users")
        .select("role")
        .eq("email", requesterEmail)
        .maybeSingle();
      roleByEmail = String(meByEmail?.role ?? "");
    }

    let corpRole = "";
    if (requesterEmpno) {
      const { data: corpMe } = await adminClient
        .from("corporate_employees")
        .select("role")
        .eq("empno", requesterEmpno)
        .maybeSingle();
      corpRole = String(corpMe?.role ?? "");
    }

    const isAdmin = meById?.role === "admin" || roleByEmail === "admin" || requesterMetaRole === "admin" || corpRole === "admin";
    if (meError || !isAdmin) {
      console.error(`[admin-event-action] [${requestId}] Forbidden:`, { uid: requesterId, roles: { db: meById?.role, meta: requesterMetaRole, corp: corpRole } });
      return jsonResponse({ error: "관리자 권한이 없습니다.", code: "ADMIN_REQUIRED", request_id: requestId, status: 403 }, 403);
    }

    if (!meById && isAdmin && requesterId && requesterEmail) {
      await adminClient.from("users").upsert({
        id: requesterId,
        email: requesterEmail,
        name: authData.user.user_metadata?.name ?? null,
        department: authData.user.user_metadata?.department ?? null,
        role: "admin",
        updated_at: new Date().toISOString(),
      });
    }

    const action = body?.action;
    const eventId = body?.eventId;
    if (!eventId || typeof eventId !== "string") {
      return jsonResponse({ error: "eventId가 필요합니다.", status: 400 }, 400);
    }

    const { data: eventRow, error: eventError } = await adminClient
      .from("events")
      .select("id, title, status, result_finalized, is_blind_judging")
      .eq("id", eventId)
      .maybeSingle();

    if (eventError) return jsonResponse({ error: eventError.message, status: 500 }, 500);
    if (!eventRow) return jsonResponse({ error: "대상 이벤트를 찾을 수 없습니다.", status: 404 }, 404);

    if (action === "close_event") {
      const { error: updateError } = await adminClient
        .from("events")
        .update({
          status: "closed",
          end_date: new Date().toISOString().slice(0, 10),
          updated_at: new Date().toISOString(),
        })
        .eq("id", eventId);

      if (updateError) return jsonResponse({ error: updateError.message, status: 500 }, 500);

      await adminClient.from("admin_audit_logs").insert({
        actor_user_id: requesterId,
        action: "close_event",
        target_type: "event",
        target_id: eventId,
        metadata: {
          title: eventRow.title,
          prevStatus: eventRow.status,
          nextStatus: "closed",
        },
      });

      return jsonResponse({ ok: true, action, eventId });
    }

    if (action === "finalize_results") {
      if (eventRow.status !== "closed") {
        return jsonResponse({ error: "결과 확정은 마감된 이벤트에서만 가능합니다.", status: 400 }, 400);
      }
      if (eventRow.result_finalized) {
        return jsonResponse({ error: "이미 결과 확정된 이벤트입니다.", status: 400 }, 400);
      }

      const { data: submissions, error: submissionsError } = await adminClient
        .from("submissions")
        .select("id, created_at, content, submitter:users(name)")
        .eq("event_id", eventId);
      if (submissionsError) return jsonResponse({ error: submissionsError.message, status: 500 }, 500);

      const submissionIds = (submissions || []).map((row) => row.id);
      const { data: judgments, error: judgmentsError } = submissionIds.length
        ? await adminClient
          .from("judgments")
          .select("submission_id, score")
          .in("submission_id", submissionIds)
        : { data: [], error: null };
      if (judgmentsError) return jsonResponse({ error: judgmentsError.message, status: 500 }, 500);

      const grouped = new Map<string, number[]>();
      (judgments || []).forEach((row) => {
        if (!grouped.has(row.submission_id)) grouped.set(row.submission_id, []);
        grouped.get(row.submission_id)?.push(sumScore(row.score as Record<string, unknown>));
      });

      const ranked = (submissions || [])
        .map((sub) => {
          const scores = grouped.get(sub.id) || [];
          if (!scores.length) return null;
          const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
          const best = Math.max(...scores);
          const title = (sub.content as Record<string, unknown>)?.title || "제출물";
          const submitterName = (sub.submitter as { name?: string } | null)?.name || "익명";
          return {
            submission_id: sub.id,
            created_at: sub.created_at,
            title,
            submitter_name: eventRow.is_blind_judging ? null : submitterName,
            avg_score: Number(avg.toFixed(4)),
            best_score: Number(best.toFixed(4)),
            judge_count: scores.length,
          };
        })
        .filter((row): row is NonNullable<typeof row> => !!row)
        .sort((a, b) => {
          if (b.avg_score !== a.avg_score) return b.avg_score - a.avg_score;
          if (b.best_score !== a.best_score) return b.best_score - a.best_score;
          return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
        })
        .map((row, index) => ({
          ...row,
          rank: index + 1,
        }));

      const { error: finalizeError } = await adminClient
        .from("events")
        .update({
          result_finalized: true,
          results_finalized_at: new Date().toISOString(),
          finalized_ranking_snapshot: ranked,
          updated_at: new Date().toISOString(),
        })
        .eq("id", eventId);

      if (finalizeError) return jsonResponse({ error: finalizeError.message, status: 500 }, 500);

      await adminClient.from("admin_audit_logs").insert({
        actor_user_id: requesterId,
        action: "finalize_results",
        target_type: "event",
        target_id: eventId,
        metadata: {
          title: eventRow.title,
          rankedCount: ranked.length,
        },
      });

      return jsonResponse({ ok: true, action, eventId });
    }

    if (action === "delete_event") {
      const { data: deletePayload, error: deleteError } = await adminClient
        .rpc("admin_delete_event_with_backup", {
          p_event_id: eventId,
          p_actor_user_id: requesterId,
          p_reason: "admin_event_action.delete_event",
        });

      if (deleteError) return jsonResponse({ error: deleteError.message, status: 500 }, 500);

      await adminClient.from("admin_audit_logs").insert({
        actor_user_id: requesterId,
        action: "delete_event",
        target_type: "event",
        target_id: eventId,
        metadata: {
          title: eventRow.title,
          prevStatus: eventRow.status,
          backup: deletePayload ?? null,
        },
      });

      return jsonResponse({ ok: true, action, eventId, backup: deletePayload ?? null });
    }

    return jsonResponse({ error: "지원하지 않는 action 입니다.", status: 400 }, 400);
  } catch (error) {
    console.error(`[admin-event-action] [${requestId}] Internal Error:`, error);
    return jsonResponse({ error: (error as Error).message, request_id: requestId, status: 500 }, 500);
  }
});

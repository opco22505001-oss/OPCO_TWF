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

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const body = await req.json().catch(() => ({}));
    const accessToken = typeof body?.accessToken === "string" ? body.accessToken : "";

    const authClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? (accessToken ? `Bearer ${accessToken}` : "") } },
    });
    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    const { data: authData, error: authError } = accessToken
      ? await adminClient.auth.getUser(accessToken)
      : await authClient.auth.getUser();
    if (authError || !authData?.user) {
      return jsonResponse({ error: "로그인이 필요합니다." }, 401);
    }

    const requesterId = authData.user.id;
    const { data: me, error: meError } = await adminClient
      .from("users")
      .select("role")
      .eq("id", requesterId)
      .maybeSingle();

    if (meError || me?.role !== "admin") {
      return jsonResponse({ error: "관리자 권한이 없습니다." }, 403);
    }

    const action = body?.action;
    const eventId = body?.eventId;
    const adminCode = body?.adminCode;
    const requiredAdminCode = Deno.env.get("ADMIN_CODE") ?? "OPCO_ADMIN_2024";

    if (!eventId || typeof eventId !== "string") {
      return jsonResponse({ error: "eventId가 필요합니다." }, 400);
    }
    if (!adminCode || adminCode !== requiredAdminCode) {
      return jsonResponse({ error: "관리자 인증 코드가 올바르지 않습니다." }, 401);
    }

    const { data: eventRow, error: eventError } = await adminClient
      .from("events")
      .select("id, title, status, result_finalized, is_blind_judging")
      .eq("id", eventId)
      .maybeSingle();

    if (eventError) return jsonResponse({ error: eventError.message }, 500);
    if (!eventRow) return jsonResponse({ error: "대상 이벤트를 찾을 수 없습니다." }, 404);

    if (action === "close_event") {
      const { error: updateError } = await adminClient
        .from("events")
        .update({
          status: "closed",
          end_date: new Date().toISOString().slice(0, 10),
          updated_at: new Date().toISOString(),
        })
        .eq("id", eventId);

      if (updateError) return jsonResponse({ error: updateError.message }, 500);

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
        return jsonResponse({ error: "결과 확정은 마감된 이벤트에서만 가능합니다." }, 400);
      }
      if (eventRow.result_finalized) {
        return jsonResponse({ error: "이미 결과 확정된 이벤트입니다." }, 400);
      }

      const { data: submissions, error: submissionsError } = await adminClient
        .from("submissions")
        .select("id, created_at, content, submitter:users(name)")
        .eq("event_id", eventId);
      if (submissionsError) return jsonResponse({ error: submissionsError.message }, 500);

      const submissionIds = (submissions || []).map((row) => row.id);
      const { data: judgments, error: judgmentsError } = submissionIds.length
        ? await adminClient
          .from("judgments")
          .select("submission_id, score")
          .in("submission_id", submissionIds)
        : { data: [], error: null };
      if (judgmentsError) return jsonResponse({ error: judgmentsError.message }, 500);

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

      if (finalizeError) return jsonResponse({ error: finalizeError.message }, 500);

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
      const { error: deleteError } = await adminClient
        .from("events")
        .delete()
        .eq("id", eventId);

      if (deleteError) return jsonResponse({ error: deleteError.message }, 500);

      await adminClient.from("admin_audit_logs").insert({
        actor_user_id: requesterId,
        action: "delete_event",
        target_type: "event",
        target_id: eventId,
        metadata: {
          title: eventRow.title,
          prevStatus: eventRow.status,
        },
      });

      return jsonResponse({ ok: true, action, eventId });
    }

    return jsonResponse({ error: "지원하지 않는 action 입니다." }, 400);
  } catch (error) {
    return jsonResponse({ error: (error as Error).message }, 500);
  }
});

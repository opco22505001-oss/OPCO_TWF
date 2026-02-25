import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, createAdminClient, extractAccessToken, jsonResponse, requireAdminAuth } from "../_shared/admin-auth.ts";

function sumScore(scoreObj: Record<string, unknown> | null | undefined) {
  return Object.values(scoreObj || {}).reduce((sum, value) => sum + (Number(value) || 0), 0);
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const requestId = crypto.randomUUID();
  try {
    const body = await req.json().catch(() => ({}));
    const token = extractAccessToken(req, body);
    const adminClient = createAdminClient();
    const auth = await requireAdminAuth(adminClient, token, requestId);
    if (!auth.ok) return auth.response;

    const action = body?.action;
    const eventId = body?.eventId;
    if (!eventId) return jsonResponse({ error: "eventId 누락", status: 400 }, 400);

    const { data: eventRow, error: eventError } = await adminClient
      .from("events")
      .select("id, title, status")
      .eq("id", eventId)
      .maybeSingle();

    if (eventError) return jsonResponse({ error: eventError.message, status: 500 }, 500);
    if (!eventRow) return jsonResponse({ error: "이벤트 찾을 수 없음", status: 404 }, 404);

    if (action === "delete_event") {
      const { data: deletePayload, error: deleteError } = await adminClient.rpc("admin_delete_event_with_backup", {
        p_event_id: eventId,
        p_actor_user_id: auth.requesterId,
        p_reason: "admin_event_action_v2",
      });
      if (deleteError) {
        return jsonResponse({ error: deleteError.message, detail: deleteError.details, hint: deleteError.hint, status: 500 }, 500);
      }

      await adminClient.from("admin_audit_logs").insert({
        actor_user_id: auth.requesterId,
        action: "delete_event",
        target_type: "event",
        target_id: eventId,
        metadata: { title: eventRow.title, backup: deletePayload },
      });
      return jsonResponse({ ok: true, action, eventId, backup: deletePayload });
    }

    if (action === "close_event") {
      const { error: updateError } = await adminClient
        .from("events")
        .update({ status: "closed", end_date: new Date().toISOString().slice(0, 10), updated_at: new Date().toISOString() })
        .eq("id", eventId);
      if (updateError) return jsonResponse({ error: updateError.message, status: 500 }, 500);
      return jsonResponse({ ok: true, action, eventId });
    }

    if (action === "finalize_results") {
      const { data: subs, error: subsError } = await adminClient
        .from("submissions")
        .select("id, created_at, content, submitter:users!submitter_id(name)")
        .eq("event_id", eventId);
      if (subsError) return jsonResponse({ error: subsError.message, status: 500 }, 500);

      const submissionIds = (subs || []).map((s) => s.id);
      if (!submissionIds.length) return jsonResponse({ error: "제출물이 없습니다.", code: "NO_SUBMISSIONS", status: 400 }, 400);

      const { data: judgments, error: judgmentsError } = await adminClient
        .from("judgments")
        .select("submission_id, score")
        .in("submission_id", submissionIds);
      if (judgmentsError) return jsonResponse({ error: judgmentsError.message, status: 500 }, 500);

      const grouped = new Map<string, number[]>();
      (judgments || []).forEach((j) => {
        if (!grouped.has(j.submission_id)) grouped.set(j.submission_id, []);
        grouped.get(j.submission_id)?.push(sumScore(j.score as Record<string, unknown>));
      });

      const ranked = (subs || [])
        .map((sub: any) => {
          const scores = grouped.get(sub.id) || [];
          if (!scores.length) return null;
          const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
          const best = Math.max(...scores);
          return {
            submission_id: sub.id,
            title: sub?.content?.title || `제출물 #${sub.id}`,
            submitter_name: sub?.submitter?.name || "익명",
            avg_score: Number(avg.toFixed(4)),
            best_score: Number(best.toFixed(4)),
            judge_count: scores.length,
            created_at: sub.created_at,
          };
        })
        .filter(Boolean)
        .sort((a: any, b: any) => {
          if (b.avg_score !== a.avg_score) return b.avg_score - a.avg_score;
          if (b.best_score !== a.best_score) return b.best_score - a.best_score;
          return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
        })
        .map((row: any, idx: number) => ({ ...row, rank: idx + 1 }));

      const finalizedAt = new Date().toISOString();
      const { error: updateEventError } = await adminClient
        .from("events")
        .update({
          result_finalized: true,
          results_finalized_at: finalizedAt,
          finalized_ranking_snapshot: ranked,
          updated_at: finalizedAt,
        })
        .eq("id", eventId);
      if (updateEventError) return jsonResponse({ error: updateEventError.message, status: 500 }, 500);

      await adminClient.from("admin_audit_logs").insert({
        actor_user_id: auth.requesterId,
        action: "finalize_results",
        target_type: "event",
        target_id: eventId,
        metadata: { title: eventRow.title, finalized_count: ranked.length, finalized_at: finalizedAt },
      });

      return jsonResponse({ ok: true, action, eventId, finalized_at: finalizedAt, ranked_count: ranked.length });
    }

    return jsonResponse({ error: "지원하지 않는 action", status: 400 }, 400);
  } catch (error) {
    console.error(`[admin-event-action] [${requestId}] UNCAUGHT Error:`, error);
    return jsonResponse({
      error: "내부 서버 오류",
      message: (error as Error).message,
      request_id: requestId,
      status: 500,
    }, 500);
  }
});

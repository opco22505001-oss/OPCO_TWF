import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  corsHeaders,
  createAdminClient,
  enforceRateLimit,
  errorResponse,
  extractAccessToken,
  jsonResponse,
  requireAdminAuth,
  safeErrorDetail,
} from "../_shared/admin-auth.ts";

function sumScore(scoreObj: Record<string, unknown> | null | undefined) {
  return Object.values(scoreObj || {}).reduce((sum, value) => sum + (Number(value) || 0), 0);
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const requestId = crypto.randomUUID();
  try {
    const body = await req.json().catch(() => ({}));
    const token = extractAccessToken(req, body);
    const adminClient = createAdminClient();
    const auth = await requireAdminAuth(adminClient, token, requestId);
    if (!auth.ok) return auth.response;

    const rate = await enforceRateLimit(adminClient, `admin-event-action:${auth.requesterId}`, 120, 60, requestId);
    if (!rate.ok) return rate.response;

    const action = body?.action;
    const eventId = body?.eventId;
    if (!eventId) return errorResponse(400, "eventId가 필요합니다.", "BAD_REQUEST", requestId);

    const { data: eventRow, error: eventError } = await adminClient
      .from("events")
      .select("id, title, status")
      .eq("id", eventId)
      .maybeSingle();

    if (eventError) return errorResponse(500, "이벤트 조회 실패", "EVENT_QUERY_FAILED", requestId, safeErrorDetail(eventError));
    if (!eventRow) return errorResponse(404, "이벤트를 찾을 수 없습니다.", "EVENT_NOT_FOUND", requestId);

    if (action === "delete_event") {
      const { data: deletePayload, error: deleteError } = await adminClient.rpc("admin_delete_event_with_backup", {
        p_event_id: eventId,
        p_actor_user_id: auth.requesterId,
        p_reason: "admin_event_action_v2",
      });
      if (deleteError) {
        return errorResponse(500, "이벤트 삭제 처리 실패", "EVENT_DELETE_FAILED", requestId, safeErrorDetail(deleteError));
      }

      const { error: auditError } = await adminClient.from("admin_audit_logs").insert({
        actor_user_id: auth.requesterId,
        action: "delete_event",
        target_type: "event",
        target_id: eventId,
        metadata: { title: eventRow.title, backup: deletePayload },
      });
      if (auditError) {
        return errorResponse(500, "감사 로그 기록 실패", "AUDIT_LOG_FAILED", requestId, safeErrorDetail(auditError));
      }
      return jsonResponse({ ok: true, action, eventId, backup: deletePayload, request_id: requestId });
    }

    if (action === "close_event") {
      const nowIso = new Date().toISOString();
      const { error: updateError } = await adminClient
        .from("events")
        .update({ status: "closed", end_date: nowIso.slice(0, 10), updated_at: nowIso })
        .eq("id", eventId);
      if (updateError) return errorResponse(500, "이벤트 마감 실패", "EVENT_CLOSE_FAILED", requestId, safeErrorDetail(updateError));

      const { error: auditError } = await adminClient.from("admin_audit_logs").insert({
        actor_user_id: auth.requesterId,
        action: "close_event",
        target_type: "event",
        target_id: eventId,
        metadata: { title: eventRow.title, before_status: eventRow.status, after_status: "closed" },
      });
      if (auditError) {
        return errorResponse(500, "감사 로그 기록 실패", "AUDIT_LOG_FAILED", requestId, safeErrorDetail(auditError));
      }

      return jsonResponse({ ok: true, action, eventId, request_id: requestId });
    }

    if (action === "finalize_results") {
      const { data: subs, error: subsError } = await adminClient
        .from("submissions")
        .select("id, created_at, content, submitter:users!submitter_id(name)")
        .eq("event_id", eventId);
      if (subsError) return errorResponse(500, "제출물 조회 실패", "SUBMISSION_QUERY_FAILED", requestId, safeErrorDetail(subsError));

      const submissionIds = (subs || []).map((s) => s.id);
      if (!submissionIds.length) return errorResponse(400, "제출물이 없습니다.", "NO_SUBMISSIONS", requestId);

      const { data: judgments, error: judgmentsError } = await adminClient
        .from("judgments")
        .select("submission_id, score")
        .in("submission_id", submissionIds);
      if (judgmentsError) return errorResponse(500, "평가 데이터 조회 실패", "JUDGMENT_QUERY_FAILED", requestId, safeErrorDetail(judgmentsError));

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
      if (updateEventError) {
        return errorResponse(500, "결과 확정 저장 실패", "FINALIZE_UPDATE_FAILED", requestId, safeErrorDetail(updateEventError));
      }

      const { error: auditError } = await adminClient.from("admin_audit_logs").insert({
        actor_user_id: auth.requesterId,
        action: "finalize_results",
        target_type: "event",
        target_id: eventId,
        metadata: { title: eventRow.title, finalized_count: ranked.length, finalized_at: finalizedAt },
      });
      if (auditError) {
        return errorResponse(500, "감사 로그 기록 실패", "AUDIT_LOG_FAILED", requestId, safeErrorDetail(auditError));
      }

      return jsonResponse({ ok: true, action, eventId, finalized_at: finalizedAt, ranked_count: ranked.length, request_id: requestId });
    }

    return errorResponse(400, "지원하지 않는 action 입니다.", "BAD_REQUEST", requestId);
  } catch (error) {
    console.error(`[admin-event-action] [${requestId}] Internal Error:`, error);
    return errorResponse(500, "서버 처리 중 오류가 발생했습니다.", "INTERNAL_ERROR", requestId, safeErrorDetail(error));
  }
});

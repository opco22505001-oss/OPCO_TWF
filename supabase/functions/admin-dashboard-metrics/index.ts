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

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const requestId = crypto.randomUUID();
  try {
    const body = await req.json().catch(() => ({}));
    const token = extractAccessToken(req, body);
    const adminClient = createAdminClient();
    const auth = await requireAdminAuth(adminClient, token, requestId);
    if (!auth.ok) return auth.response;

    const rate = await enforceRateLimit(adminClient, `admin-dashboard-metrics:${auth.requesterId}`, 120, 60, requestId);
    if (!rate.ok) return rate.response;

    const nearDays = Number.isFinite(Number(body?.nearDays)) ? Math.max(0, Number(body.nearDays)) : 2;
    const reviewThreshold = Number.isFinite(Number(body?.reviewThreshold))
      ? Math.min(100, Math.max(1, Number(body.reviewThreshold)))
      : 70;
    const statusFilter = typeof body?.statusFilter === "string" ? body.statusFilter : "all";

    const { data: events, error: eventsError } = await adminClient
      .from("events")
      .select("id, title, status, end_date, created_at")
      .order("created_at", { ascending: false });
    if (eventsError) return errorResponse(500, "이벤트 조회 실패", "EVENT_QUERY_FAILED", requestId, safeErrorDetail(eventsError));

    const { data: snapshot, error: snapshotError } = await adminClient.rpc("admin_dashboard_metrics_snapshot");
    if (snapshotError) {
      return errorResponse(500, "지표 집계 조회 실패", "METRICS_RPC_FAILED", requestId, safeErrorDetail(snapshotError));
    }

    const submissionCounts = (snapshot?.submissionCounts || {}) as Record<string, number>;
    const judgeCounts = (snapshot?.judgeCounts || {}) as Record<string, number>;
    const judgmentCounts = (snapshot?.judgmentCounts || {}) as Record<string, number>;
    const eventDepartmentStatsFromDb = Array.isArray(snapshot?.eventDepartmentStats) ? snapshot.eventDepartmentStats : [];

    const submissionByEvent = new Map<string, number>(Object.entries(submissionCounts).map(([eventId, cnt]) => [eventId, Number(cnt || 0)]));
    const judgeByEvent = new Map<string, number>(Object.entries(judgeCounts).map(([eventId, cnt]) => [eventId, Number(cnt || 0)]));
    const judgmentByEvent = new Map<string, number>(Object.entries(judgmentCounts).map(([eventId, cnt]) => [eventId, Number(cnt || 0)]));

    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const perEvent = (events || []).map((event) => {
      const submissionCount = submissionByEvent.get(event.id) || 0;
      const judgeCount = judgeByEvent.get(event.id) || 0;
      const expectedJudgmentCount = submissionCount * judgeCount;
      const judgmentCount = judgmentByEvent.get(event.id) || 0;
      const submissionRate = submissionCount > 0 ? 100 : 0;
      const reviewRate = expectedJudgmentCount > 0 ? (judgmentCount / expectedJudgmentCount) * 100 : 0;
      const endDate = event.end_date ? new Date(event.end_date) : null;
      if (endDate) endDate.setHours(0, 0, 0, 0);
      const daysLeft = endDate ? Math.ceil((endDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)) : null;
      const effectiveStatus = event.status === "closed" || (daysLeft !== null && daysLeft < 0) ? "closed" : event.status;

      const delayed =
        (daysLeft !== null && daysLeft < 0 && reviewRate < 100) ||
        (daysLeft !== null && daysLeft <= nearDays && reviewRate < reviewThreshold);

      return {
        eventId: event.id,
        title: event.title,
        status: effectiveStatus,
        endDate: event.end_date,
        submissionRate: Number(submissionRate.toFixed(2)),
        reviewRate: Number(reviewRate.toFixed(2)),
        daysLeft,
        delayed,
      };
    });

    const activeEvents = perEvent.filter((event) => event.status === "active");
    const activeCount = activeEvents.length;
    const avgSubmissionRate = activeCount > 0
      ? Number((activeEvents.reduce((sum, e) => sum + e.submissionRate, 0) / activeCount).toFixed(2))
      : 0;
    const avgReviewRate = activeCount > 0
      ? Number((activeEvents.reduce((sum, e) => sum + e.reviewRate, 0) / activeCount).toFixed(2))
      : 0;

    const delayedEvents = perEvent
      .filter((e) => e.delayed && (statusFilter === "all" ? true : e.status === statusFilter))
      .sort((a, b) => (a.daysLeft ?? 9999) - (b.daysLeft ?? 9999));

    const deptMapByEvent = new Map<
      string,
      { departments: Array<{ department: string; count: number }>; totalSubmissions: number }
    >();
    eventDepartmentStatsFromDb.forEach((row: any) => {
      const eventId = String(row?.eventId || "");
      if (!eventId) return;
      const departments = Array.isArray(row?.departments)
        ? row.departments.map((d: any) => ({
            department: String(d?.department || "부서 미지정"),
            count: Number(d?.count || 0),
          }))
        : [];
      deptMapByEvent.set(eventId, {
        departments,
        totalSubmissions: Number(row?.totalSubmissions || 0),
      });
    });

    const eventDepartmentStats = (events || []).map((event) => {
      const deptRow = deptMapByEvent.get(event.id);
      return {
        eventId: event.id,
        title: event.title,
        status: event.status,
        totalSubmissions: Number(deptRow?.totalSubmissions || 0),
        departments: deptRow?.departments || [],
      };
    });

    return jsonResponse({
      metrics: { activeCount, avgSubmissionRate, avgReviewRate },
      delayedEvents,
      eventDepartmentStats,
      filters: { nearDays, reviewThreshold, statusFilter },
      request_id: requestId,
    });
  } catch (error) {
    console.error(`[admin-dashboard-metrics] [${requestId}] Internal Error:`, error);
    return errorResponse(500, "서버 처리 중 오류가 발생했습니다.", "INTERNAL_ERROR", requestId, safeErrorDetail(error));
  }
});

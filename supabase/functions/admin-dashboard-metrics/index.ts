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

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const requestId = crypto.randomUUID();
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const body = await req.json().catch(() => ({}));

    // ?붾쾭源? ?ㅻ뜑 ?뺤씤
    const authHeader = req.headers.get("Authorization");

    // ?좏겙 異붿텧 濡쒖쭅: Body??accessToken??理쒖슦?좎쑝濡???(?대씪?댁뼵???붿껌怨??쇱튂)
    let token = "";
    if (typeof body?.accessToken === "string" && body.accessToken) {
      token = body.accessToken;
    } else if (authHeader?.startsWith("Bearer ")) {
      token = authHeader.substring(7);
    }

    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    if (!token) {
      console.error(`[admin-dashboard-metrics] [${requestId}] No token found in request`);
      return jsonResponse({
        error: "?몄쬆 ?좏겙???꾨씫?섏뿀?듬땲??",
        code: "TOKEN_MISSING",
        request_id: requestId
      }, 401);
    }

    // ?쒕퉬??濡??대씪?댁뼵?몃줈 吏곸젒 ?ъ슜???좏겙 寃利?(?섎룞 JWT 寃利?
    const { data: authData, error: authError } = await adminClient.auth.getUser(token);

    if (authError || !authData?.user) {
      console.error(`[admin-dashboard-metrics] [${requestId}] JWT Verification failed:`, authError);
      return jsonResponse({
        error: "?좏슚?섏? ?딆? ?몄뀡?닿굅???좏겙??留뚮즺?섏뿀?듬땲??",
        code: "AUTH_FAILED",
        detail: authError?.message,
        request_id: requestId
      }, 401);
    }

    const requesterId = authData.user.id;
    const requesterEmail = authData.user.email ?? "";
    const requesterMetaRole = String(authData.user.user_metadata?.role ?? "");
    const requesterEmpno = requesterEmail.includes("@") ? requesterEmail.split("@")[0] : "";

    // DB 沅뚰븳 ?뺤씤
    const { data: meById } = await adminClient.from("users").select("role").eq("id", requesterId).maybeSingle();
    let corpRole = "";
    if (requesterEmpno) {
      const { data: corpMe } = await adminClient.from("corporate_employees").select("role").eq("empno", requesterEmpno).maybeSingle();
      corpRole = String(corpMe?.role ?? "");
    }

    const isAdmin = meById?.role === "admin" || requesterMetaRole === "admin" || corpRole === "admin";
    if (!isAdmin) {
      console.error(`[admin-dashboard-metrics] [${requestId}] Forbidden:`, { uid: requesterId, roles: { db: meById?.role, meta: requesterMetaRole, corp: corpRole } });
      return jsonResponse({ error: "愿由ъ옄 沅뚰븳???놁뒿?덈떎.", code: "ADMIN_REQUIRED", request_id: requestId }, 403);
    }

    // 硫뷀듃由??곗씠??議고쉶 (蹂?濡쒖쭅)
    const nearDays = Number.isFinite(Number(body?.nearDays)) ? Math.max(0, Number(body.nearDays)) : 2;
    const reviewThreshold = Number.isFinite(Number(body?.reviewThreshold)) ? Math.min(100, Math.max(1, Number(body.reviewThreshold))) : 70;
    const statusFilter = typeof body?.statusFilter === "string" ? body.statusFilter : "all";

    const { data: events, error: eventsError } = await adminClient.from("events").select("id, title, status, end_date, created_at").order("created_at", { ascending: false });
    if (eventsError) return jsonResponse({ error: eventsError.message }, 500);

    const { data: snapshot, error: snapshotError } = await adminClient.rpc("admin_dashboard_metrics_snapshot");
    if (snapshotError) return jsonResponse({ error: snapshotError.message }, 500);

    const submissionCounts = (snapshot?.submissionCounts || {}) as Record<string, number>;
    const judgeCounts = (snapshot?.judgeCounts || {}) as Record<string, number>;
    const judgmentCounts = (snapshot?.judgmentCounts || {}) as Record<string, number>;
    const eventDepartmentStatsFromDb = Array.isArray(snapshot?.eventDepartmentStats) ? snapshot.eventDepartmentStats : [];

    const submissionByEvent = new Map<string, number>(
      Object.entries(submissionCounts).map(([eventId, cnt]) => [eventId, Number(cnt || 0)]),
    );
    const judgeByEvent = new Map<string, number>(
      Object.entries(judgeCounts).map(([eventId, cnt]) => [eventId, Number(cnt || 0)]),
    );
    const judgmentByEvent = new Map<string, number>(
      Object.entries(judgmentCounts).map(([eventId, cnt]) => [eventId, Number(cnt || 0)]),
    );

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
      const effectiveStatus = (event.status === "closed" || (daysLeft !== null && daysLeft < 0)) ? "closed" : event.status;

      const delayed = (daysLeft !== null && daysLeft < 0 && reviewRate < 100) || (daysLeft !== null && daysLeft <= nearDays && reviewRate < reviewThreshold);

      return { eventId: event.id, title: event.title, status: effectiveStatus, endDate: event.end_date, submissionRate: Number(submissionRate.toFixed(2)), reviewRate: Number(reviewRate.toFixed(2)), daysLeft, delayed };
    });

    const activeEvents = perEvent.filter((event) => event.status === "active");
    const activeCount = activeEvents.length;
    const avgSubmissionRate = activeCount > 0 ? Number((activeEvents.reduce((sum, e) => sum + e.submissionRate, 0) / activeCount).toFixed(2)) : 0;
    const avgReviewRate = activeCount > 0 ? Number((activeEvents.reduce((sum, e) => sum + e.reviewRate, 0) / activeCount).toFixed(2)) : 0;

    const delayedEvents = perEvent.filter((e) => e.delayed && (statusFilter === "all" ? true : e.status === statusFilter)).sort((a, b) => (a.daysLeft ?? 9999) - (b.daysLeft ?? 9999));

    const deptMapByEvent = new Map<string, { departments: Array<{ department: string; count: number }>; totalSubmissions: number }>();
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
      request_id: requestId
    });
  } catch (error) {
    console.error(`[admin-dashboard-metrics] [${requestId}] Internal Error:`, error);
    return jsonResponse({ error: (error as Error).message, request_id: requestId }, 500);
  }
});


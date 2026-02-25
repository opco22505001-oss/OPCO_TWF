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

    const { data: submissions } = await adminClient.from("submissions").select("id, event_id, submitter_id");
    const { data: eventJudges } = await adminClient.from("event_judges").select("event_id, judge_id");
    const { data: judgments } = await adminClient.from("judgments").select("id, submission_id");
    const { data: users } = await adminClient.from("users").select("id, department");

    const submissionByEvent = new Map<string, number>();
    (submissions || []).forEach((s) => submissionByEvent.set(s.event_id, (submissionByEvent.get(s.event_id) || 0) + 1));

    const judgeByEvent = new Map<string, number>();
    (eventJudges || []).forEach((j) => judgeByEvent.set(j.event_id, (judgeByEvent.get(j.event_id) || 0) + 1));

    const submissionEventMap = new Map<string, string>();
    (submissions || []).forEach((s) => submissionEventMap.set(s.id, s.event_id));

    const judgmentByEvent = new Map<string, number>();
    (judgments || []).forEach((j) => {
      const eventId = submissionEventMap.get(j.submission_id);
      if (eventId) judgmentByEvent.set(eventId, (judgmentByEvent.get(eventId) || 0) + 1);
    });

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

    const userDeptMap = new Map<string, string>();
    (users || []).forEach((u) => {
      userDeptMap.set(u.id, u.department || "부서 미지정");
    });

    const deptCountByEvent = new Map<string, Map<string, number>>();
    (submissions || []).forEach((s) => {
      const eventId = s.event_id;
      if (!eventId) return;
      const dept = userDeptMap.get(s.submitter_id) || "부서 미지정";
      if (!deptCountByEvent.has(eventId)) deptCountByEvent.set(eventId, new Map<string, number>());
      const deptMap = deptCountByEvent.get(eventId)!;
      deptMap.set(dept, (deptMap.get(dept) || 0) + 1);
    });

    const eventDepartmentStats = (events || []).map((event) => {
      const deptMap = deptCountByEvent.get(event.id) || new Map<string, number>();
      const departments = Array.from(deptMap.entries())
        .map(([department, count]) => ({ department, count }))
        .sort((a, b) => b.count - a.count || a.department.localeCompare(b.department, "ko"));
      return {
        eventId: event.id,
        title: event.title,
        status: event.status,
        totalSubmissions: departments.reduce((sum, row) => sum + row.count, 0),
        departments,
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


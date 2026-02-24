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
    if (authError || !authData?.user) return jsonResponse({ error: "로그인이 필요합니다." }, 401);

    const requesterId = authData.user.id;
    const { data: me, error: meError } = await adminClient
      .from("users")
      .select("role")
      .eq("id", requesterId)
      .maybeSingle();
    if (meError || me?.role !== "admin") return jsonResponse({ error: "관리자 권한이 없습니다." }, 403);

    const nearDays = Number.isFinite(Number(body?.nearDays)) ? Math.max(0, Number(body.nearDays)) : 2;
    const reviewThreshold = Number.isFinite(Number(body?.reviewThreshold))
      ? Math.min(100, Math.max(1, Number(body.reviewThreshold)))
      : 70;
    const statusFilter = typeof body?.statusFilter === "string" ? body.statusFilter : "all";

    const { data: events, error: eventsError } = await adminClient
      .from("events")
      .select("id, title, status, end_date, created_at")
      .order("created_at", { ascending: false });
    if (eventsError) return jsonResponse({ error: eventsError.message }, 500);

    const { data: submissions, error: submissionsError } = await adminClient
      .from("submissions")
      .select("id, event_id");
    if (submissionsError) return jsonResponse({ error: submissionsError.message }, 500);

    const { data: eventJudges, error: judgesError } = await adminClient
      .from("event_judges")
      .select("event_id, judge_id");
    if (judgesError) return jsonResponse({ error: judgesError.message }, 500);

    const { data: judgments, error: judgmentError } = await adminClient
      .from("judgments")
      .select("id, submission_id");
    if (judgmentError) return jsonResponse({ error: judgmentError.message }, 500);

    const submissionByEvent = new Map<string, number>();
    (submissions || []).forEach((s) => {
      submissionByEvent.set(s.event_id, (submissionByEvent.get(s.event_id) || 0) + 1);
    });

    const judgeByEvent = new Map<string, number>();
    (eventJudges || []).forEach((j) => {
      judgeByEvent.set(j.event_id, (judgeByEvent.get(j.event_id) || 0) + 1);
    });

    const submissionEventMap = new Map<string, string>();
    (submissions || []).forEach((s) => submissionEventMap.set(s.id, s.event_id));

    const judgmentByEvent = new Map<string, number>();
    (judgments || []).forEach((j) => {
      const eventId = submissionEventMap.get(j.submission_id);
      if (!eventId) return;
      judgmentByEvent.set(eventId, (judgmentByEvent.get(eventId) || 0) + 1);
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

      const delayedByOverdue = (daysLeft !== null && daysLeft < 0 && reviewRate < 100);
      const delayedByNearDeadline = (daysLeft !== null && daysLeft <= nearDays && reviewRate < reviewThreshold);
      const delayed = delayedByOverdue || delayedByNearDeadline;

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
      ? Number((activeEvents.reduce((sum, event) => sum + event.submissionRate, 0) / activeCount).toFixed(2))
      : 0;
    const avgReviewRate = activeCount > 0
      ? Number((activeEvents.reduce((sum, event) => sum + event.reviewRate, 0) / activeCount).toFixed(2))
      : 0;

    const delayedEvents = perEvent
      .filter((event) => event.delayed)
      .filter((event) => statusFilter === "all" ? true : event.status === statusFilter)
      .sort((a, b) => (a.daysLeft ?? 9999) - (b.daysLeft ?? 9999));

    return jsonResponse({
      metrics: { activeCount, avgSubmissionRate, avgReviewRate },
      delayedEvents,
      filters: { nearDays, reviewThreshold, statusFilter },
    });
  } catch (error) {
    return jsonResponse({ error: (error as Error).message }, 500);
  }
});

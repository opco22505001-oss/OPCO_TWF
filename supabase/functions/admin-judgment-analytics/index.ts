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

    const rate = await enforceRateLimit(adminClient, `admin-judgment-analytics:${auth.requesterId}`, 120, 60, requestId);
    if (!rate.ok) return rate.response;

    const { data: judgments, error: judgmentsError } = await adminClient
      .from("judgments")
      .select("judge_id, score");
    if (judgmentsError) return errorResponse(500, "심사 데이터 조회 실패", "JUDGMENT_QUERY_FAILED", requestId, safeErrorDetail(judgmentsError));

    const { data: users, error: usersError } = await adminClient
      .from("users")
      .select("id, name, department");
    if (usersError) return errorResponse(500, "사용자 조회 실패", "USER_QUERY_FAILED", requestId, safeErrorDetail(usersError));

    const scoreOf = (scoreObj: Record<string, unknown> | null) =>
      Object.values(scoreObj || {}).reduce((sum, v) => sum + (Number(v) || 0), 0);

    const byJudge = new Map<string, number[]>();
    (judgments || []).forEach((j) => {
      if (!byJudge.has(j.judge_id)) byJudge.set(j.judge_id, []);
      byJudge.get(j.judge_id)?.push(scoreOf(j.score as Record<string, unknown>));
    });

    const userMap = new Map((users || []).map((u) => [u.id, u]));
    const stats = Array.from(byJudge.entries())
      .map(([judgeId, arr]) => {
        const count = arr.length;
        const avg = count ? arr.reduce((a, b) => a + b, 0) / count : 0;
        const variance = count ? arr.reduce((sum, x) => sum + Math.pow(x - avg, 2), 0) / count : 0;
        const stddev = Math.sqrt(variance);
        const user = userMap.get(judgeId);
        return {
          judgeId,
          judgeName: user?.name || "이름없음",
          department: user?.department || "",
          count,
          avgScore: Number(avg.toFixed(2)),
          stddevScore: Number(stddev.toFixed(2)),
        };
      })
      .sort((a, b) => b.count - a.count);

    return jsonResponse({ stats, request_id: requestId });
  } catch (error) {
    return errorResponse(500, "서버 처리 중 오류가 발생했습니다.", "INTERNAL_ERROR", requestId, safeErrorDetail(error));
  }
});

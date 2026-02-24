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
    const requesterEmail = authData.user.email ?? "";
    const requesterMetaRole = String(authData.user.user_metadata?.role ?? "");
    const requesterEmpno = requesterEmail.includes("@") ? requesterEmail.split("@")[0] : "";
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
    if (meError || !isAdmin) return jsonResponse({ error: "관리자 권한이 없습니다." }, 403);

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

    const { data: judgments, error: judgmentsError } = await adminClient
      .from("judgments")
      .select("judge_id, score");
    if (judgmentsError) return jsonResponse({ error: judgmentsError.message }, 500);

    const { data: users, error: usersError } = await adminClient
      .from("users")
      .select("id, name, department");
    if (usersError) return jsonResponse({ error: usersError.message }, 500);

    const scoreOf = (scoreObj: Record<string, unknown> | null) =>
      Object.values(scoreObj || {}).reduce((sum, v) => sum + (Number(v) || 0), 0);

    const byJudge = new Map<string, number[]>();
    (judgments || []).forEach((j) => {
      if (!byJudge.has(j.judge_id)) byJudge.set(j.judge_id, []);
      byJudge.get(j.judge_id)?.push(scoreOf(j.score as Record<string, unknown>));
    });

    const userMap = new Map((users || []).map((u) => [u.id, u]));
    const stats = Array.from(byJudge.entries()).map(([judgeId, arr]) => {
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
    }).sort((a, b) => b.count - a.count);

    return jsonResponse({ stats });
  } catch (error) {
    return jsonResponse({ error: (error as Error).message }, 500);
  }
});

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

    const authHeader = req.headers.get("Authorization");
    console.log(`[admin-audit-logs] [${requestId}] Headers:`, Object.fromEntries(req.headers.entries()));

    // 토큰 추출 로직: Body의 accessToken을 최우선으로 함 (클라이언트 요청과 일치)
    let token = "";
    if (typeof body?.accessToken === "string" && body.accessToken) {
      token = body.accessToken;
      console.log(`[admin-audit-logs] [${requestId}] Token source: Body`);
    } else if (authHeader?.startsWith("Bearer ")) {
      token = authHeader.substring(7);
      console.log(`[admin-audit-logs] [${requestId}] Token source: Authorization Header`);
    }

    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    if (!token) {
      console.error(`[admin-audit-logs] [${requestId}] No token found in request`);
      return jsonResponse({
        error: "인증 토큰이 누락되었습니다.",
        code: "TOKEN_MISSING",
        request_id: requestId
      }, 401);
    }

    // 서비스 롤 클라이언트로 직접 사용자 토큰 검증 (수동 JWT 검증)
    const { data: authData, error: authError } = await adminClient.auth.getUser(token);

    if (authError || !authData?.user) {
      console.error(`[admin-audit-logs] [${requestId}] JWT Verification failed:`, authError);
      return jsonResponse({
        error: "유효하지 않은 세션이거나 토큰이 만료되었습니다.",
        code: "AUTH_FAILED",
        detail: authError?.message,
        request_id: requestId
      }, 401);
    }

    const requesterId = authData.user.id;
    const requesterEmail = authData.user.email ?? "";
    const requesterMetaRole = String(authData.user.user_metadata?.role ?? "");
    const requesterEmpno = requesterEmail.includes("@") ? requesterEmail.split("@")[0] : "";

    // DB 권한 확인
    const { data: meById } = await adminClient.from("users").select("role").eq("id", requesterId).maybeSingle();
    let corpRole = "";
    if (requesterEmpno) {
      const { data: corpMe } = await adminClient.from("corporate_employees").select("role").eq("empno", requesterEmpno).maybeSingle();
      corpRole = String(corpMe?.role ?? "");
    }

    const isAdmin = meById?.role === "admin" || requesterMetaRole === "admin" || corpRole === "admin";
    if (!isAdmin) {
      console.error(`[admin-audit-logs] [${requestId}] Forbidden:`, { uid: requesterId });
      return jsonResponse({ error: "관리자 권한이 없습니다.", code: "ADMIN_REQUIRED", request_id: requestId }, 403);
    }

    const limit = Number.isFinite(Number(body?.limit)) ? Math.min(200, Math.max(1, Number(body.limit))) : 50;
    const { data: logs, error: logsError } = await adminClient.from("admin_audit_logs").select("id, created_at, actor_user_id, action, target_type, target_id, metadata").order("created_at", { ascending: false }).limit(limit);
    if (logsError) throw logsError;

    const actorIds = Array.from(new Set((logs || []).map((log) => log.actor_user_id).filter(Boolean)));
    let usersById = new Map<string, { name: string; email: string }>();
    if (actorIds.length > 0) {
      const { data: users } = await adminClient.from("users").select("id, name, email").in("id", actorIds);
      if (users) usersById = new Map(users.map((u) => [u.id, { name: u.name || "-", email: u.email || "-" }]));
    }

    const normalized = (logs || []).map((log) => {
      const actor = usersById.get(log.actor_user_id) || { name: "-", email: "-" };
      return { ...log, actor_name: actor.name, actor_empno: String(actor.email || "").split("@")[0] || "-" };
    });

    return jsonResponse({ logs: normalized, request_id: requestId });
  } catch (error) {
    console.error(`[admin-audit-logs] [${requestId}] Internal Error:`, error);
    return jsonResponse({ error: (error as Error).message, request_id: requestId }, 500);
  }
});

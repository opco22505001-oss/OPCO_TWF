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
    const requestId = crypto.randomUUID();
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const body = await req.json().catch(() => ({}));

    // 토큰 추출 로직 강화
    const authHeader = req.headers.get("Authorization");
    let token = "";
    if (authHeader?.startsWith("Bearer ")) {
      token = authHeader.substring(7);
    } else if (typeof body?.accessToken === "string") {
      token = body.accessToken;
    }

    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    if (!token) {
      return jsonResponse({ error: "인증 토큰이 누락되었습니다.", code: "AUTH_REQUIRED" }, 401);
    }

    // service_role 클라이언트를 통한 사용자 정보 조회 (토큰 검증 포함)
    const { data: authData, error: authError } = await adminClient.auth.getUser(token);

    if (authError || !authData?.user) {
      console.error("[admin-audit-logs] auth_failed", { requestId, authError, token_exists: !!token });
      return jsonResponse({ error: "유효하지 않은 세션입니다. 다시 로그인해 주세요.", code: "AUTH_FAILED", detail: authError?.message }, 401);
    }

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
    if (meError || !isAdmin) {
      console.error("[admin-audit-logs] forbidden", { requestId, meError, requesterId });
      return jsonResponse({ error: "관리자 권한이 없습니다.", code: "ADMIN_REQUIRED" }, 403);
    }

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

    const limit = Number.isFinite(Number(body?.limit)) ? Math.min(200, Math.max(1, Number(body.limit))) : 50;

    const { data: logs, error: logsError } = await adminClient
      .from("admin_audit_logs")
      .select("id, created_at, actor_user_id, action, target_type, target_id, metadata")
      .order("created_at", { ascending: false })
      .limit(limit);
    if (logsError) return jsonResponse({ error: logsError.message }, 500);

    const actorIds = Array.from(new Set((logs || []).map((log) => log.actor_user_id).filter(Boolean)));
    let usersById = new Map<string, { name: string; email: string }>();
    if (actorIds.length > 0) {
      const { data: users, error: usersError } = await adminClient
        .from("users")
        .select("id, name, email")
        .in("id", actorIds);
      if (!usersError && users) {
        usersById = new Map(users.map((u) => [u.id, { name: u.name || "-", email: u.email || "-" }]));
      }
    }

    const normalized = (logs || []).map((log) => {
      const actor = usersById.get(log.actor_user_id) || { name: "-", email: "-" };
      const actorEmpno = String(actor.email || "").split("@")[0] || "-";
      return {
        ...log,
        actor_name: actor.name,
        actor_empno: actorEmpno,
      };
    });

    return jsonResponse({ logs: normalized, request_id: requestId });
  } catch (error) {
    return jsonResponse({ error: (error as Error).message }, 500);
  }
});

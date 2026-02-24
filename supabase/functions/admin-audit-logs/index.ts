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
    const { data: me, error: meError } = await adminClient
      .from("users")
      .select("role")
      .eq("id", requesterId)
      .maybeSingle();
    let corpRole = "";
    if (requesterEmpno) {
      const { data: corpMe } = await adminClient
        .from("corporate_employees")
        .select("role")
        .eq("empno", requesterEmpno)
        .maybeSingle();
      corpRole = String(corpMe?.role ?? "");
    }
    const isAdmin = me?.role === "admin" || requesterMetaRole === "admin" || corpRole === "admin";
    if (meError || !isAdmin) return jsonResponse({ error: "관리자 권한이 없습니다." }, 403);

    if (!me && isAdmin && requesterId && requesterEmail) {
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

    return jsonResponse({ logs: normalized });
  } catch (error) {
    return jsonResponse({ error: (error as Error).message }, 500);
  }
});

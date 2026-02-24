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
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

    const authClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    const { data: authData, error: authError } = await authClient.auth.getUser();
    if (authError || !authData?.user) return jsonResponse({ error: "로그인이 필요합니다." }, 401);

    const requesterId = authData.user.id;
    const { data: me, error: meError } = await adminClient
      .from("users")
      .select("role")
      .eq("id", requesterId)
      .maybeSingle();
    if (meError || me?.role !== "admin") return jsonResponse({ error: "관리자 권한이 없습니다." }, 403);

    const body = await req.json().catch(() => ({}));
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

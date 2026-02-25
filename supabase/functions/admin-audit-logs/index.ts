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

    const rate = await enforceRateLimit(adminClient, `admin-audit-logs:${auth.requesterId}`, 120, 60, requestId);
    if (!rate.ok) return rate.response;

    const limit = Number.isFinite(Number(body?.limit)) ? Math.min(200, Math.max(1, Number(body.limit))) : 50;
    const { data: logs, error: logsError } = await adminClient
      .from("admin_audit_logs")
      .select("id, created_at, actor_user_id, action, target_type, target_id, metadata")
      .order("created_at", { ascending: false })
      .limit(limit);
    if (logsError) throw logsError;

    const actorIds = Array.from(new Set((logs || []).map((log) => log.actor_user_id).filter(Boolean)));
    let usersById = new Map<string, { name: string; email: string }>();
    if (actorIds.length > 0) {
      const { data: users, error: usersError } = await adminClient.from("users").select("id, name, email").in("id", actorIds);
      if (usersError) throw usersError;
      if (users) usersById = new Map(users.map((u) => [u.id, { name: u.name || "-", email: u.email || "-" }]));
    }

    const normalized = (logs || []).map((log) => {
      const actor = usersById.get(log.actor_user_id) || { name: "-", email: "-" };
      return { ...log, actor_name: actor.name, actor_empno: String(actor.email || "").split("@")[0] || "-" };
    });

    return jsonResponse({ logs: normalized, request_id: requestId });
  } catch (error) {
    console.error(`[admin-audit-logs] [${requestId}] Internal Error:`, error);
    return errorResponse(500, "서버 처리 중 오류가 발생했습니다.", "INTERNAL_ERROR", requestId, safeErrorDetail(error));
  }
});

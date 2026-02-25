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

function badRequest(message: string, requestId: string) {
  return errorResponse(400, message, "BAD_REQUEST", requestId);
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const requestId = crypto.randomUUID();
  try {
    const body = await req.json().catch(() => ({}));
    const token = extractAccessToken(req, body);
    const adminClient = createAdminClient();
    const auth = await requireAdminAuth(adminClient, token, requestId);
    if (!auth.ok) return auth.response;

    const rate = await enforceRateLimit(adminClient, `admin-manage-user-role:${auth.requesterId}`, 120, 60, requestId);
    if (!rate.ok) return rate.response;

    const action = body?.action;

    if (action === "list") {
      const { data: employees, error } = await adminClient
        .from("corporate_employees")
        .select("empno, empnm, depnm, role")
        .order("empnm");
      if (error) throw error;
      return jsonResponse({ employees: employees ?? [], request_id: requestId });
    }

    if (action === "update_role") {
      const empno = body?.empno;
      const nextRole = body?.nextRole;
      const allowedRoles = ["admin", "submitter", "judge"];

      if (!empno || typeof empno !== "string") return badRequest("사번이 필요합니다.", requestId);
      if (!allowedRoles.includes(nextRole)) return badRequest("허용되지 않은 권한입니다.", requestId);

      const { data: beforeCorp } = await adminClient
        .from("corporate_employees")
        .select("role")
        .eq("empno", empno)
        .maybeSingle();

      const { data: corpRows, error: corpUpdateError } = await adminClient
        .from("corporate_employees")
        .update({ role: nextRole })
        .eq("empno", empno)
        .select("empno, empnm, depnm, role")
        .limit(1);

      if (corpUpdateError) throw corpUpdateError;
      if (!corpRows?.length) return errorResponse(404, "직원을 찾을 수 없습니다.", "EMPLOYEE_NOT_FOUND", requestId);

      const corp = corpRows[0];
      const email = `${corp.empno}@opco.internal`;

      const { data: list } = await adminClient.auth.admin.listUsers();
      const authUser = (list?.users || []).find((u) => u.email?.toLowerCase() === email.toLowerCase());

      if (authUser) {
        await adminClient.from("users").upsert({
          id: authUser.id,
          email: email,
          name: corp.empnm,
          department: corp.depnm,
          role: nextRole,
          updated_at: new Date().toISOString(),
        });

        await adminClient.auth.admin.updateUserById(authUser.id, {
          user_metadata: { ...authUser.user_metadata, role: nextRole },
        });
      } else {
        await adminClient.from("users").update({
          name: corp.empnm,
          department: corp.depnm,
          role: nextRole,
          updated_at: new Date().toISOString(),
        }).eq("email", email);
      }

      const { error: auditError } = await adminClient.from("admin_audit_logs").insert({
        actor_user_id: auth.requesterId,
        action: "update_user_role",
        target_type: "employee",
        target_id: String(empno),
        metadata: {
          empno,
          empnm: corp.empnm,
          before_role: beforeCorp?.role ?? null,
          after_role: nextRole,
        },
      });
      if (auditError) {
        return errorResponse(500, "감사 로그 기록 실패", "AUDIT_LOG_FAILED", requestId, safeErrorDetail(auditError));
      }

      return jsonResponse({ ok: true, employee: corp, request_id: requestId });
    }

    return badRequest("지원하지 않는 action 입니다.", requestId);
  } catch (error) {
    console.error(`[admin-manage-user-role] [${requestId}] Internal Error:`, error);
    return errorResponse(500, "서버 처리 중 오류가 발생했습니다.", "INTERNAL_ERROR", requestId, safeErrorDetail(error));
  }
});

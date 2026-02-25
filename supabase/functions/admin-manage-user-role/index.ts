import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, createAdminClient, extractAccessToken, jsonResponse, requireAdminAuth } from "../_shared/admin-auth.ts";

function badRequest(message: string) {
  return jsonResponse({ error: message }, 400);
}

function errorResponse(status: number, message: string, code: string, detail?: string, requestId?: string) {
  return jsonResponse({ error: message, code, detail, request_id: requestId }, status);
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const requestId = crypto.randomUUID();
  try {
    const body = await req.json().catch(() => ({}));
    const token = extractAccessToken(req, body);
    const adminClient = createAdminClient();
    const auth = await requireAdminAuth(adminClient, token, requestId);
    if (!auth.ok) return auth.response;

    const action = body?.action;

    if (action === "list") {
      const { data: employees, error } = await adminClient
        .from("corporate_employees")
        .select("empno, empnm, depnm, role")
        .order("empnm");
      if (error) throw error;
      return jsonResponse({ employees: employees ?? [] });
    }

    if (action === "update_role") {
      const empno = body?.empno;
      const nextRole = body?.nextRole;
      const adminCode = body?.adminCode;
      const allowedRoles = ["admin", "submitter", "judge"];
      const requiredAdminCode = Deno.env.get("ADMIN_CODE") ?? "OPCO_ADMIN_2024";

      if (!empno || typeof empno !== "string") return badRequest("사번이 필요합니다.");
      if (!allowedRoles.includes(nextRole)) return badRequest("허용되지 않은 권한입니다.");
      if (!adminCode || adminCode !== requiredAdminCode) {
        return errorResponse(401, "관리자 인증 코드가 틀렸습니다.", "INVALID_ADMIN_CODE", undefined, requestId);
      }

      const { data: corpRows, error: corpUpdateError } = await adminClient
        .from("corporate_employees")
        .update({ role: nextRole })
        .eq("empno", empno)
        .select("empno, empnm, depnm, role")
        .limit(1);

      if (corpUpdateError) throw corpUpdateError;
      if (!corpRows?.length) return errorResponse(400, "사원을 찾을 수 없습니다.", "EMPLOYEE_NOT_FOUND");

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

      return jsonResponse({ ok: true, employee: corp, request_id: requestId });
    }

    return badRequest("지원하지 않는 action 입니다.");
  } catch (error) {
    console.error(`[admin-manage-user-role] [${requestId}] Internal Error:`, error);
    return errorResponse(500, "서버 처리 중 오류가 발생했습니다.", "INTERNAL_ERROR", (error as Error).message, requestId);
  }
});

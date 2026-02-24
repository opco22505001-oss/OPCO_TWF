import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.7.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function badRequest(message: string) {
  return new Response(JSON.stringify({ error: message }), {
    status: 400,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function errorResponse(status: number, message: string, code: string, detail?: string, requestId?: string) {
  return new Response(
    JSON.stringify({
      error: message,
      code,
      detail,
      request_id: requestId,
    }),
    {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    },
  );
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const requestId = crypto.randomUUID();
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

    const authClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    const { data: authData, error: authError } = await authClient.auth.getUser();
    if (authError || !authData?.user) {
      console.error("[admin-manage-user-role] auth_failed", { requestId, authError });
      return errorResponse(401, "로그인이 필요합니다.", "AUTH_REQUIRED", authError?.message, requestId);
    }

    const requesterId = authData.user.id;
    const { data: me, error: meError } = await adminClient
      .from("users")
      .select("role")
      .eq("id", requesterId)
      .maybeSingle();

    if (meError || me?.role !== "admin") {
      console.error("[admin-manage-user-role] forbidden", { requestId, meError, requesterId });
      return errorResponse(403, "관리자 권한이 없습니다.", "ADMIN_REQUIRED", meError?.message, requestId);
    }

    const body = await req.json();
    const action = body?.action;

    if (action === "list") {
      const { data: employees, error } = await adminClient
        .from("corporate_employees")
        .select("empno, empnm, depnm, role")
        .order("empnm");

      if (error) throw error;

      return new Response(JSON.stringify({ employees: employees ?? [] }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "update_role") {
      const empno = body?.empno;
      const nextRole = body?.nextRole;
      const adminCode = body?.adminCode;
      const allowedRoles = ["admin", "submitter", "judge"];
      const requiredAdminCode = Deno.env.get("ADMIN_CODE") ?? "OPCO_ADMIN_2024";

      if (!empno || typeof empno !== "string") {
        return badRequest("사번(empno)이 필요합니다.");
      }
      if (!allowedRoles.includes(nextRole)) {
        return badRequest("허용되지 않은 권한입니다.");
      }
      if (!adminCode || adminCode !== requiredAdminCode) {
        return errorResponse(401, "관리자 인증 코드가 올바르지 않습니다.", "INVALID_ADMIN_CODE", undefined, requestId);
      }

      const { data: corpRows, error: corpUpdateError } = await adminClient
        .from("corporate_employees")
        .update({ role: nextRole })
        .eq("empno", empno)
        .select("empno, empnm, depnm, role")
        .limit(1);

      if (corpUpdateError) {
        console.error("[admin-manage-user-role] corporate_update_failed", { requestId, empno, nextRole, corpUpdateError });
        return errorResponse(500, "사내 인사 권한 업데이트에 실패했습니다.", "CORP_UPDATE_FAILED", corpUpdateError.message, requestId);
      }
      if (!corpRows || corpRows.length === 0) {
        return errorResponse(400, "대상 사원을 찾을 수 없습니다.", "EMPLOYEE_NOT_FOUND", undefined, requestId);
      }

      const corp = corpRows[0];
      const email = `${corp.empno}@opco.internal`;

      // public.users 동기화
      const { data: updatedUsers, error: usersError } = await adminClient
        .from("users")
        .update({
          name: corp.empnm,
          department: corp.depnm,
          role: nextRole,
          updated_at: new Date().toISOString(),
        })
        .eq("email", email)
        .select("id")
        .limit(1);

      if (usersError) {
        console.error("[admin-manage-user-role] public_users_update_failed", { requestId, email, usersError });
        return errorResponse(500, "사용자 권한 동기화(public.users)에 실패했습니다.", "PUBLIC_USERS_SYNC_FAILED", usersError.message, requestId);
      }

      // auth.users 메타데이터 동기화
      const { data: userListData, error: listError } = await adminClient.auth.admin.listUsers({
        page: 1,
        perPage: 1000,
      });
      if (listError) {
        console.error("[admin-manage-user-role] auth_list_failed", { requestId, listError });
        return errorResponse(500, "auth 사용자 조회에 실패했습니다.", "AUTH_LIST_FAILED", listError.message, requestId);
      }

      const authUser = userListData.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
      if (authUser) {
        const { error: authUpdateError } = await adminClient.auth.admin.updateUserById(authUser.id, {
          user_metadata: {
            ...(authUser.user_metadata ?? {}),
            empno: corp.empno,
            name: corp.empnm,
            department: corp.depnm,
            role: nextRole,
          },
        });
        if (authUpdateError) {
          console.error("[admin-manage-user-role] auth_update_failed", { requestId, userId: authUser.id, authUpdateError });
          return errorResponse(500, "auth 메타데이터 동기화에 실패했습니다.", "AUTH_METADATA_SYNC_FAILED", authUpdateError.message, requestId);
        }
      }

      // 관리자 권한 변경 감사 로그
      const { error: auditError } = await adminClient.from("admin_audit_logs").insert({
        actor_user_id: requesterId,
        action: "update_user_role",
        target_type: "user",
        target_id: email,
        metadata: {
          empno: corp.empno,
          name: corp.empnm,
          department: corp.depnm,
          nextRole,
        },
      });
      if (auditError) {
        console.error("[admin-manage-user-role] audit_insert_failed", { requestId, auditError });
      }

      return new Response(JSON.stringify({
        ok: true,
        employee: corp,
        syncedUserCount: updatedUsers?.length ?? 0,
        authUserSynced: !!authUser,
        request_id: requestId,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return badRequest("지원하지 않는 action 입니다.");
  } catch (error) {
    const requestId = crypto.randomUUID();
    console.error("[admin-manage-user-role] unhandled_error", { requestId, error });
    return errorResponse(500, "권한 변경 처리 중 서버 오류가 발생했습니다.", "INTERNAL_ERROR", (error as Error).message, requestId);
  }
});

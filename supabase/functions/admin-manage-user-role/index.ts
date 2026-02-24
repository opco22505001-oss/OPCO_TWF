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

  const requestId = crypto.randomUUID();
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const body = await req.json().catch(() => ({}));

    // 디버깅: 전체 헤더 확인
    const authHeader = req.headers.get("Authorization");
    console.log(`[admin-manage-user-role] [${requestId}] Headers:`, Object.fromEntries(req.headers.entries()));

    // 토큰 추출 로직 강화: Body의 accessToken을 우선시 (라이브러리 간섭 방지)
    let token = "";
    if (typeof body?.accessToken === "string" && body.accessToken) {
      token = body.accessToken;
      console.log(`[admin-manage-user-role] [${requestId}] Token source: Body (accessToken)`);
    } else if (authHeader?.startsWith("Bearer ")) {
      token = authHeader.substring(7);
      console.log(`[admin-manage-user-role] [${requestId}] Token source: Header (Authorization)`);
    }

    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    if (!token) {
      console.error(`[admin-manage-user-role] [${requestId}] No token provided`);
      return errorResponse(401, "인증 토큰이 제공되지 않았습니다.", "TOKEN_MISSING", undefined, requestId);
    }

    // 서비스 롤 클라이언트로 직접 사용자 토큰 검증
    const { data: authData, error: authError } = await adminClient.auth.getUser(token);

    if (authError || !authData?.user) {
      console.error(`[admin-manage-user-role] [${requestId}] Auth failed:`, authError);
      return errorResponse(401, "유효하지 않은 토큰이거나 세션이 만료되었습니다.", "AUTH_FAILED", authError?.message, requestId);
    }

    const requesterId = authData.user.id;
    const requesterEmail = authData.user.email ?? "";
    const requesterMetaRole = String(authData.user.user_metadata?.role ?? "");
    const requesterEmpno = requesterEmail.includes("@") ? requesterEmail.split("@")[0] : "";

    console.log(`[admin-manage-user-role] [${requestId}] Authenticated:`, { uid: requesterId, email: requesterEmail, role: requesterMetaRole });

    // DB에서 관리자 권한 최종 확인
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
      console.error(`[admin-manage-user-role] [${requestId}] Forbidden: Admin rights required`, { meError, roles: { db: meById?.role, meta: requesterMetaRole, corp: corpRole } });
      return errorResponse(403, "관리자 전용 기능입니다.", "ADMIN_REQUIRED", meError?.message, requestId);
    }

    // users 테이블 동기화 (관리자인데 없는 경우)
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

      // public.users 동기화
      await adminClient.from("users").update({
        name: corp.empnm,
        department: corp.depnm,
        role: nextRole,
        updated_at: new Date().toISOString(),
      }).eq("email", email);

      // auth.users 메타데이터 동기화
      const { data: list } = await adminClient.auth.admin.listUsers();
      const authUser = (list?.users || []).find((u) => u.email?.toLowerCase() === email.toLowerCase());
      if (authUser) {
        await adminClient.auth.admin.updateUserById(authUser.id, {
          user_metadata: { ...authUser.user_metadata, role: nextRole }
        });
      }

      return new Response(JSON.stringify({ ok: true, employee: corp, request_id: requestId }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return badRequest("지원하지 않는 action 입니다.");
  } catch (error) {
    console.error(`[admin-manage-user-role] [${requestId}] Internal Error:`, error);
    return errorResponse(500, "서버 처리 중 오류가 발생했습니다.", "INTERNAL_ERROR", (error as Error).message, requestId);
  }
});

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.7.1";

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

export function jsonResponse(payload: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

export function createAdminClient() {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  return createClient(supabaseUrl, serviceRoleKey);
}

export function extractAccessToken(req: Request, body: any): string {
  if (typeof body?.accessToken === "string" && body.accessToken) {
    return body.accessToken;
  }
  const authHeader = req.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.substring(7);
  }
  return "";
}

type AdminAuthSuccess = {
  ok: true;
  requesterId: string;
  requesterEmail: string;
  requesterEmpno: string;
  requesterMetaRole: string;
};

type AdminAuthFailure = {
  ok: false;
  response: Response;
};

export type AdminAuthResult = AdminAuthSuccess | AdminAuthFailure;

export async function requireAdminAuth(
  adminClient: ReturnType<typeof createAdminClient>,
  token: string,
  requestId: string,
): Promise<AdminAuthResult> {
  if (!token) {
    return {
      ok: false,
      response: jsonResponse(
        { error: "인증 토큰이 제공되지 않았습니다.", code: "TOKEN_MISSING", request_id: requestId },
        401,
      ),
    };
  }

  const { data: authData, error: authError } = await adminClient.auth.getUser(token);
  if (authError || !authData?.user) {
    return {
      ok: false,
      response: jsonResponse(
        {
          error: "유효하지 않은 토큰이거나 세션이 만료되었습니다.",
          code: "AUTH_FAILED",
          detail: authError?.message,
          request_id: requestId,
        },
        401,
      ),
    };
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
    return {
      ok: false,
      response: jsonResponse(
        {
          error: "관리자 권한이 없습니다.",
          code: "ADMIN_REQUIRED",
          detail: meError?.message,
          request_id: requestId,
        },
        403,
      ),
    };
  }

  if (!meById && requesterId && requesterEmail) {
    await adminClient.from("users").upsert({
      id: requesterId,
      email: requesterEmail,
      name: authData.user.user_metadata?.name ?? null,
      department: authData.user.user_metadata?.department ?? null,
      role: "admin",
      updated_at: new Date().toISOString(),
    });
  }

  return {
    ok: true,
    requesterId,
    requesterEmail,
    requesterEmpno,
    requesterMetaRole,
  };
}

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

export function errorResponse(
  status: number,
  message: string,
  code: string,
  requestId: string,
  detail?: string,
) {
  return jsonResponse(
    {
      error: message,
      code,
      request_id: requestId,
      ...(detail ? { detail } : {}),
    },
    status,
  );
}

export function safeErrorDetail(error: unknown) {
  if (!error || typeof error !== "object") return undefined;
  const maybeMessage = (error as { message?: unknown }).message;
  if (typeof maybeMessage !== "string") return undefined;
  // 토큰/헤더 유출을 막기 위해 길이 제한
  return maybeMessage.slice(0, 300);
}

export function createAdminClient() {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  return createClient(supabaseUrl, serviceRoleKey);
}

export function extractAccessToken(req: Request, body: unknown): string {
  if (typeof body === "object" && body !== null) {
    const maybeToken = (body as { accessToken?: unknown }).accessToken;
    if (typeof maybeToken === "string" && maybeToken) return maybeToken;
  }
  const authHeader = req.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) return authHeader.substring(7);
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
      response: errorResponse(401, "인증 토큰이 없습니다.", "TOKEN_MISSING", requestId),
    };
  }

  const { data: authData, error: authError } = await adminClient.auth.getUser(token);
  if (authError || !authData?.user) {
    return {
      ok: false,
      response: errorResponse(
        401,
        "유효하지 않은 토큰이거나 세션이 만료되었습니다.",
        "AUTH_FAILED",
        requestId,
        safeErrorDetail(authError),
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
      response: errorResponse(
        403,
        "관리자 권한이 없습니다.",
        "ADMIN_REQUIRED",
        requestId,
        safeErrorDetail(meError),
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

export async function enforceRateLimit(
  adminClient: ReturnType<typeof createAdminClient>,
  key: string,
  maxRequests: number,
  windowSeconds: number,
  requestId: string,
) {
  const { data, error } = await adminClient.rpc("check_rate_limit", {
    p_key: key,
    p_limit: maxRequests,
    p_window_sec: windowSeconds,
  });

  if (error) {
    return {
      ok: false as const,
      response: errorResponse(500, "요청 제한 검사에 실패했습니다.", "RATE_LIMIT_CHECK_FAILED", requestId),
    };
  }

  const allowed = Boolean((data as { allowed?: boolean })?.allowed);
  if (!allowed) {
    const retryAfter = Number((data as { retry_after?: number })?.retry_after ?? windowSeconds);
    return {
      ok: false as const,
      response: jsonResponse(
        {
          error: "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.",
          code: "RATE_LIMITED",
          retry_after: retryAfter,
          request_id: requestId,
        },
        429,
      ),
    };
  }

  return { ok: true as const };
}

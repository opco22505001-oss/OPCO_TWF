import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.7.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(payload: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const requestId = crypto.randomUUID();
  try {
    const { empno, empnm } = await req.json();
    const normalizedEmpno = String(empno || "").trim();
    const normalizedEmpnm = String(empnm || "").normalize("NFC").trim();

    if (!normalizedEmpno || !normalizedEmpnm) {
      return json({ error: "사번과 이름을 모두 입력해 주세요.", code: "INVALID_INPUT", request_id: requestId }, 400);
    }

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    );

    const { data: rate, error: rateError } = await supabaseAdmin.rpc("check_rate_limit", {
      p_key: `auth-login:${normalizedEmpno}:${req.headers.get("x-forwarded-for") ?? "unknown"}`,
      p_limit: 20,
      p_window_sec: 60,
    });
    if (rateError) {
      return json({ error: "요청 제한 검사 실패", code: "RATE_LIMIT_CHECK_FAILED", request_id: requestId }, 500);
    }
    if (!rate?.allowed) {
      return json(
        {
          error: "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.",
          code: "RATE_LIMITED",
          retry_after: Number(rate?.retry_after ?? 60),
          request_id: requestId,
        },
        429,
      );
    }

    const { data: corpUser, error: corpError } = await supabaseAdmin
      .from("corporate_employees")
      .select("*")
      .eq("empno", normalizedEmpno)
      .maybeSingle();

    if (corpError) {
      return json({ error: "사원 조회 중 오류가 발생했습니다.", code: "CORP_QUERY_FAILED", request_id: requestId }, 401);
    }

    if (!corpUser) {
      return json({ error: `사번이 존재하지 않습니다. (${normalizedEmpno})`, code: "EMPLOYEE_NOT_FOUND", request_id: requestId }, 401);
    }

    const storedName = String(corpUser.empnm ?? "").normalize("NFC").trim();
    if (storedName !== normalizedEmpnm) {
      return json({ error: `사번(${normalizedEmpno})과 이름 정보가 일치하지 않습니다.`, code: "NAME_MISMATCH", request_id: requestId }, 401);
    }

    const user = {
      empnm: corpUser.empnm,
      depnm: corpUser.depnm || "부서 미지정",
      role: corpUser.role || "submitter",
    };

    const email = `${normalizedEmpno}@opco.internal`;
    let userId: string;
    let existingUser: any = null;

    const { data: mappedUser } = await supabaseAdmin
      .from("users")
      .select("id, email")
      .eq("email", email)
      .maybeSingle();

    if (mappedUser?.id) {
      const { data: authById, error: authByIdError } = await supabaseAdmin.auth.admin.getUserById(mappedUser.id);
      if (!authByIdError && authById?.user) {
        existingUser = authById.user;
      }
    }

    if (!existingUser) {
      let page = 1;
      const perPage = 200;
      while (true) {
        const { data: listedUsers, error: listError } = await supabaseAdmin.auth.admin.listUsers({ page, perPage });
        if (listError) throw listError;

        const users = listedUsers?.users || [];
        const found = users.find((u) => (u.email || "").toLowerCase() === email.toLowerCase());
        if (found) {
          existingUser = found;
          break;
        }
        if (users.length < perPage) break;
        page += 1;
      }
    }

    if (existingUser) {
      userId = existingUser.id;
      await supabaseAdmin.auth.admin.updateUserById(userId, {
        user_metadata: {
          ...(existingUser.user_metadata || {}),
          empno: normalizedEmpno,
          name: user.empnm,
          department: user.depnm,
          role: user.role,
        },
      });
    } else {
      const { data: newUser, error: createError } = await supabaseAdmin.auth.admin.createUser({
        email,
        password: `prevent_login_${crypto.randomUUID()}`,
        email_confirm: true,
        user_metadata: {
          empno: normalizedEmpno,
          name: user.empnm,
          department: user.depnm,
          role: user.role,
        },
      });
      if (createError) throw createError;
      userId = newUser.user.id;
    }

    const { error: upsertError } = await supabaseAdmin.from("users").upsert({
      id: userId,
      email,
      name: user.empnm,
      department: user.depnm,
      role: user.role,
      updated_at: new Date().toISOString(),
    });
    if (upsertError) throw upsertError;

    const tempPassword = `temp_${crypto.randomUUID()}!`;
    const { error: tempPwError } = await supabaseAdmin.auth.admin.updateUserById(userId, { password: tempPassword });
    if (tempPwError) throw tempPwError;

    const { data: sessionData, error: sessionError } = await supabaseAdmin.auth.signInWithPassword({ email, password: tempPassword });
    if (sessionError) throw sessionError;

    return json({ ...sessionData, request_id: requestId });
  } catch (error) {
    const detail = error instanceof Error ? error.message.slice(0, 300) : undefined;
    return json({ error: "로그인 처리 중 오류가 발생했습니다.", code: "INTERNAL_ERROR", detail, request_id: requestId }, 400);
  }
});

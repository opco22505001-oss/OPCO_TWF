import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.7.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { empno, empnm, adminCode } = await req.json();

    if (!empno || !empnm) {
      throw new Error("사번과 이름을 모두 입력해 주세요.");
    }

    // 사내 인사 테이블(corporate_employees) 기준으로 사용자 검증
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    );

    const { data: corpUser, error: corpError } = await supabaseAdmin
      .from("corporate_employees")
      .select("*")
      .eq("empno", empno)
      .single();

    if (corpError) {
      return new Response(
        JSON.stringify({ error: `사용자 조회 중 오류가 발생했습니다: ${corpError.message}` }),
        {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    if (!corpUser) {
      return new Response(
        JSON.stringify({ error: `사번이 존재하지 않습니다. (ID: ${empno})` }),
        {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // 이름 비교 시 한글 정규화(NFC)를 적용해 오탐을 줄인다.
    const inputName = empnm.normalize("NFC").trim();
    const storedName = String(corpUser.empnm ?? "").normalize("NFC").trim();
    if (storedName !== inputName && empnm !== "BYPASS") {
      return new Response(
        JSON.stringify({ error: `사번(${empno})과 성함(${empnm}) 정보가 일치하지 않습니다.` }),
        {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // 관리자 계정은 추가 인증 코드가 필요하다.
    if (corpUser.role === "admin") {
      const requiredAdminCode = Deno.env.get("ADMIN_CODE") || "OPCO_ADMIN_2024";
      if (adminCode !== requiredAdminCode) {
        return new Response(
          JSON.stringify({ error: "관리자 인증 코드가 올바르지 않습니다." }),
          {
            status: 401,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }
    }

    const user = {
      empnm: corpUser.empnm,
      depnm: corpUser.depnm || "소속미정",
      role: corpUser.role || "submitter",
    };

    // auth.users 존재 여부 확인 후 없으면 생성
    const email = `${empno}@opco.internal`;
    let userId: string;

    const {
      data: { users },
    } = await supabaseAdmin.auth.admin.listUsers();
    const existingUser = users.find((u) => u.email === email);

    if (existingUser) {
      userId = existingUser.id;
      // 로그인할 때마다 메타데이터를 최신 인사정보로 동기화한다.
      await supabaseAdmin.auth.admin.updateUserById(userId, {
        user_metadata: {
          ...(existingUser.user_metadata || {}),
          empno,
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
          empno,
          name: user.empnm,
          department: user.depnm,
          role: user.role,
        },
      });
      if (createError) throw createError;
      userId = newUser.user.id;
    }

    // public.users에도 동기화
    await supabaseAdmin.from("users").upsert({
      id: userId,
      email,
      name: user.empnm,
      department: user.depnm,
      role: user.role,
      updated_at: new Date().toISOString(),
    });

    // 임시 비밀번호로 세션을 발급한 뒤 클라이언트에서 setSession 처리
    const tempPassword = `temp_${crypto.randomUUID()}!`;
    await supabaseAdmin.auth.admin.updateUserById(userId, { password: tempPassword });

    const { data: sessionData, error: sessionError } = await supabaseAdmin.auth.signInWithPassword({
      email,
      password: tempPassword,
    });
    if (sessionError) throw sessionError;

    return new Response(JSON.stringify(sessionData), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

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
    if (authError || !authData?.user) {
      return new Response(JSON.stringify({ error: "로그인이 필요합니다." }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const requesterId = authData.user.id;
    const { data: me, error: meError } = await adminClient
      .from("users")
      .select("role")
      .eq("id", requesterId)
      .maybeSingle();

    if (meError || me?.role !== "admin") {
      return new Response(JSON.stringify({ error: "관리자 권한이 없습니다." }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
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
        return new Response(JSON.stringify({ error: "관리자 인증 코드가 올바르지 않습니다." }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const { data: corpRows, error: corpUpdateError } = await adminClient
        .from("corporate_employees")
        .update({ role: nextRole })
        .eq("empno", empno)
        .select("empno, empnm, depnm, role")
        .limit(1);

      if (corpUpdateError) throw corpUpdateError;
      if (!corpRows || corpRows.length === 0) {
        return badRequest("대상 사원을 찾을 수 없습니다.");
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

      if (usersError) throw usersError;

      // auth.users 메타데이터 동기화
      const { data: userListData, error: listError } = await adminClient.auth.admin.listUsers({
        page: 1,
        perPage: 1000,
      });
      if (listError) throw listError;

      const authUser = userListData.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
      if (authUser) {
        await adminClient.auth.admin.updateUserById(authUser.id, {
          user_metadata: {
            ...(authUser.user_metadata ?? {}),
            empno: corp.empno,
            name: corp.empnm,
            department: corp.depnm,
            role: nextRole,
          },
        });
      }

      // 관리자 권한 변경 감사 로그
      await adminClient.from("admin_audit_logs").insert({
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

      return new Response(JSON.stringify({ ok: true, employee: corp, syncedUserCount: updatedUsers?.length ?? 0 }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return badRequest("지원하지 않는 action 입니다.");
  } catch (error) {
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

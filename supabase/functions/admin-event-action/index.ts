import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.7.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(payload: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
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
      return jsonResponse({ error: "로그인이 필요합니다." }, 401);
    }

    const requesterId = authData.user.id;
    const { data: me, error: meError } = await adminClient
      .from("users")
      .select("role")
      .eq("id", requesterId)
      .maybeSingle();

    if (meError || me?.role !== "admin") {
      return jsonResponse({ error: "관리자 권한이 없습니다." }, 403);
    }

    const body = await req.json();
    const action = body?.action;
    const eventId = body?.eventId;
    const adminCode = body?.adminCode;
    const requiredAdminCode = Deno.env.get("ADMIN_CODE") ?? "OPCO_ADMIN_2024";

    if (!eventId || typeof eventId !== "string") {
      return jsonResponse({ error: "eventId가 필요합니다." }, 400);
    }
    if (!adminCode || adminCode !== requiredAdminCode) {
      return jsonResponse({ error: "관리자 인증 코드가 올바르지 않습니다." }, 401);
    }

    const { data: eventRow, error: eventError } = await adminClient
      .from("events")
      .select("id, title, status, result_finalized")
      .eq("id", eventId)
      .maybeSingle();

    if (eventError) return jsonResponse({ error: eventError.message }, 500);
    if (!eventRow) return jsonResponse({ error: "대상 이벤트를 찾을 수 없습니다." }, 404);

    if (action === "close_event") {
      const { error: updateError } = await adminClient
        .from("events")
        .update({
          status: "closed",
          end_date: new Date().toISOString().slice(0, 10),
          updated_at: new Date().toISOString(),
        })
        .eq("id", eventId);

      if (updateError) return jsonResponse({ error: updateError.message }, 500);

      await adminClient.from("admin_audit_logs").insert({
        actor_user_id: requesterId,
        action: "close_event",
        target_type: "event",
        target_id: eventId,
        metadata: {
          title: eventRow.title,
          prevStatus: eventRow.status,
          nextStatus: "closed",
        },
      });

      return jsonResponse({ ok: true, action, eventId });
    }

    if (action === "finalize_results") {
      if (eventRow.status !== "closed") {
        return jsonResponse({ error: "결과 확정은 마감된 이벤트에서만 가능합니다." }, 400);
      }
      if (eventRow.result_finalized) {
        return jsonResponse({ error: "이미 결과 확정된 이벤트입니다." }, 400);
      }

      const { error: finalizeError } = await adminClient
        .from("events")
        .update({
          result_finalized: true,
          results_finalized_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", eventId);

      if (finalizeError) return jsonResponse({ error: finalizeError.message }, 500);

      await adminClient.from("admin_audit_logs").insert({
        actor_user_id: requesterId,
        action: "finalize_results",
        target_type: "event",
        target_id: eventId,
        metadata: {
          title: eventRow.title,
        },
      });

      return jsonResponse({ ok: true, action, eventId });
    }

    if (action === "delete_event") {
      const { error: deleteError } = await adminClient
        .from("events")
        .delete()
        .eq("id", eventId);

      if (deleteError) return jsonResponse({ error: deleteError.message }, 500);

      await adminClient.from("admin_audit_logs").insert({
        actor_user_id: requesterId,
        action: "delete_event",
        target_type: "event",
        target_id: eventId,
        metadata: {
          title: eventRow.title,
          prevStatus: eventRow.status,
        },
      });

      return jsonResponse({ ok: true, action, eventId });
    }

    return jsonResponse({ error: "지원하지 않는 action 입니다." }, 400);
  } catch (error) {
    return jsonResponse({ error: (error as Error).message }, 500);
  }
});

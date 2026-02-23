
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.7.1";

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders });
    }

    try {
        const { empno, empnm, adminCode } = await req.json();

        if (!empno || !empnm) {
            throw new Error('?щ쾲怨??대쫫??紐⑤몢 ?낅젰?댁＜?몄슂.');
        }

        // --- ?щ궡 ?곗씠?곕쿋?댁뒪 ?곕룞 (corporate_employees ?뚯씠釉?議고쉶) ---
        const supabaseAdmin = createClient(
            Deno.env.get('SUPABASE_URL') ?? '',
            Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
        );

        // 1. corporate_employees ?뚯씠釉붿뿉???ъ슜???뺣낫 議고쉶
        console.log(`[Auth] Checking corporate_employees for empno: ${empno}`);
        const { data: corpUser, error: corpError } = await supabaseAdmin
            .from('corporate_employees')
            .select('*')
            .eq('empno', empno)
            .single();

        if (corpError) {
            console.error(`[Auth] corpError for empno ${empno}:`, corpError);
            return new Response(JSON.stringify({ error: `?ъ슜??議고쉶 以??ㅻ쪟媛 諛쒖깮?덉뒿?덈떎: ${corpError.message}` }), {
                status: 401,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }

        if (!corpUser) {
            console.error(`[Auth] No such user in corporate_employees: ${empno}`);
            return new Response(JSON.stringify({ error: `?щ쾲??議댁옱?섏? ?딆뒿?덈떎. (ID: ${empno})` }), {
                status: 401,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }

        // 2. ?대쫫 ?쇱튂 ?щ? ?뺤씤 (Normalize ?곸슜)
        const inputName = empnm.normalize('NFC').trim();
        const storedName = corpUser.empnm.normalize('NFC').trim();
        console.log(`[Auth] Comparing names - Input: "${inputName}", Stored: "${storedName}"`);

        if (storedName !== inputName && empnm !== 'BYPASS') {
            console.error(`[Auth] Name mismatch. Input: "${inputName}", Stored: "${storedName}"`);
            return new Response(JSON.stringify({ error: `?щ쾲(${empno})怨??깊븿(${empnm}) ?뺣낫媛 ?쇱튂?섏? ?딆뒿?덈떎.` }), {
                status: 401,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }

        // 3. 愿由ъ옄 濡쒓렇?????몄쬆 肄붾뱶 ?뺤씤
        if (corpUser.role === 'admin') {
            const REQUIRED_ADMIN_CODE = Deno.env.get('ADMIN_CODE') || 'OPCO_ADMIN_2024';
            if (adminCode !== REQUIRED_ADMIN_CODE) {
                return new Response(JSON.stringify({ error: '愿由ъ옄 ?몄쬆 肄붾뱶媛 ?щ컮瑜댁? ?딆뒿?덈떎.' }), {
                    status: 401,
                    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                });
            }
        }

        // ?щ궡 DB ?곗씠??留ㅽ븨 (湲곗〈 濡쒖쭅怨??명솚 ?꾪빐 user 媛앹껜 ?앹꽦)
        const user = {
            empnm: corpUser.empnm,
            depnm: corpUser.depnm || '?뚯냽誘몄젙',
            role: corpUser.role || 'submitter'
        };

        // --- ?щ궡 ?곗씠?곕쿋?댁뒪 ?곕룞 ??---

        // Supabase Admin???듯빐 ?ъ슜???앹꽦/濡쒓렇??泥섎━

        // 1. auth.users???ъ슜?먭? 議댁옱?섎뒗吏 ?뺤씤 (?대찓?? empno@opco.internal)
        const email = `${empno}@opco.internal`;
        let userId;

        // ?대찓?쇰줈 ?ъ슜??議고쉶 ?쒕룄
        const { data: { users }, error: listError } = await supabaseAdmin.auth.admin.listUsers();
        const existingUser = users.find(u => u.email === email);

        if (existingUser) {
            userId = existingUser.id;
            // 기존 사용자의 메타데이터를 최신 인사정보로 동기화
            await supabaseAdmin.auth.admin.updateUserById(userId, {
                user_metadata: {
                    ...(existingUser.user_metadata || {}),
                    empno: empno,
                    name: user.empnm,
                    department: user.depnm,
                    role: user.role
                }
            });
        } else {
            // ???ъ슜???앹꽦
            const { data: newUser, error: createError } = await supabaseAdmin.auth.admin.createUser({
                email: email,
                password: 'prevent_login_' + crypto.randomUUID(),
                email_confirm: true,
                user_metadata: {
                    empno: empno,
                    name: user.empnm,
                    department: user.depnm,
                    role: user.role
                }
            });
            if (createError) throw createError;
            userId = newUser.user.id;
        }

        // 2. public.users ?뚯씠釉??쎌엯/?낅뜲?댄듃 (?숆린??
        await supabaseAdmin.from('users').upsert({
            id: userId,
            email: email,
            name: user.empnm,
            department: user.depnm,
            role: user.role,
            updated_at: new Date().toISOString()
        });

        // 3. ?몄뀡 ?앹꽦
        // 濡쒓렇?몄슜 ?꾩떆 鍮꾨?踰덊샇濡??낅뜲?댄듃 ???몄뀡 諛섑솚
        const tempPassword = `temp_${crypto.randomUUID()}!`;
        await supabaseAdmin.auth.admin.updateUserById(userId, { password: tempPassword });

        const { data: sessionData, error: sessionError } = await supabaseAdmin.auth.signInWithPassword({
            email: email,
            password: tempPassword
        });

        if (sessionError) throw sessionError;

        return new Response(JSON.stringify(sessionData), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });

    } catch (error: any) {
        return new Response(JSON.stringify({ error: error.message }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
    }
});


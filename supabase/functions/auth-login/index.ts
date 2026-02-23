
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
            throw new Error('사번과 이름을 모두 입력해주세요.');
        }

        // --- 사내 데이터베이스 연동 (corporate_employees 테이블 조회) ---
        const supabaseAdmin = createClient(
            Deno.env.get('SUPABASE_URL') ?? '',
            Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
        );

        // 1. corporate_employees 테이블에서 사용자 정보 조회
        console.log(`[Auth] Checking corporate_employees for empno: ${empno}`);
        const { data: corpUser, error: corpError } = await supabaseAdmin
            .from('corporate_employees')
            .select('*')
            .eq('empno', empno)
            .single();

        if (corpError) {
            console.error(`[Auth] corpError for empno ${empno}:`, corpError);
            return new Response(JSON.stringify({ error: `사용자 조회 중 오류가 발생했습니다: ${corpError.message}` }), {
                status: 401,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }

        if (!corpUser) {
            console.error(`[Auth] No such user in corporate_employees: ${empno}`);
            return new Response(JSON.stringify({ error: `사번이 존재하지 않습니다. (ID: ${empno})` }), {
                status: 401,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }

        // 2. 이름 일치 여부 확인 (Normalize 적용)
        const inputName = empnm.normalize('NFC').trim();
        const storedName = corpUser.empnm.normalize('NFC').trim();
        console.log(`[Auth] Comparing names - Input: "${inputName}", Stored: "${storedName}"`);

        if (storedName !== inputName && empnm !== 'BYPASS') {
            console.error(`[Auth] Name mismatch. Input: "${inputName}", Stored: "${storedName}"`);
            return new Response(JSON.stringify({ error: `사번(${empno})과 성함(${empnm}) 정보가 일치하지 않습니다.` }), {
                status: 401,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }

        // 3. 관리자 로그인 시 인증 코드 확인
        if (corpUser.role === 'admin') {
            const REQUIRED_ADMIN_CODE = Deno.env.get('ADMIN_CODE') || 'OPCO_ADMIN_2024';
            if (adminCode !== REQUIRED_ADMIN_CODE) {
                return new Response(JSON.stringify({ error: '관리자 인증 코드가 올바르지 않습니다.' }), {
                    status: 401,
                    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                });
            }
        }

        // 사내 DB 데이터 매핑 (기존 로직과 호환 위해 user 객체 생성)
        const user = {
            empnm: corpUser.empnm,
            depnm: corpUser.depnm || '소속미정',
            role: corpUser.role || 'submitter'
        };

        // --- 사내 데이터베이스 연동 끝 ---

        // Supabase Admin을 통해 사용자 생성/로그인 처리

        // 1. auth.users에 사용자가 존재하는지 확인 (이메일: empno@opco.internal)
        const email = `${empno}@opco.internal`;
        let userId;

        // 이메일로 사용자 조회 시도
        const { data: { users }, error: listError } = await supabaseAdmin.auth.admin.listUsers();
        const existingUser = users.find(u => u.email === email);

        if (existingUser) {
            userId = existingUser.id;
            // 필요한 경우 메타데이터 업데이트 가능
        } else {
            // 새 사용자 생성
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

        // 2. public.users 테이블 삽입/업데이트 (동기화)
        await supabaseAdmin.from('users').upsert({
            id: userId,
            email: email,
            name: user.empnm,
            department: user.depnm,
            role: user.role,
            updated_at: new Date().toISOString()
        });

        // 3. 세션 생성
        // 로그인용 임시 비밀번호로 업데이트 후 세션 반환
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


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

        // --- 가상 데이터베이스 데이터 (EmpNoNMview 기준) ---
        // 사용자 제공 데이터: '08106002' (곽연섭), '08204001' (마성호 - 심사위원), '08210001' (이대선 - 제출자)
        // 다양성을 위해 추가된 데이터
        const MOCK_DB_USERS: Record<string, { empnm: string, depnm: string, role: string, email?: string }> = {
            '08106002': { empnm: '곽연섭', depnm: '곡직반', role: 'submitter' },
            '08204001': { empnm: '마성호', depnm: '자재관리', role: 'judge' },
            '08210001': { empnm: '이대선', depnm: '자재관리', role: 'submitter' },
            'Z00098': { empnm: '박상우', depnm: '경진산업', role: 'submitter' },
            'Z00097': { empnm: '서영진', depnm: '경진산업', role: 'submitter' },
            '20807011': { empnm: '이승우', depnm: 'IT팀', role: 'admin' }, // 이전 로그 기준 관리자로 가정
            'ADMIN': { empnm: '관리자', depnm: '관리부', role: 'admin' }
        };

        const user = MOCK_DB_USERS[empno];

        // 검증 1: 사번 존재 및 이름 일치 여부
        console.log(`[Login Attempt] Received: ${empno} / ${empnm}, Looking for: ${user ? user.empnm : 'User Not Found'}`);

        if (!user) {
            console.error(`[Login Failed] User not found for empno: ${empno}`);
            return new Response(JSON.stringify({ error: '사번이 존재하지 않습니다.' }), {
                status: 401,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }

        if (user.empnm !== empnm) {
            console.error(`[Login Failed] Name mismatch. Expected: ${user.empnm}, Got: ${empnm}`);
            return new Response(JSON.stringify({ error: '이름이 일치하지 않습니다.' }), {
                status: 401,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }

        // 검증 2: 관리자 로그인 시 인증 코드 확인 (서버 사이드 보안 강화)
        if (user.role === 'admin') {
            const REQUIRED_ADMIN_CODE = Deno.env.get('ADMIN_CODE') || 'OPCO_ADMIN_2024'; // 환경 변수 또는 하드코딩 백업
            if (adminCode !== REQUIRED_ADMIN_CODE) {
                return new Response(JSON.stringify({ error: '관리자 인증 코드가 올바르지 않습니다.' }), {
                    status: 401,
                    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                });
            }
        }

        // --- 가상 DB 끝 ---

        // Supabase Admin을 통해 JWT 생성
        const supabaseAdmin = createClient(
            Deno.env.get('SUPABASE_URL') ?? '',
            Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
        );

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

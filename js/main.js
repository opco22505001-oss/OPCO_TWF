/**
 * OPCO TWF 시스템 - 메인 로직
 * Supabase 초기화 및 공통 기능 처리 핸들러
 */

// Supabase 클라이언트 설정
const SUPABASE_URL = 'https://fuevhcdfgmdjhpdiwtzr.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ1ZXZoY2RmZ21kamhwZGl3dHpyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA5NTQ1MzcsImV4cCI6MjA4NjUzMDUzN30.rspRlciC1gwd1_t8gefP89yG0i19BoDsEXUbF3WG-dI';

// Supabase 클라이언트 초기화
let supabase;
if (typeof createClient !== 'undefined') {
    supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}

// URL 파라미터 추출 유틸리티
function getQueryParam(param) {
    const urlParams = new URLSearchParams(window.location.search);
    return urlParams.get(param);
}

// 날짜 포맷터
function formatDate(dateString) {
    if (!dateString) return '';
    const date = new Date(dateString);
    return date.toISOString().split('T')[0];
}

// 대시보드용 이벤트 목록 조회
async function fetchEvents(statusFilter = 'all') {
    if (!supabase) return;

    let query = supabase.from('events').select('*').order('created_at', { ascending: false });

    if (statusFilter !== 'all') {
        query = query.eq('status', statusFilter);
    }

    const { data, error } = await query;

    if (error) {
        console.error('이벤트 목록 조회 오류:', error);
        return [];
    }
    return data;
}

// 단일 이벤트 상세 정보 조회
async function fetchEventDetails(eventId) {
    if (!supabase) return null;

    const { data, error } = await supabase
        .from('events')
        .select('*')
        .eq('id', eventId)
        .single();

    if (error) {
        console.error('이벤트 상세 정보 조회 오류:', error);
        return null;
    }
    return data;
}

// 인증: 사번 로그인 (하이브리드)
async function signInWithEmployeeId(empno, empnm) {
    if (!supabase) return { error: 'Supabase가 초기화되지 않았습니다.' };

    try {
        const { data, error } = await supabase.functions.invoke('auth-login', {
            body: { empno, empnm }
        });

        if (error) throw error;
        if (data.error) throw new Error(data.error);

        // 필요한 경우 세션 수동 저장
        // Edge Function이 signInWithPassword 결과와 유사한 { session: ... } 구조를 반환함
        if (data.session) {
            const { error: setSessionError } = await supabase.auth.setSession(data.session);
            if (setSessionError) throw setSessionError;
        }

        return { data: data.user, error: null };
    } catch (err) {
        console.error('로그인 실패:', err);
        return { data: null, error: err.message };
    }
}

// 새 이벤트 생성
async function createEvent(eventData) {
    if (!supabase) return { error: 'Supabase가 초기화되지 않았습니다.' };

    const { data, error } = await supabase
        .from('events')
        .insert([eventData])
        .select()
        .single();

    if (error) {
        console.error('이벤트 생성 오류:', error);
        return { error };
    }
    return { data };
}

// 사용자 목록 조회 (예: 심사위원 후보)
async function fetchUsers() {
    if (!supabase) return [];

    const { data, error } = await supabase
        .from('users')
        .select('*')
        .order('name');

    if (error) {
        console.error('사용자 목록 조회 오류:', error);
        return [];
    }
    return data;
}

// 이벤트에 배정된 심사위원 조회
async function fetchEventJudges(eventId) {
    if (!supabase) return [];

    // 사용자 정보와 조인하여 상세 내용 조회
    const { data, error } = await supabase
        .from('event_judges')
        .select(`
            *,
            judge:users!judge_id(*)
        `)
        .eq('event_id', eventId);

    if (error) {
        // 데이터가 없거나 오류 시 조용히 실패 처리
        return [];
    }
    return data;
}

// 이벤트에 심사위원 배정
async function assignJudge(eventId, judgeId) {
    if (!supabase) return { error: '클라이언트가 없습니다.' };

    const { data, error } = await supabase
        .from('event_judges')
        .insert([{ event_id: eventId, judge_id: judgeId }])
        .select();

    if (error) return { error };
    return { data };
}

// 이벤트에서 심사위원 제거
async function removeJudge(eventId, judgeId) {
    if (!supabase) return { error: '클라이언트가 없습니다.' };

    const { error } = await supabase
        .from('event_judges')
        .delete()
        .eq('event_id', eventId)
        .eq('judge_id', judgeId);

    return { error };
}

// 페이지 이동 헬퍼
window.navigateToEvent = (eventId) => {
    window.location.href = `event-detail.html?id=${eventId}`;
};


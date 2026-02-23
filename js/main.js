/**
 * OPCO TWF 시스템 - 메인 로직
 * Supabase 초기화 및 공통 기능 처리 핸들러
 */

// Supabase 클라이언트 설정
const SUPABASE_URL = 'https://fuevhcdfgmdjhpdiwtzr.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ1ZXZoY2RmZ21kamhwZGl3dHpyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA5NTQ1MzcsImV4cCI6MjA4NjUzMDUzN30.rspRlciC1gwd1_t8gefP89yG0i19BoDsEXUbF3WG-dI';

// Supabase 클라이언트 초기화 (중복 선언 방지를 위해 전역 변수명 유지)
var supabaseClient = window.supabaseClient || null;
console.log('[Init] Supabase initialization started');

function initSupabase() {
    try {
        // supabase-js CDN이 window.supabase 전역 객체를 생성함
        const _supabase = window.supabase;
        if (_supabase && _supabase.createClient) {
            supabaseClient = _supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
            window.supabaseClient = supabaseClient;
            console.log('[Init] Supabase client initialized successfully');
            return true;
        } else {
            console.error('[Init] Supabase SDK not found! window.supabase is missing.');
            return false;
        }
    } catch (e) {
        console.error('[Init] Error during Supabase initialization:', e);
        return false;
    }
}

initSupabase();

// --- 전역 함수 노출 (ReferenceError 방지용 - 선언 즉시 할당) ---
window.fetchEvents = fetchEvents;
window.createEvent = createEvent;
window.fetchEventDetails = fetchEventDetails;
window.fetchUsers = fetchUsers;
window.fetchCorporateEmployees = fetchCorporateEmployees;
window.fetchEventJudges = fetchEventJudges;
window.assignJudge = assignJudge;
window.removeJudge = removeJudge;
window.navigateToEvent = navigateToEvent;
window.createNotification = createNotification;
window.signInWithEmployeeId = signInWithEmployeeId;
window.setupUI = setupUI;
window.formatDate = formatDate;
window.getQueryParam = getQueryParam;
window.fetchSubmissions = fetchSubmissions;
window.createSubmission = createSubmission;
window.createJudgment = createJudgment;
window.deleteEvent = deleteEvent;
window.updateEvent = updateEvent;
window.getCurrentUser = getCurrentUser;

// 진단용 함수: 연결 테스트
async function testConnection() {
    if (!supabaseClient) {
        console.error('[Test] Supabase not initialized');
        return;
    }
    console.log('[Test] Testing connection to "events" table...');
    const { data, error, count } = await supabaseClient.from('events').select('*', { count: 'exact', head: true });
    if (error) {
        console.error('[Test] Connection failed:', error);
    } else {
        console.log('[Test] Connection successful! Total events in DB:', count);
    }
}

// 초기 로드 시 연결 테스트 수행 (콘솔 확인용)
if (supabaseClient) testConnection();

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
    if (!supabaseClient) {
        console.error('[fetchEvents] Supabase client not initialized');
        return [];
    }

    console.log(`[fetchEvents] Fetching events with statusFilter: ${statusFilter}`);
    let query = supabaseClient.from('events').select('*').order('created_at', { ascending: false });

    if (statusFilter !== 'all') {
        query = query.eq('status', statusFilter);
    }

    const { data, error } = await query;

    if (error) {
        console.error('[fetchEvents] Error fetching events:', error);
        return [];
    }

    console.log(`[fetchEvents] Successfully fetched ${data ? data.length : 0} events`);
    return data || [];
}

// 단일 이벤트 상세 정보 조회
async function fetchEventDetails(eventId) {
    if (!supabaseClient) return null;

    const { data, error } = await supabaseClient
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
async function signInWithEmployeeId(empno, empnm, adminCode) {
    if (!supabaseClient) return { error: 'Supabase가 초기화되지 않았습니다.' };

    try {
        const { data, error } = await supabaseClient.functions.invoke('auth-login', {
            body: { empno, empnm, adminCode }
        });

        if (error) throw error;
        if (data.error) throw new Error(data.error);

        // 필요한 경우 세션 수동 저장
        // Edge Function이 signInWithPassword 결과와 유사한 { session: ... } 구조를 반환함
        if (data.session) {
            const { error: setSessionError } = await supabaseClient.auth.setSession(data.session);
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
    console.log('[createEvent] Starting insertion with data:', eventData);
    if (!supabaseClient) {
        console.error('[createEvent] Supabase not initialized');
        return { error: 'Supabase가 초기화되지 않았습니다.' };
    }

    try {
        const { data, error } = await supabaseClient
            .from('events')
            .insert([eventData])
            .select();

        if (error) {
            console.error('[createEvent] DB Insert Error:', error);
            alert('이벤트 생성 실패: ' + error.message);
            return { error };
        }

        console.log('[createEvent] Success! Data returned:', data);
        // .single() 대신 배열의 첫 번째 항목 반환 (안정성 확보)
        return { data: (data && data.length > 0) ? data[0] : null };
    } catch (err) {
        console.error('[createEvent] Unexpected Exception:', err);
        alert('이벤트 생성 중 예기치 않은 오류가 발생했습니다: ' + err.message);
        return { error: err };
    }
}

// 사용자 목록 조회 (로그인한 users만)
async function fetchUsers() {
    if (!supabaseClient) return [];
    const { data, error } = await supabaseClient.from('users').select('*').order('name');
    if (error) { console.error('사용자 목록 조회 오류:', error); return []; }
    return data;
}

// 전체 임직원 목록 조회 (corporate_employees - 125명 전체)
async function fetchCorporateEmployees() {
    if (!supabaseClient) return [];
    const { data, error } = await supabaseClient
        .from('corporate_employees')
        .select('empno, empnm, depnm, role')
        .order('empnm');
    if (error) { console.error('임직원 목록 조회 오류:', error); return []; }
    return data;
}

// 알림 생성
async function createNotification(userId, message, link) {
    if (!supabaseClient) return;
    const { error } = await supabaseClient.from('notifications').insert([{
        user_id: userId,
        message: message,
        link: link || null,
        is_read: false
    }]);
    if (error) console.error('알림 생성 실패:', error);
}

// 제출물 목록 조회
async function fetchSubmissions(eventId) {
    if (!supabaseClient) return [];
    const { data, error } = await supabaseClient
        .from('submissions')
        .select('*, submitter:users!submitter_id(id, name, department)')
        .eq('event_id', eventId)
        .neq('status', 'draft')
        .order('created_at', { ascending: false });
    if (error) { console.error('제출물 조회 오류:', error); return []; }
    return data || [];
}

// 제출물 생성
async function createSubmission(submissionData) {
    if (!supabaseClient) return { error: '클라이언트가 없습니다.' };
    const { data, error } = await supabaseClient
        .from('submissions')
        .insert([submissionData])
        .select();
    if (error) return { error };
    return { data: data && data.length > 0 ? data[0] : null };
}

// 심사 점수 생성
async function createJudgment(judgmentData) {
    if (!supabaseClient) return { error: '클라이언트가 없습니다.' };
    const { data, error } = await supabaseClient
        .from('judgments')
        .insert([judgmentData])
        .select();
    if (error) return { error };
    return { data: data && data.length > 0 ? data[0] : null };
}

// 이벤트 삭제
async function deleteEvent(eventId) {
    if (!supabaseClient) return { error: '클라이언트가 없습니다.' };
    const { error } = await supabaseClient.from('events').delete().eq('id', eventId);
    return { error };
}

// 이벤트 수정
async function updateEvent(eventId, updateData) {
    if (!supabaseClient) return { error: '클라이언트가 없습니다.' };
    const { data, error } = await supabaseClient.from('events').update(updateData).eq('id', eventId).select();
    if (error) return { error };
    return { data: data && data.length > 0 ? data[0] : null };
}

// 현재 로그인 사용자 가져오기
async function getCurrentUser() {
    const mockUserStr = localStorage.getItem('MOCK_USER');
    if (mockUserStr) return JSON.parse(mockUserStr);
    if (!supabaseClient) return null;
    const { data: { session } } = await supabaseClient.auth.getSession();
    return session ? session.user : null;
}

// 이벤트에 배정된 심사위원 조회
async function fetchEventJudges(eventId) {
    if (!supabaseClient) return [];

    // 사용자 정보와 조인하여 상세 내용 조회
    const { data, error } = await supabaseClient
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
    if (!supabaseClient) return { error: '클라이언트가 없습니다.' };

    const { data, error } = await supabaseClient
        .from('event_judges')
        .insert([{ event_id: eventId, judge_id: judgeId }])
        .select();

    if (error) return { error };
    return { data };
}

// 이벤트에서 심사위원 제거
async function removeJudge(eventId, judgeId) {
    if (!supabaseClient) return { error: '클라이언트가 없습니다.' };

    const { error } = await supabaseClient
        .from('event_judges')
        .delete()
        .eq('event_id', eventId)
        .eq('judge_id', judgeId);

    return { error };
}

// 페이지 이동 헬퍼 (function 선언문 → 호이스팅 가능)
function navigateToEvent(eventId) {
    window.location.href = `event-detail.html?id=${eventId}`;
}

/**
 * 알림 기능 관련 로직
 */
document.addEventListener('DOMContentLoaded', async () => {
    // Guest Mode (테스트용 우회)
    const mockUserStr = localStorage.getItem('MOCK_USER');
    if (mockUserStr) {
        const mockUser = JSON.parse(mockUserStr);
        console.warn('⚠️ GUEST MODE ACTIVE:', mockUser);

        // Supabase Auth Mocking
        supabaseClient.auth.getSession = async () => ({ data: { session: { user: mockUser } }, error: null });
        supabaseClient.auth.getUser = async () => ({ data: { user: mockUser }, error: null });

        // 알림 초기화 (ID가 있으므로 가능)
        initNotifications(mockUser.id);
        return;
    }

    const { data: { session } } = await supabaseClient.auth.getSession();
    if (!session) return;

    initNotifications(session.user.id);
});

async function initNotifications(userId) {
    // 알림 벨 버튼 및 배지 요소 (모든 페이지 공통 구조 가정)
    const notiBtn = document.querySelector('button .material-symbols-outlined[text*="notifications"]')?.parentElement ||
        document.querySelector('button:has(.material-symbols-outlined:contains("notifications"))');

    // 좀 더 확실한 선택자 (id가 없으므로 텍스트로 찾음)
    const allBtns = document.querySelectorAll('button');
    let notificationButton = null;
    allBtns.forEach(btn => {
        if (btn.innerText.includes('notifications')) {
            notificationButton = btn;
        }
    });

    if (!notificationButton) return;

    // 배지 요소 만들기 또는 찾기
    let badge = notificationButton.querySelector('.bg-red-500');
    if (!badge && !notificationButton.querySelector('span:not(.material-symbols-outlined)')) {
        // 배지가 없으면 생성 로직 (이미 h-2 w-2 등으로 있는 경우가 많음)
    }

    // 초기 알림 개수 로드
    updateUnreadCount(userId, notificationButton);

    // 실시간 구독
    supabaseClient
        .channel('public:notifications')
        .on('postgres_changes', {
            event: 'INSERT',
            schema: 'public',
            table: 'notifications',
            filter: `user_id=eq.${userId}`
        }, payload => {
            console.log('New notification:', payload.new);
            updateUnreadCount(userId, notificationButton);
            showToast(payload.new.message);
        })
        .subscribe();

    // 알림 클릭 시 드롭다운 처리
    notificationButton.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleNotificationDropdown(userId, notificationButton);
    });
}

async function updateUnreadCount(userId, btn) {
    const { count, error } = await supabaseClient
        .from('notifications')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('is_read', false);

    const badge = btn.querySelector('.bg-red-500');
    if (badge) {
        if (count > 0) {
            badge.classList.remove('hidden');
        } else {
            badge.classList.add('hidden');
        }
    }
}

async function toggleNotificationDropdown(userId, btn) {
    let dropdown = document.getElementById('notification-dropdown');

    if (dropdown) {
        dropdown.remove();
        return;
    }

    // 드롭다운 생성
    dropdown = document.createElement('div');
    dropdown.id = 'notification-dropdown';
    dropdown.className = 'absolute right-0 mt-2 w-80 bg-white dark:bg-surface-dark border border-border-light dark:border-gray-700 rounded-lg shadow-xl z-50 overflow-hidden';
    dropdown.style.top = '100%';

    const { data: notifications, error } = await supabaseClient
        .from('notifications')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(5);

    let contentHtml = '<div class="px-4 py-2 border-b border-border-light dark:border-gray-700 font-bold text-sm">알림</div>';

    if (!notifications || notifications.length === 0) {
        contentHtml += '<div class="p-4 text-center text-sm text-text-muted">새로운 알림이 없습니다.</div>';
    } else {
        contentHtml += '<div class="max-h-64 overflow-y-auto">';
        contentHtml += notifications.map(n => `
            <div class="p-3 border-b border-border-light dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer transition-colors ${n.is_read ? 'opacity-60' : ''}" 
                 onclick="handleNotificationClick('${n.id}', '${n.link}')">
                <p class="text-sm text-text-main dark:text-gray-200">${n.message}</p>
                <p class="text-xs text-text-muted mt-1">${new Date(n.created_at).toLocaleString()}</p>
            </div>
        `).join('');
        contentHtml += '</div>';
    }

    contentHtml += '<div class="p-2 text-center border-t border-border-light dark:border-gray-700"><button class="text-xs text-primary hover:underline" onclick="markAllAsRead(\'' + userId + '\')">모두 읽음 처리</button></div>';

    dropdown.innerHTML = contentHtml;
    btn.parentElement.classList.add('relative');
    btn.parentElement.appendChild(dropdown);

    // 외부 클릭 시 닫기
    const closeDropdown = (e) => {
        if (!dropdown.contains(e.target) && e.target !== btn) {
            dropdown.remove();
            document.removeEventListener('click', closeDropdown);
        }
    };
    setTimeout(() => document.addEventListener('click', closeDropdown), 10);
}

window.handleNotificationClick = async (id, link) => {
    await supabaseClient.from('notifications').update({ is_read: true }).eq('id', id);
    if (link && link !== 'null') {
        window.location.href = link;
    } else {
        location.reload();
    }
};

window.markAllAsRead = async (userId) => {
    await supabaseClient.from('notifications').update({ is_read: true }).eq('user_id', userId).eq('is_read', false);
    location.reload();
};


// UI 초기화 및 헤더 사용자 정보 연동
async function setupUI() {
    try {
        let user = null;
        let meta = {};

        // 1) MOCK_USER (게스트/테스트 모드) 먼저 확인
        const mockUserStr = localStorage.getItem('MOCK_USER');
        if (mockUserStr) {
            user = JSON.parse(mockUserStr);
            meta = user.user_metadata || {};
        } else if (supabaseClient) {
            // 2) Supabase 세션
            const { data: { session } } = await supabaseClient.auth.getSession();
            if (session && session.user) {
                user = session.user;
                meta = user.user_metadata || {};
            }
        }

        if (!user) return;

        // 헤더 이름/역할 업데이트
        const nameEl = document.getElementById('header-user-name');
        const roleEl = document.getElementById('header-user-role');
        const avatarEl = document.getElementById('header-avatar');

        const displayName = meta.empnm || meta.name || '사용자';
        if (nameEl) nameEl.textContent = displayName;
        if (roleEl) {
            const roleMap = { 'admin': '관리자', 'judge': '심사위원', 'submitter': '임직원', 'employee': '임직원' };
            let roleText = roleMap[meta.role] || meta.role || '임직원';
            if (meta.role === 'admin') {
                roleText = `[${roleText}]`;
                roleEl.classList.add('text-primary', 'font-bold');
            }
            roleEl.textContent = roleText;
        }
        if (avatarEl) {
            avatarEl.textContent = displayName.substring(0, 1);
        }

        // 관리자 플래그를 전역으로 저장 (다른 페이지에서 활용)
        window.__isAdmin = (meta.role === 'admin');
        window.__currentUser = user;

    } catch (e) {
        console.error('[UI] Failed to setup common UI:', e);
    }
}

// 이미 상단에서 window 객체에 할당함

// 공통 초기화 실행
document.addEventListener('DOMContentLoaded', () => {
    setupUI();

    // 알림 아이콘 클릭 이벤트 연결
    const notifBtn = document.querySelector('button .material-symbols-outlined[textContent="notifications"]')?.parentElement;
    if (notifBtn) {
        notifBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleNotificationDropdown(notifBtn);
        });
    }
});


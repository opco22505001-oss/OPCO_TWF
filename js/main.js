/**
 * OPCO TWF 시스템 - 메인 로직
 * Supabase 초기화 및 공통 기능 처리 핸들러
 */

// Supabase 클라이언트 설정
const SUPABASE_URL = 'https://fuevhcdfgmdjhpdiwtzr.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ1ZXZoY2RmZ21kamhwZGl3dHpyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA5NTQ1MzcsImV4cCI6MjA4NjUzMDUzN30.rspRlciC1gwd1_t8gefP89yG0i19BoDsEXUbF3WG-dI';

// Supabase 클라이언트 초기화
let supabase;
const _createClient = (window.supabase && window.supabase.createClient);
if (_createClient) {
    supabase = _createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
} else if (typeof createClient !== 'undefined') {
    // Fallback for environments where createClient might be global
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
async function signInWithEmployeeId(empno, empnm, adminCode) {
    if (!supabase) return { error: 'Supabase가 초기화되지 않았습니다.' };

    try {
        const { data, error } = await supabase.functions.invoke('auth-login', {
            body: { empno, empnm, adminCode }
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
        supabase.auth.getSession = async () => ({ data: { session: { user: mockUser } }, error: null });
        supabase.auth.getUser = async () => ({ data: { user: mockUser }, error: null });

        // 알림 초기화 (ID가 있으므로 가능)
        initNotifications(mockUser.id);
        return;
    }

    const { data: { session } } = await supabase.auth.getSession();
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
    supabase
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
    const { count, error } = await supabase
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

    const { data: notifications, error } = await supabase
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
    await supabase.from('notifications').update({ is_read: true }).eq('id', id);
    if (link && link !== 'null') {
        window.location.href = link;
    } else {
        location.reload();
    }
};

window.markAllAsRead = async (userId) => {
    await supabase.from('notifications').update({ is_read: true }).eq('user_id', userId).eq('is_read', false);
    location.reload();
};

function showToast(message) {
    const toast = document.createElement('div');
    toast.className = 'fixed bottom-4 right-4 bg-primary text-white px-6 py-3 rounded-lg shadow-2xl z-[100] animate-bounce';
    toast.textContent = `🔔 ${message}`;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
}


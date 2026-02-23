// 마이 페이지 로직

document.addEventListener('DOMContentLoaded', async () => {
    // 세션 및 프로필 로드
    const user = await checkSession();
    if (!user) return; // checkSession에서 리다이렉트 처리됨 (main.js가 있다면) 또는 여기서 처리

    await loadUserProfile(user.id);
    await loadMySubmissions(user.id); // Default Tab

    // 헤더/UI 통합 업데이트
    if (window.setupUI) window.setupUI();

    // 탭 전환 이벤트
    const tabSub = document.getElementById('tab-submissions');
    const tabJudge = document.getElementById('tab-judgments');

    tabSub.addEventListener('click', () => {
        setActiveTab(tabSub, tabJudge);
        loadMySubmissions(user.id);
    });

    tabJudge.addEventListener('click', () => {
        setActiveTab(tabJudge, tabSub);
        loadAssignedJudgments(user.id);
    });

    // 로그아웃
    document.getElementById('logout-btn').addEventListener('click', async () => {
        await supabaseClient.auth.signOut();
        localStorage.removeItem('MOCK_USER');
        window.location.href = 'login.html';
    });
});

async function checkSession() {
    if (!supabaseClient) return null;
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (!session) {
        window.location.href = 'login.html';
        return null;
    }
    return session.user;
}

// 프로필 정보 및 통계 로드
async function loadUserProfile(userId) {
    // 세션 정보에서 먼저 시도 (속도 및 일관성)
    const { data: { session } } = await supabaseClient.auth.getSession();
    const user = session?.user;
    const meta = user?.user_metadata || {};

    let dbProfile = null;
    const email = user?.email || '';
    const empnoFromEmail = email.includes('@') ? email.split('@')[0] : '';

    const { data: userRow } = await supabaseClient
        .from('users')
        .select('name, department, role, email')
        .eq('id', userId)
        .maybeSingle();

    if (userRow) {
        dbProfile = userRow;
    } else if (email) {
        const { data: userByEmail } = await supabaseClient
            .from('users')
            .select('name, department, role, email')
            .eq('email', email)
            .maybeSingle();
        if (userByEmail) dbProfile = userByEmail;
    }

    let corpDept = '';
    if (empnoFromEmail) {
        const { data: corpRow } = await supabaseClient
            .from('corporate_employees')
            .select('depnm, empnm')
            .eq('empno', empnoFromEmail)
            .maybeSingle();
        corpDept = corpRow?.depnm || '';
        if (!dbProfile?.name && corpRow?.empnm) {
            dbProfile = { ...(dbProfile || {}), name: corpRow.empnm };
        }
    }

    // 화면 업데이트 (헤더 및 프로필 카드)
    const name = dbProfile?.name || meta.empnm || meta.name || '사용자';
    const role = dbProfile?.role || meta.role || 'employee';
    const dept = dbProfile?.department || meta.depnm || meta.department || corpDept || '부서 미정';
    const empno = meta.empno || empnoFromEmail || '';

    // 헤더 업데이트 (main.js의 setupUI와 별개로 마이페이지 특화 요소가 있을 수 있음)
    if (document.getElementById('header-user-name')) document.getElementById('header-user-name').textContent = name;
    if (document.getElementById('header-user-role')) document.getElementById('header-user-role').textContent = getRoleName(role);

    // 프로필 카드 업데이트
    if (document.getElementById('profile-name')) document.getElementById('profile-name').textContent = name;
    if (document.getElementById('profile-dept')) document.getElementById('profile-dept').textContent = dept;
    if (document.getElementById('profile-role')) document.getElementById('profile-role').textContent = getRoleName(role);
    if (document.getElementById('profile-empno')) document.getElementById('profile-empno').textContent = empno;

    const avatarStr = name.substring(0, 1);
    if (document.getElementById('header-avatar')) document.getElementById('header-avatar').textContent = avatarStr;
    if (document.getElementById('profile-avatar')) document.getElementById('profile-avatar').textContent = avatarStr;

    // 통계 (내 제안 수)
    const { count: subCount } = await supabaseClient
        .from('submissions')
        .select('*', { count: 'exact', head: true })
        .eq('submitter_id', userId);
    document.getElementById('stat-submissions').textContent = subCount || 0;

    // 통계 (할당된 심사 수 - 심사위원인 경우)
    // event_judges 테이블에서 judge_id = userId 인 이벤트 개수 확인
    // 또는 실제 judgments 테이블 카운트 (여기선 배정된 이벤트 수로 표시 or 실제 심사한 수)
    // 배정된 건수로 표시
    const { count: judgeCount } = await supabaseClient
        .from('event_judges')
        .select('*', { count: 'exact', head: true })
        .eq('judge_id', userId);
    document.getElementById('stat-judgments').textContent = judgeCount || 0;
}

// 내 제안 목록 로드
async function loadMySubmissions(userId) {
    const contentEl = document.getElementById('content-area');
    contentEl.innerHTML = '<div class="animate-pulse space-y-4"><div class="h-24 bg-slate-100 rounded-lg"></div></div>'; // Loading

    const { data, error } = await supabaseClient
        .from('submissions')
        .select(`
            id,
            event_id,
            status,
            content,
            created_at,
            events ( title, status )
        `)
        .eq('submitter_id', userId)
        .order('created_at', { ascending: false });

    if (error) {
        console.error(error);
        contentEl.innerHTML = '<p class="text-center text-text-muted py-8">데이터를 불러오는 중 오류가 발생했습니다.</p>';
        return;
    }

    if (!data || data.length === 0) {
        contentEl.innerHTML = `
            <div class="text-center py-12 bg-surface-light dark:bg-surface-dark rounded-lg border border-dashed border-border-light">
                <p class="text-text-muted mb-2">제출한 제안이 없습니다.</p>
                <button onclick="window.location.href='dashboard.html'" class="text-primary hover:underline text-sm">이벤트 목록 보러가기</button>
            </div>`;
        return;
    }

    contentEl.innerHTML = data.map(sub => {
        const title = (sub.content && sub.content.title) ? sub.content.title : (sub.events?.title || '제목 없음');
        return `
            <div class="bg-surface-light dark:bg-surface-dark p-6 rounded-lg border border-border-light dark:border-gray-700 shadow-sm hover:border-primary/50 transition-colors flex justify-between items-center group cursor-pointer" 
                 onclick="window.location.href='event-detail.html?id=${sub.event_id}'">
                <div>
                    <div class="flex items-center gap-2 mb-1">
                        <span class="text-xs px-2 py-0.5 rounded-full ${getStatusStyle(sub.status)}">${getStatusName(sub.status)}</span>
                        <span class="text-xs text-text-muted">${new Date(sub.created_at).toLocaleDateString()}</span>
                    </div>
                    <h3 class="font-bold text-lg text-text-main dark:text-white group-hover:text-primary transition-colors">
                        ${title}
                    </h3>
                    <p class="text-[11px] text-text-muted mt-1">이벤트: ${sub.events?.title || '삭제된 이벤트'} (${getEventStatusName(sub.events?.status)})</p>
                </div>
                <span class="material-symbols-outlined text-text-muted group-hover:text-primary">arrow_forward_ios</span>
            </div>
        `;
    }).join('');
}

// 심사 배정 목록 로드
async function loadAssignedJudgments(userId) {
    const contentEl = document.getElementById('content-area');
    contentEl.innerHTML = '<div class="animate-pulse space-y-4"><div class="h-24 bg-slate-100 rounded-lg"></div></div>';

    // 내가 심사위원으로 배정된 이벤트 목록 조회
    // 그리고 그 이벤트에 제출된 제안서 중 '제출됨(submitted)' 상태인 것들 (심사 대상)

    // 1. 배정된 이벤트 ID 조회
    const { data: judgeEvents } = await supabaseClient
        .from('event_judges')
        .select('event_id')
        .eq('judge_id', userId);

    if (!judgeEvents || judgeEvents.length === 0) {
        contentEl.innerHTML = `
            <div class="text-center py-12 bg-surface-light dark:bg-surface-dark rounded-lg border border-dashed border-border-light">
                <p class="text-text-muted">배정된 심사 이벤트가 없습니다.</p>
            </div>`;
        return;
    }

    const eventIds = judgeEvents.map(e => e.event_id);

    // 2. 해당 이벤트의 제출용 제안서 조회 (심사 대기/진행 중인 건)
    const { data: submissions, error } = await supabaseClient
        .from('submissions')
        .select(`
            id,
            event_id,
            status,
            content,
            created_at,
            events ( title ),
            submitter:users!submitter_id ( name, department )
        `)
        .in('event_id', eventIds)
        .neq('status', 'draft') // 임시저장 제외
        .order('created_at', { ascending: false });

    if (error) {
        console.error(error);
        contentEl.innerHTML = '<p class="text-center text-text-muted py-8">데이터오류</p>';
        return;
    }

    if (!submissions || submissions.length === 0) {
        contentEl.innerHTML = `
            <div class="text-center py-12 bg-surface-light dark:bg-surface-dark rounded-lg border border-dashed border-border-light">
                <p class="text-text-muted">현재 심사할 제안서가 없습니다.</p>
            </div>`;
        return;
    }

    contentEl.innerHTML = submissions.map(sub => {
        const subTitle = (sub.content && sub.content.title) ? sub.content.title : '제목 없음';
        return `
            <div class="bg-surface-light dark:bg-surface-dark p-6 rounded-lg border border-border-light dark:border-gray-700 shadow-sm hover:border-primary/50 transition-colors flex justify-between items-center group cursor-pointer" 
                 onclick="window.location.href='event-detail.html?id=${sub.event_id}'">
                <div>
                    <div class="flex items-center gap-2 mb-1">
                        <span class="text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">제출자: ${sub.submitter?.name || '알 수 없음'} (${sub.submitter?.department || ''})</span>
                        <span class="text-xs text-text-muted">${new Date(sub.created_at).toLocaleDateString()}</span>
                    </div>
                    <h3 class="font-bold text-lg text-text-main dark:text-white group-hover:text-primary transition-colors">
                        ${subTitle}
                    </h3>
                    <p class="text-xs text-text-muted mt-1">이벤트: ${sub.events?.title || '이벤트'}</p>
                    <div class="flex items-center gap-2 mt-2">
                         <span class="text-xs px-2 py-0.5 rounded-full ${getStatusStyle(sub.status)}">${getStatusName(sub.status)}</span>
                    </div>
                </div>
                <button class="px-4 py-2 bg-primary text-white text-sm font-bold rounded hover:bg-primary-hover transition-colors">심사하기</button>
            </div>
        `;
    }).join('');
}


// UI Helpers
function setActiveTab(active, inactive) {
    active.classList.remove('border-transparent', 'text-text-muted', 'hover:border-gray-300', 'hover:text-text-main');
    active.classList.add('border-primary', 'text-primary');

    inactive.classList.remove('border-primary', 'text-primary');
    inactive.classList.add('border-transparent', 'text-text-muted', 'hover:border-gray-300', 'hover:text-text-main');
}

function getRoleName(role) {
    const map = { 'admin': '관리자', 'judge': '심사위원', 'submitter': '제안자' };
    return map[role] || role;
}

function getStatusName(status) {
    const map = {
        'submitted': '제출 완료',
        'under_review': '심사 중',
        'approved': '채택됨',
        'rejected': '반려됨',
        'draft': '임시 저장'
    };
    return map[status] || status;
}

function getEventStatusName(status) {
    const map = { 'active': '진행 중', 'closed': '종료', 'draft': '준비 중' };
    return map[status] || status;
}

function getStatusStyle(status) {
    const map = {
        'submitted': 'bg-blue-50 text-blue-700 border border-blue-200',
        'under_review': 'bg-purple-50 text-purple-700 border border-purple-200',
        'approved': 'bg-green-50 text-green-700 border border-green-200',
        'rejected': 'bg-red-50 text-red-700 border border-red-200',
        'draft': 'bg-gray-100 text-gray-600'
    };
    return map[status] || 'bg-gray-100 text-gray-600';
}

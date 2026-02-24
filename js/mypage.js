// 마이페이지 로직

document.addEventListener('DOMContentLoaded', async () => {
    const user = await checkSession();
    if (!user) return;

    await loadUserProfile(user.id);
    await loadMySubmissions(user);

    if (window.setupUI) window.setupUI();

    const tabSub = document.getElementById('tab-submissions');
    const tabJudge = document.getElementById('tab-judgments');

    tabSub?.addEventListener('click', () => {
        setActiveTab(tabSub, tabJudge);
        loadMySubmissions(user);
    });

    tabJudge?.addEventListener('click', () => {
        setActiveTab(tabJudge, tabSub);
        loadAssignedJudgments(user);
    });

    document.getElementById('logout-btn')?.addEventListener('click', async () => {
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

async function loadUserProfile(userId) {
    const { data: { session } } = await supabaseClient.auth.getSession();
    const user = session?.user;
    const meta = user?.user_metadata || {};

    const { data: userRow } = await supabaseClient
        .from('users')
        .select('name, department, role, email')
        .eq('id', userId)
        .maybeSingle();

    const email = user?.email || userRow?.email || '';
    const empno = meta.empno || (email.includes('@') ? email.split('@')[0] : '');

    let corpDept = '';
    if (empno) {
        const { data: corpRow } = await supabaseClient
            .from('corporate_employees')
            .select('depnm, empnm')
            .eq('empno', empno)
            .maybeSingle();
        corpDept = corpRow?.depnm || '';
    }

    const name = userRow?.name || meta.name || meta.empnm || '사용자';
    const role = userRow?.role || meta.role || 'submitter';
    const dept = userRow?.department || meta.department || meta.depnm || corpDept || '부서 미지정';

    setText('header-user-name', name);
    setText('header-user-role', getRoleName(role));
    setText('profile-name', name);
    setText('profile-dept', dept);
    setText('profile-role', getRoleName(role));
    setText('profile-empno', empno || '-');

    const avatarText = (name || 'U').slice(0, 1);
    setText('header-avatar', avatarText);
    setText('profile-avatar', avatarText);

    const submitterIds = await resolveUserIdsForSessionUser(user);
    let subCount = 0;
    if (submitterIds.length > 0) {
        const { count } = await supabaseClient
            .from('submissions')
            .select('*', { count: 'exact', head: true })
            .in('submitter_id', submitterIds);
        subCount = count || 0;
    }

    const judgeIds = await resolveUserIdsForSessionUser(user);
    let judgeCount = 0;
    if (judgeIds.length > 0) {
        const { count } = await supabaseClient
            .from('event_judges')
            .select('*', { count: 'exact', head: true })
            .in('judge_id', judgeIds);
        judgeCount = count || 0;
    }

    setText('stat-submissions', String(subCount));
    setText('stat-judgments', String(judgeCount));
}

async function loadMySubmissions(userOrId) {
    const contentEl = document.getElementById('content-area');
    if (!contentEl) return;
    contentEl.innerHTML = '<div class="animate-pulse space-y-4"><div class="h-24 bg-slate-100 rounded-lg"></div></div>';

    const sessionUser = (typeof userOrId === 'object' && userOrId)
        ? userOrId
        : (await supabaseClient.auth.getUser()).data?.user;
    const submitterIds = await resolveUserIdsForSessionUser(sessionUser);
    if (!submitterIds.length) {
        contentEl.innerHTML = `
            <div class="text-center py-12 bg-surface-light dark:bg-surface-dark rounded-lg border border-dashed border-border-light">
                <p class="text-text-muted mb-2">제출한 제안이 없습니다.</p>
                <button onclick="window.location.href='dashboard.html'" class="text-primary hover:underline text-sm">이벤트 목록 보기</button>
            </div>`;
        return;
    }

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
        .in('submitter_id', submitterIds)
        .order('created_at', { ascending: false });

    if (error) {
        console.error(error);
        contentEl.innerHTML = '<p class="text-center text-text-muted py-8">제출 목록을 불러오지 못했습니다.</p>';
        return;
    }

    if (!data?.length) {
        contentEl.innerHTML = `
            <div class="text-center py-12 bg-surface-light dark:bg-surface-dark rounded-lg border border-dashed border-border-light">
                <p class="text-text-muted mb-2">제출한 제안이 없습니다.</p>
                <button onclick="window.location.href='dashboard.html'" class="text-primary hover:underline text-sm">이벤트 목록 보기</button>
            </div>`;
        return;
    }

    contentEl.innerHTML = data.map((sub) => {
        const title = sub.content?.title || sub.events?.title || '제목 없음';
        return `
            <div class="bg-surface-light dark:bg-surface-dark p-6 rounded-lg border border-border-light dark:border-gray-700 shadow-sm hover:border-primary/50 transition-colors flex justify-between items-center group cursor-pointer"
                 onclick="window.location.href='event-detail.html?id=${sub.event_id}'">
                <div>
                    <div class="flex items-center gap-2 mb-1">
                        <span class="text-xs px-2 py-0.5 rounded-full ${getStatusStyle(sub.status)}">${getStatusName(sub.status)}</span>
                        <span class="text-xs text-text-muted">${new Date(sub.created_at).toLocaleDateString()}</span>
                    </div>
                    <h3 class="font-bold text-lg text-text-main dark:text-white group-hover:text-primary transition-colors">${title}</h3>
                    <p class="text-[11px] text-text-muted mt-1">이벤트: ${sub.events?.title || '-'} (${getEventStatusName(sub.events?.status)})</p>
                </div>
                <span class="material-symbols-outlined text-text-muted group-hover:text-primary">arrow_forward_ios</span>
            </div>
        `;
    }).join('');
}

async function loadAssignedJudgments(userOrId) {
    const contentEl = document.getElementById('content-area');
    if (!contentEl) return;
    contentEl.innerHTML = '<div class="animate-pulse space-y-4"><div class="h-24 bg-slate-100 rounded-lg"></div></div>';

    const sessionUser = (typeof userOrId === 'object' && userOrId)
        ? userOrId
        : (await supabaseClient.auth.getUser()).data?.user;
    const judgeIds = await resolveUserIdsForSessionUser(sessionUser);
    if (!judgeIds.length) {
        contentEl.innerHTML = `
            <div class="text-center py-12 bg-surface-light dark:bg-surface-dark rounded-lg border border-dashed border-border-light">
                <p class="text-text-muted">배정된 심사 이벤트가 없습니다.</p>
            </div>`;
        return;
    }

    const { data: assignedEvents, error } = await supabaseClient
        .from('event_judges')
        .select(`
            event_id,
            events!event_judges_event_id_fkey (
                id,
                title,
                status,
                start_date,
                end_date
            )
        `)
        .in('judge_id', judgeIds)
        .order('created_at', { ascending: false });

    if (error) {
        console.error(error);
        contentEl.innerHTML = '<p class="text-center text-text-muted py-8">심사 배정 목록을 불러오지 못했습니다.</p>';
        return;
    }

    const events = (assignedEvents || []).map((row) => row.events).filter(Boolean);

    if (!events.length) {
        contentEl.innerHTML = `
            <div class="text-center py-12 bg-surface-light dark:bg-surface-dark rounded-lg border border-dashed border-border-light">
                <p class="text-text-muted">배정된 심사 이벤트가 없습니다.</p>
            </div>`;
        return;
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    contentEl.innerHTML = events.map((event) => {
        const endDate = event.end_date ? new Date(event.end_date) : null;
        if (endDate) endDate.setHours(0, 0, 0, 0);

        const effectiveStatus = (event.status === 'closed' || (endDate && endDate < today)) ? 'closed' : event.status;
        const badgeClass = effectiveStatus === 'closed'
            ? 'bg-gray-100 text-gray-700 border border-gray-200'
            : 'bg-emerald-50 text-emerald-700 border border-emerald-200';
        const badgeText = effectiveStatus === 'closed' ? '종료됨' : '진행중';

        return `
            <div class="bg-surface-light dark:bg-surface-dark p-6 rounded-lg border border-border-light dark:border-gray-700 shadow-sm hover:border-primary/50 transition-colors flex justify-between items-center group cursor-pointer"
                 onclick="window.location.href='event-detail.html?id=${event.id}'">
                <div>
                    <div class="flex items-center gap-2 mb-1">
                        <span class="text-xs px-2 py-0.5 rounded-full ${badgeClass}">${badgeText}</span>
                        <span class="text-xs text-text-muted">${event.start_date || '-'} ~ ${event.end_date || '-'}</span>
                    </div>
                    <h3 class="font-bold text-lg text-text-main dark:text-white group-hover:text-primary transition-colors">${event.title || '제목 없음'}</h3>
                    <p class="text-xs text-text-muted mt-1">심사 배정 이벤트</p>
                </div>
                <button class="px-4 py-2 bg-primary text-white text-sm font-bold rounded hover:bg-primary-hover transition-colors">이벤트 보기</button>
            </div>
        `;
    }).join('');
}

async function resolveUserIdsForSessionUser(user) {
    if (!user) return [];
    const ids = new Set();
    if (user.id) ids.add(user.id);

    const email = (user.email || '').toLowerCase();
    if (!email) return Array.from(ids);

    const { data: rows } = await supabaseClient
        .from('users')
        .select('id')
        .eq('email', email);

    (rows || []).forEach((row) => {
        if (row?.id) ids.add(row.id);
    });

    return Array.from(ids);
}

function setActiveTab(active, inactive) {
    active?.classList.remove('border-transparent', 'text-text-muted', 'hover:border-gray-300', 'hover:text-text-main');
    active?.classList.add('border-primary', 'text-primary');

    inactive?.classList.remove('border-primary', 'text-primary');
    inactive?.classList.add('border-transparent', 'text-text-muted', 'hover:border-gray-300', 'hover:text-text-main');
}

function getRoleName(role) {
    const map = { admin: '관리자', judge: '심사위원', submitter: '제안자' };
    return map[role] || role || '-';
}

function getStatusName(status) {
    const map = {
        submitted: '제출 완료',
        under_review: '심사 중',
        approved: '채택됨',
        rejected: '반려됨',
        draft: '임시 저장',
    };
    return map[status] || status || '-';
}

function getEventStatusName(status) {
    const map = { active: '진행중', closed: '종료', draft: '초안' };
    return map[status] || status || '-';
}

function getStatusStyle(status) {
    const map = {
        submitted: 'bg-blue-50 text-blue-700 border border-blue-200',
        under_review: 'bg-purple-50 text-purple-700 border border-purple-200',
        approved: 'bg-green-50 text-green-700 border border-green-200',
        rejected: 'bg-red-50 text-red-700 border border-red-200',
        draft: 'bg-gray-100 text-gray-600',
    };
    return map[status] || 'bg-gray-100 text-gray-600';
}

function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
}

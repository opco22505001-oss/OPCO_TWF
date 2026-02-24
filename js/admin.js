let allEmployees = [];

async function requireAdminSession() {
    if (!window.supabaseClient) return null;

    const { data: userData, error: userError } = await supabaseClient.auth.getUser();
    if (userError || !userData?.user) {
        window.location.href = 'login.html';
        return null;
    }
    const currentUser = userData.user;

    const roleFromMeta = currentUser.user_metadata?.role;
    if (roleFromMeta === 'admin') return currentUser;

    const { data: me } = await supabaseClient
        .from('users')
        .select('role')
        .eq('id', currentUser.id)
        .maybeSingle();

    if (me?.role !== 'admin') {
        alert('관리자만 접근할 수 있습니다.');
        window.location.href = 'dashboard.html';
        return null;
    }

    return currentUser;
}

async function invokeAdminFunction(functionName, body = {}) {
    const { data: { session }, error: sessionError } = await supabaseClient.auth.getSession();
    if (sessionError || !session?.access_token) {
        throw new Error('세션이 만료되었습니다. 다시 로그인해 주세요.');
    }

    const { data, error } = await supabaseClient.functions.invoke(functionName, {
        body,
        headers: {
            Authorization: `Bearer ${session.access_token}`
        }
    });

    if (error || data?.error) {
        const wrapped = new Error(data?.error || error?.message || '요청 실패');
        wrapped.code = data?.code;
        wrapped.detail = data?.detail;
        wrapped.request_id = data?.request_id;
        throw wrapped;
    }

    return data;
}

function renderDashboardMetrics(metrics = {}) {
    const activeEl = document.getElementById('metric-active-events');
    const submissionEl = document.getElementById('metric-submission-rate');
    const reviewEl = document.getElementById('metric-review-rate');

    if (activeEl) activeEl.textContent = metrics.activeCount ?? 0;
    if (submissionEl) submissionEl.textContent = `${Number(metrics.avgSubmissionRate ?? 0).toFixed(1)}%`;
    if (reviewEl) reviewEl.textContent = `${Number(metrics.avgReviewRate ?? 0).toFixed(1)}%`;
}

function formatDaysLeft(daysLeft) {
    if (daysLeft === null || daysLeft === undefined) return '-';
    if (daysLeft < 0) return `${Math.abs(daysLeft)}일 지남`;
    if (daysLeft === 0) return '오늘 마감';
    return `${daysLeft}일 남음`;
}

function renderDelayedEvents(rows = []) {
    const tbody = document.getElementById('delayed-events-table');
    if (!tbody) return;

    if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="5" class="px-4 py-10 text-center text-text-muted">현재 지연/임박 이벤트가 없습니다.</td></tr>';
        return;
    }

    tbody.innerHTML = rows.map((row) => {
        const statusText = row.status === 'closed' ? '마감' : (row.status === 'active' ? '진행중' : '초안');
        const dayClass = Number(row.daysLeft) < 0 ? 'text-red-600' : 'text-amber-600';
        return `
            <tr>
                <td class="px-4 py-3">
                    <a href="event-detail.html?id=${row.eventId}" class="font-medium text-primary hover:underline">${row.title || '-'}</a>
                </td>
                <td class="px-4 py-3 text-text-muted">${statusText}</td>
                <td class="px-4 py-3 text-right font-mono">${Number(row.submissionRate ?? 0).toFixed(1)}%</td>
                <td class="px-4 py-3 text-right font-mono">${Number(row.reviewRate ?? 0).toFixed(1)}%</td>
                <td class="px-4 py-3 text-right font-mono ${dayClass}">${formatDaysLeft(row.daysLeft)}</td>
            </tr>
        `;
    }).join('');
}

function getMetricFilters() {
    const nearDays = Number(document.getElementById('filter-near-days')?.value ?? 2);
    const reviewThreshold = Number(document.getElementById('filter-review-threshold')?.value ?? 70);
    const statusFilter = document.getElementById('filter-status')?.value || 'all';

    return {
        nearDays: Number.isFinite(nearDays) ? Math.max(0, nearDays) : 2,
        reviewThreshold: Number.isFinite(reviewThreshold) ? Math.min(100, Math.max(1, reviewThreshold)) : 70,
        statusFilter,
    };
}

async function loadDashboardMetrics() {
    const filters = getMetricFilters();
    try {
        const data = await invokeAdminFunction('admin-dashboard-metrics', filters);
        renderDashboardMetrics(data?.metrics || {});
        renderDelayedEvents(Array.isArray(data?.delayedEvents) ? data.delayedEvents : []);
    } catch (err) {
        const msg = err?.message || '대시보드 지표 조회 실패';
        console.error('[Admin] 대시보드 지표 조회 실패:', err);
        renderDashboardMetrics({});
        renderDelayedEvents([]);
    }
}

async function loadEmployees() {
    try {
        const data = await invokeAdminFunction('admin-manage-user-role', { action: 'list' });
        allEmployees = Array.isArray(data?.employees) ? data.employees : [];
        renderEmployees();
    } catch (err) {
        const msg = err?.message || '목록 조회 실패';
        const code = err?.code ? ` [${err.code}]` : '';
        console.error('[Admin] 직원 목록 조회 실패:', err);
        alert(`직원 목록 조회 실패${code}: ${msg}`);
        return;
    }
}

function updateStats(rows) {
    document.getElementById('stat-total').textContent = rows.length;
    document.getElementById('stat-admin').textContent = rows.filter((row) => row.role === 'admin').length;
}

function getRoleBadge(role) {
    if (role === 'admin') return '<span class="inline-flex px-2.5 py-1 rounded-full text-xs font-semibold bg-primary-light text-primary">관리자</span>';
    if (role === 'judge') return '<span class="inline-flex px-2.5 py-1 rounded-full text-xs font-semibold bg-blue-50 text-blue-700">심사위원</span>';
    return '<span class="inline-flex px-2.5 py-1 rounded-full text-xs font-semibold bg-slate-100 text-slate-700">일반</span>';
}

function renderEmployees() {
    const keyword = (document.getElementById('employee-search')?.value || '').trim().toLowerCase();
    const filtered = allEmployees.filter((employee) => {
        const haystack = `${employee.empno || ''} ${employee.empnm || ''} ${employee.depnm || ''}`.toLowerCase();
        return haystack.includes(keyword);
    });

    updateStats(filtered);

    const tbody = document.getElementById('admin-user-table');
    if (!filtered.length) {
        tbody.innerHTML = '<tr><td colspan="5" class="px-4 py-10 text-center text-text-muted">검색 결과가 없습니다.</td></tr>';
        return;
    }

    tbody.innerHTML = filtered.map((employee) => {
        const toRole = employee.role === 'admin' ? 'submitter' : 'admin';
        const buttonLabel = employee.role === 'admin' ? '관리자 해제' : '관리자로 변경';
        const buttonClass = employee.role === 'admin'
            ? 'border-slate-300 text-slate-700 hover:bg-slate-100'
            : 'border-primary text-primary hover:bg-primary-light';

        return `
            <tr>
                <td class="px-4 py-3 font-mono">${employee.empno || '-'}</td>
                <td class="px-4 py-3 font-medium">${employee.empnm || '-'}</td>
                <td class="px-4 py-3 text-text-muted">${employee.depnm || '-'}</td>
                <td class="px-4 py-3">${getRoleBadge(employee.role)}</td>
                <td class="px-4 py-3 text-right">
                    <button
                        class="inline-flex items-center rounded-md border px-3 py-1.5 text-xs font-semibold transition-colors ${buttonClass}"
                        onclick="changeEmployeeRole('${employee.empno}', '${toRole}')">
                        ${buttonLabel}
                    </button>
                </td>
            </tr>
        `;
    }).join('');
}

async function loadJudgeStats() {
    const tbody = document.getElementById('judge-stats-table');
    if (!tbody) return;

    let data;
    try {
        data = await invokeAdminFunction('admin-judgment-analytics', {});
    } catch (err) {
        const msg = err?.message || '심사 통계 조회 실패';
        console.error('[Admin] 심사 통계 조회 실패:', err);
        tbody.innerHTML = `<tr><td colspan="5" class="px-4 py-10 text-center text-red-500">${msg}</td></tr>`;
        return;
    }

    const stats = Array.isArray(data?.stats) ? data.stats : [];
    if (!stats.length) {
        tbody.innerHTML = '<tr><td colspan="5" class="px-4 py-10 text-center text-text-muted">심사 데이터가 없습니다.</td></tr>';
        return;
    }

    tbody.innerHTML = stats.map((row) => `
        <tr>
            <td class="px-4 py-3 font-medium">${row.judgeName || '-'}</td>
            <td class="px-4 py-3 text-text-muted">${row.department || '-'}</td>
            <td class="px-4 py-3 text-right font-mono">${row.count ?? 0}</td>
            <td class="px-4 py-3 text-right font-mono">${row.avgScore ?? 0}</td>
            <td class="px-4 py-3 text-right font-mono">${row.stddevScore ?? 0}</td>
        </tr>
    `).join('');
}

function formatAuditMeta(meta) {
    if (!meta || typeof meta !== 'object') return '-';
    const entries = Object.entries(meta).slice(0, 3);
    if (!entries.length) return '-';
    return entries.map(([k, v]) => `${k}: ${String(v)}`).join(' / ');
}

async function loadAuditLogs() {
    const tbody = document.getElementById('audit-log-table');
    if (!tbody) return;

    let data;
    try {
        data = await invokeAdminFunction('admin-audit-logs', { limit: 50 });
    } catch (err) {
        const msg = err?.message || '감사 로그 조회 실패';
        console.error('[Admin] 감사 로그 조회 실패:', err);
        tbody.innerHTML = `<tr><td colspan="5" class="px-4 py-10 text-center text-red-500">${msg}</td></tr>`;
        return;
    }

    const rows = Array.isArray(data?.logs) ? data.logs : [];
    if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="5" class="px-4 py-10 text-center text-text-muted">감사 로그가 없습니다.</td></tr>';
        return;
    }

    tbody.innerHTML = rows.map((row) => `
        <tr>
            <td class="px-4 py-3 font-mono text-xs">${new Date(row.created_at).toLocaleString()}</td>
            <td class="px-4 py-3 text-xs">${row.actor_name || '-'} (${row.actor_empno || '-'})</td>
            <td class="px-4 py-3 text-xs font-semibold">${row.action || '-'}</td>
            <td class="px-4 py-3 text-xs">${row.target_type || '-'} / ${row.target_id || '-'}</td>
            <td class="px-4 py-3 text-xs text-text-muted">${formatAuditMeta(row.metadata)}</td>
        </tr>
    `).join('');
}

window.changeEmployeeRole = async (empno, nextRole) => {
    const confirmMsg = nextRole === 'admin'
        ? `${empno} 사원을 관리자로 변경하시겠습니까?`
        : `${empno} 사원의 관리자 권한을 해제하시겠습니까?`;
    if (!confirm(confirmMsg)) return;

    const adminCode = prompt('관리자 인증 코드를 입력하세요.');
    if (!adminCode) return;

    try {
        await invokeAdminFunction('admin-manage-user-role', { action: 'update_role', empno, nextRole, adminCode });
    } catch (err) {
        const msg = err?.message || '권한 변경 실패';
        const code = err?.code ? ` (${err.code})` : '';
        const detail = err?.detail ? `\n상세: ${err.detail}` : '';
        const requestId = err?.request_id ? `\n요청 ID: ${err.request_id}` : '';
        console.error('[Admin] 권한 변경 실패:', err);
        alert(`권한 변경 실패${code}: ${msg}${detail}${requestId}`);
        return;
    }

    alert('권한이 변경되었습니다.');
    await Promise.all([loadEmployees(), loadAuditLogs()]);
};

document.addEventListener('DOMContentLoaded', async () => {
    const user = await requireAdminSession();
    if (!user) return;

    if (window.setupUI) await window.setupUI();

    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', async () => {
            await supabaseClient.auth.signOut();
            localStorage.removeItem('MOCK_USER');
            window.location.href = 'login.html';
        });
    }

    document.getElementById('employee-search')?.addEventListener('input', renderEmployees);
    document.getElementById('btn-refresh-metrics')?.addEventListener('click', loadDashboardMetrics);
    document.getElementById('btn-refresh-audit')?.addEventListener('click', loadAuditLogs);
    document.getElementById('filter-near-days')?.addEventListener('change', loadDashboardMetrics);
    document.getElementById('filter-review-threshold')?.addEventListener('change', loadDashboardMetrics);
    document.getElementById('filter-status')?.addEventListener('change', loadDashboardMetrics);

    await Promise.all([
        loadEmployees(),
        loadDashboardMetrics(),
        loadJudgeStats(),
        loadAuditLogs(),
    ]);
});

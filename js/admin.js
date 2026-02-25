let allEmployees = [];
let allEventDepartmentStats = [];

function getUserErrorMessage(context, error, fallback = '요청 처리 중 오류가 발생했습니다.') {
    if (window.AppError?.toConsole) {
        const parsed = window.AppError.toConsole(context, error);
        return parsed.userMessage || fallback;
    }
    console.error(`[${context}]`, error);
    return fallback;
}

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

    const { data: meById } = await supabaseClient
        .from('users')
        .select('role')
        .eq('id', currentUser.id)
        .maybeSingle();

    const currentEmail = (currentUser.email || '').toLowerCase();
    let roleByEmail = '';
    if (currentEmail) {
        const { data: meByEmail } = await supabaseClient
            .from('users')
            .select('role')
            .eq('email', currentEmail)
            .maybeSingle();
        roleByEmail = meByEmail?.role || '';
    }

    let corpRole = '';
    const empno = currentEmail.includes('@') ? currentEmail.split('@')[0] : '';
    if (empno) {
        const { data: corp } = await supabaseClient
            .from('corporate_employees')
            .select('role')
            .eq('empno', empno)
            .maybeSingle();
        corpRole = corp?.role || '';
    }

    const isAdmin = meById?.role === 'admin' || roleByEmail === 'admin' || corpRole === 'admin';
    if (!isAdmin) {
        alert('관리자만 접근할 수 있습니다.');
        window.location.href = 'dashboard.html';
        return null;
    }

    return currentUser;
}

async function getFreshAccessToken(forceRefresh = false) {
    try {
        const { data: { session }, error: sessionError } = await supabaseClient.auth.getSession();

        if (sessionError) {
            console.error('[Admin Auth] Get session error:', sessionError);
            throw new Error('인증 세션을 가져오는 중 오류가 발생했습니다.');
        }

        if (!session) {
            console.warn('[Admin Auth] No active session found');
            throw new Error('로그인 세션이 없습니다. 다시 로그인해 주세요.');
        }

        let currentSession = session;
        const expiresAtMs = (currentSession.expires_at || 0) * 1000;
        const now = Date.now();

        // 1분 이내 만료 예정이거나 강제 리프레시 요청 시
        const shouldRefresh = forceRefresh || (expiresAtMs && expiresAtMs < now + 60 * 1000);

        if (shouldRefresh) {
            console.log('[Admin Auth] Attempting to refresh session...');
            const { data: refreshed, error: refreshError } = await supabaseClient.auth.refreshSession();
            if (refreshError) {
                console.error('[Admin Auth] Session refresh failed:', refreshError);
                throw new Error('세션 갱신에 실패했습니다. 다시 로그인해 주세요.');
            }
            if (refreshed?.session) {
                console.log('[Admin Auth] Session refreshed successfully');
                currentSession = refreshed.session;
            }
        }

        if (!currentSession.access_token) {
            throw new Error('유효한 인증 토큰이 없습니다.');
        }

        return currentSession.access_token;
    } catch (e) {
        console.error('[Admin Auth] Token acquisition failed:', e);
        throw e;
    }
}

async function invokeAdminFunction(functionName, body = {}) {
    const call = async (token) => {
        console.log(`[Admin API] Invoking ${functionName} with token (${token ? 'exists' : 'missing'})...`);

        // Supabase 클라이언트의 functions.invoke는 header를 자동으로 처리하지만, 
        // Edge Function에서 verify_jwt: false로 수동 검증하므로 Body에 accessToken을 명시적으로 전달합니다.
        const { data, error } = await supabaseClient.functions.invoke(functionName, {
            headers: token ? { Authorization: `Bearer ${token}` } : undefined,
            body: { ...body, accessToken: token }
        });

        if (error) {
            getUserErrorMessage(`Admin API ${functionName} Network Error`, error);
            const wrapped = new Error(error.message || '요청 실패');
            wrapped.status = error.context?.status || 0;
            wrapped.context = error.context || null;
            throw wrapped;
        }

        if (data?.error) {
            getUserErrorMessage(`Admin API ${functionName} Business Error`, data);
            const wrapped = new Error(data.error || '요청 실패');
            wrapped.code = data.code;
            wrapped.detail = data.detail;
            wrapped.request_id = data.request_id;
            wrapped.status = data.status || 400;
            throw wrapped;
        }

        return data;
    };

    try {
        const accessToken = await getFreshAccessToken(false);
        return await call(accessToken);
    } catch (err) {
        const status = Number(err?.status || err?.context?.status || 0);
        // 401 (Unauthorized) 또는 특정 명시적 인증 실패 코드 시 1회 재시도
        if (status === 401 || err?.code === 'AUTH_FAILED' || err?.code === 'TOKEN_MISSING') {
            console.warn(`[Admin API] ${status || err?.code} detected for ${functionName}. Retrying after session refresh...`);
            try {
                const refreshedToken = await getFreshAccessToken(true);
                return await call(refreshedToken);
            } catch (retryErr) {
                getUserErrorMessage(`Admin API ${functionName} Retry Failed`, retryErr);
                throw retryErr;
            }
        }
        throw err;
    }
}

function renderDashboardMetrics(metrics = {}) {
    const activeEl = document.getElementById('metric-active-events');
    const submissionEl = document.getElementById('metric-submission-rate');
    const reviewEl = document.getElementById('metric-review-rate');

    if (activeEl) activeEl.textContent = metrics.activeCount ?? 0;
    if (submissionEl) submissionEl.textContent = `${Number(metrics.avgSubmissionRate ?? 0).toFixed(1)}%`;
    if (reviewEl) reviewEl.textContent = `${Number(metrics.avgReviewRate ?? 0).toFixed(1)}%`;
}


function ensureDepartmentStatsSection() {
    const delayedTable = document.getElementById('delayed-events-table');
    const delayedSection = delayedTable?.closest('.bg-surface-light');
    if (!delayedSection) return;

    delayedSection.innerHTML = `
        <div class="px-4 py-3 border-b border-border-light dark:border-gray-700 flex items-end justify-between gap-3">
            <div>
                <h2 class="text-base font-bold">이벤트별 부서 제출 현황</h2>
                <p class="text-xs text-text-muted mt-1">선택한 이벤트의 부서별 제출 건수를 확인합니다.</p>
            </div>
            <select id="dept-event-select" class="rounded-lg border-border-light text-sm min-w-[320px]">
                <option value="">이벤트를 선택하세요</option>
            </select>
        </div>
        <div class="p-4">
            <div id="dept-stats-chart" class="space-y-2 mb-4"></div>
            <div class="overflow-x-auto">
                <table class="min-w-full text-sm">
                    <thead class="bg-slate-50 dark:bg-slate-800/60 text-text-muted">
                        <tr>
                            <th class="px-4 py-3 text-left font-semibold">부서</th>
                            <th class="px-4 py-3 text-right font-semibold">제출 건수</th>
                        </tr>
                    </thead>
                    <tbody id="dept-stats-table" class="divide-y divide-border-light dark:divide-gray-700">
                        <tr>
                            <td colspan="2" class="px-4 py-10 text-center text-text-muted">이벤트를 선택하면 표시됩니다.</td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </div>
    `;

    const filterWrap = document.getElementById('filter-near-days')?.closest('.bg-surface-light');
    if (filterWrap) filterWrap.remove();
}

function renderDepartmentEventOptions(rows = []) {
    const select = document.getElementById('dept-event-select');
    if (!select) return;

    const sorted = [...rows].sort((a, b) => (b.totalSubmissions || 0) - (a.totalSubmissions || 0));
    select.innerHTML = '<option value="">이벤트를 선택하세요</option>' + sorted.map((row) => {
        return `<option value="${row.eventId}">${row.title || '-'} (${row.totalSubmissions || 0}건)</option>`;
    }).join('');
}

function renderDepartmentStatsByEvent(eventId) {
    const chart = document.getElementById('dept-stats-chart');
    const tbody = document.getElementById('dept-stats-table');
    if (!chart || !tbody) return;

    const target = allEventDepartmentStats.find((row) => row.eventId === eventId);
    const departments = Array.isArray(target?.departments) ? target.departments : [];

    if (!target || departments.length === 0) {
        chart.innerHTML = '<p class="text-sm text-text-muted">선택한 이벤트의 제출 데이터가 없습니다.</p>';
        tbody.innerHTML = '<tr><td colspan="2" class="px-4 py-10 text-center text-text-muted">데이터가 없습니다.</td></tr>';
        return;
    }

    const maxCount = Math.max(...departments.map((d) => Number(d.count || 0)), 1);
    chart.innerHTML = departments.map((d) => {
        const count = Number(d.count || 0);
        const ratio = Math.max(4, Math.round((count / maxCount) * 100));
        return `
            <div>
                <div class="flex items-center justify-between mb-1">
                    <span class="text-xs font-semibold text-text-main">${d.department || '부서 미지정'}</span>
                    <span class="text-xs text-text-muted">${count}건</span>
                </div>
                <div class="h-2 rounded bg-slate-100">
                    <div class="h-2 rounded bg-primary" style="width:${ratio}%"></div>
                </div>
            </div>
        `;
    }).join('');

    tbody.innerHTML = departments.map((d) => `
        <tr>
            <td class="px-4 py-3">${d.department || '부서 미지정'}</td>
            <td class="px-4 py-3 text-right font-mono">${Number(d.count || 0)}</td>
        </tr>
    `).join('');
}

function bindDepartmentEventSelect() {
    const select = document.getElementById('dept-event-select');
    if (!select || select.dataset.bound) return;
    select.addEventListener('change', (e) => renderDepartmentStatsByEvent(e.target.value));
    select.dataset.bound = 'true';
}

async function loadDepartmentStatsFallback() {
    const { data: events, error: eventsError } = await supabaseClient
        .from('events')
        .select('id, title, status')
        .order('created_at', { ascending: false });
    if (eventsError) throw eventsError;

    const { data: submissions, error: submissionsError } = await supabaseClient
        .from('submissions')
        .select('event_id, submitter_id');
    if (submissionsError) throw submissionsError;

    const { data: users, error: usersError } = await supabaseClient
        .from('users')
        .select('id, department');
    if (usersError) throw usersError;

    const userDeptMap = new Map((users || []).map((u) => [u.id, u.department || '부서 미지정']));
    const deptCountByEvent = new Map();

    (submissions || []).forEach((s) => {
        if (!deptCountByEvent.has(s.event_id)) deptCountByEvent.set(s.event_id, new Map());
        const deptMap = deptCountByEvent.get(s.event_id);
        const dept = userDeptMap.get(s.submitter_id) || '부서 미지정';
        deptMap.set(dept, (deptMap.get(dept) || 0) + 1);
    });

    return (events || []).map((event) => {
        const deptMap = deptCountByEvent.get(event.id) || new Map();
        const departments = Array.from(deptMap.entries())
            .map(([department, count]) => ({ department, count }))
            .sort((a, b) => b.count - a.count || a.department.localeCompare(b.department, 'ko'));
        return {
            eventId: event.id,
            title: event.title,
            status: event.status,
            totalSubmissions: departments.reduce((sum, row) => sum + Number(row.count || 0), 0),
            departments,
        };
    });
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
        tbody.innerHTML = '<tr><td colspan="5" class="px-4 py-10 text-center text-text-muted">현재 지연 위험 이벤트가 없습니다.</td></tr>';
        return;
    }

    const sortedRows = [...rows].sort((a, b) => {
        const aDate = a?.endDate ? new Date(a.endDate).getTime() : 0;
        const bDate = b?.endDate ? new Date(b.endDate).getTime() : 0;
        return bDate - aDate;
    });

    tbody.innerHTML = sortedRows.map((row) => {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const endDate = row.endDate ? new Date(row.endDate) : null;
        if (endDate) endDate.setHours(0, 0, 0, 0);
        const effectiveStatus = (row.status === 'closed' || (endDate && endDate < today)) ? 'closed' : row.status;
        const statusText = effectiveStatus === 'closed' ? '마감' : (effectiveStatus === 'active' ? '진행중' : '초안');
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
    try {
        const data = await invokeAdminFunction('admin-dashboard-metrics', {});
        renderDashboardMetrics(data?.metrics || {});

        allEventDepartmentStats = Array.isArray(data?.eventDepartmentStats) ? data.eventDepartmentStats : [];
        if (!allEventDepartmentStats.length) {
            allEventDepartmentStats = await loadDepartmentStatsFallback();
        }
        renderDepartmentEventOptions(allEventDepartmentStats);
        bindDepartmentEventSelect();

        const select = document.getElementById('dept-event-select');
        if (select && !select.value && allEventDepartmentStats.length > 0) {
            select.value = allEventDepartmentStats[0].eventId;
        }
        renderDepartmentStatsByEvent(select?.value || '');
    } catch (err) {
        const message = getUserErrorMessage('Admin Dashboard Metrics', err, '대시보드 지표 조회에 실패했습니다.');
        renderDashboardMetrics({});
        console.warn('[Admin] 대시보드 지표 조회 실패:', message);
        try {
            allEventDepartmentStats = await loadDepartmentStatsFallback();
            renderDepartmentEventOptions(allEventDepartmentStats);
            bindDepartmentEventSelect();
            const select = document.getElementById('dept-event-select');
            if (select && !select.value && allEventDepartmentStats.length > 0) {
                select.value = allEventDepartmentStats[0].eventId;
            }
            renderDepartmentStatsByEvent(select?.value || '');
        } catch (fallbackErr) {
            console.error('[Admin] 부서 제출 현황 조회 실패:', fallbackErr);
            allEventDepartmentStats = [];
            renderDepartmentEventOptions([]);
            renderDepartmentStatsByEvent('');
        }
    }
}

async function loadEmployees() {
    try {
        const data = await invokeAdminFunction('admin-manage-user-role', { action: 'list' });
        allEmployees = Array.isArray(data?.employees) ? data.employees : [];
        renderEmployees();
    } catch (err) {
        const message = getUserErrorMessage('Admin Employee List', err, '직원 목록 조회에 실패했습니다.');
        alert(`직원 목록 조회 실패: ${message}`);
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
        const message = getUserErrorMessage('Admin Audit Logs', err, '감사 로그 조회에 실패했습니다.');
        tbody.innerHTML = `<tr><td colspan="5" class="px-4 py-10 text-center text-red-500">${message}</td></tr>`;
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

function applyAdminLayoutAdjustments() {
    // 관리자 감사 로그를 권한 관리 섹션 위로 이동
    const auditSection = document.getElementById('audit-log-table')?.closest('.mt-8');
    const roleHeaderSection = document.getElementById('stat-total')?.closest('.flex.flex-col');
    if (auditSection && roleHeaderSection && roleHeaderSection.parentNode) {
        roleHeaderSection.parentNode.insertBefore(auditSection, roleHeaderSection);
        auditSection.classList.remove('mt-8');
        auditSection.classList.add('mb-6');
    }

    // 심사 통계 섹션 제거
    const judgeStatsSection = document.getElementById('judge-stats-table')?.closest('.mt-8');
    if (judgeStatsSection) {
        judgeStatsSection.remove();
    }

    // 권한 관리 테이블 자체 스크롤
    const roleTableWrap = document.getElementById('admin-user-table')?.closest('.overflow-x-auto');
    if (roleTableWrap) {
        roleTableWrap.classList.add('overflow-y-auto');
        roleTableWrap.style.maxHeight = '380px';
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    const user = await requireAdminSession();
    if (!user) return;

    applyAdminLayoutAdjustments();
    ensureDepartmentStatsSection();

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

    await Promise.all([
        loadEmployees(),
        loadDashboardMetrics(),
        loadAuditLogs(),
    ]);
});




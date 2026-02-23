let allEmployees = [];

async function requireAdminSession() {
    if (!window.supabaseClient) return null;

    const { data: { session } } = await supabaseClient.auth.getSession();
    if (!session?.user) {
        window.location.href = 'login.html';
        return null;
    }

    const roleFromMeta = session.user.user_metadata?.role;
    if (roleFromMeta === 'admin') return session.user;

    const { data: me } = await supabaseClient
        .from('users')
        .select('role')
        .eq('id', session.user.id)
        .maybeSingle();

    if (me?.role !== 'admin') {
        alert('관리자만 접근할 수 있습니다.');
        window.location.href = 'dashboard.html';
        return null;
    }

    return session.user;
}

async function loadEmployees() {
    const { data, error } = await supabaseClient.functions.invoke('admin-manage-user-role', {
        body: { action: 'list' }
    });

    if (error || data?.error) {
        const msg = data?.error || error?.message || '목록 조회 실패';
        console.error('[Admin] 직원 목록 조회 실패:', msg);
        alert(`직원 목록 조회 실패: ${msg}`);
        return;
    }

    allEmployees = Array.isArray(data?.employees) ? data.employees : [];
    renderEmployees();
}

function updateStats(rows) {
    document.getElementById('stat-total').textContent = rows.length;
    document.getElementById('stat-admin').textContent = rows.filter((r) => r.role === 'admin').length;
}

function getRoleBadge(role) {
    if (role === 'admin') {
        return '<span class="inline-flex px-2.5 py-1 rounded-full text-xs font-semibold bg-primary-light text-primary">관리자</span>';
    }
    if (role === 'judge') {
        return '<span class="inline-flex px-2.5 py-1 rounded-full text-xs font-semibold bg-blue-50 text-blue-700">심사위원</span>';
    }
    return '<span class="inline-flex px-2.5 py-1 rounded-full text-xs font-semibold bg-slate-100 text-slate-700">일반</span>';
}

function renderEmployees() {
    const keyword = (document.getElementById('employee-search')?.value || '').trim().toLowerCase();
    const filtered = allEmployees.filter((e) => {
        const hay = `${e.empno || ''} ${e.empnm || ''} ${e.depnm || ''}`.toLowerCase();
        return hay.includes(keyword);
    });

    updateStats(filtered);

    const tbody = document.getElementById('admin-user-table');
    if (!filtered.length) {
        tbody.innerHTML = '<tr><td colspan="5" class="px-4 py-10 text-center text-text-muted">검색 결과가 없습니다.</td></tr>';
        return;
    }

    tbody.innerHTML = filtered.map((e) => {
        const toRole = e.role === 'admin' ? 'submitter' : 'admin';
        const buttonLabel = e.role === 'admin' ? '관리자 해제' : '관리자로 변경';
        const buttonClass = e.role === 'admin'
            ? 'border-slate-300 text-slate-700 hover:bg-slate-100'
            : 'border-primary text-primary hover:bg-primary-light';

        return `
            <tr>
                <td class="px-4 py-3 font-mono">${e.empno || '-'}</td>
                <td class="px-4 py-3 font-medium">${e.empnm || '-'}</td>
                <td class="px-4 py-3 text-text-muted">${e.depnm || '-'}</td>
                <td class="px-4 py-3">${getRoleBadge(e.role)}</td>
                <td class="px-4 py-3 text-right">
                    <button
                        class="inline-flex items-center rounded-md border px-3 py-1.5 text-xs font-semibold transition-colors ${buttonClass}"
                        onclick="changeEmployeeRole('${e.empno}', '${toRole}')">
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

    const { data, error } = await supabaseClient.functions.invoke('admin-judgment-analytics', {
        body: {}
    });

    if (error || data?.error) {
        const msg = data?.error || error?.message || '심사 통계 조회 실패';
        console.error('[Admin] 심사 통계 조회 실패:', msg);
        tbody.innerHTML = `<tr><td colspan="5" class="px-4 py-10 text-center text-red-500">${msg}</td></tr>`;
        return;
    }

    const stats = Array.isArray(data?.stats) ? data.stats : [];
    if (stats.length === 0) {
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

window.changeEmployeeRole = async (empno, nextRole) => {
    const confirmMsg = nextRole === 'admin'
        ? `${empno} 사원을 관리자로 변경하시겠습니까?`
        : `${empno} 사원의 관리자 권한을 해제하시겠습니까?`;
    if (!confirm(confirmMsg)) return;

    const adminCode = prompt('관리자 인증 코드를 입력하세요.');
    if (!adminCode) return;

    const { data, error } = await supabaseClient.functions.invoke('admin-manage-user-role', {
        body: { action: 'update_role', empno, nextRole, adminCode }
    });

    if (error || data?.error) {
        const msg = data?.error || error?.message || '권한 변경 실패';
        console.error('[Admin] 권한 변경 실패:', msg);
        alert(`권한 변경 실패: ${msg}`);
        return;
    }

    alert('권한이 변경되었습니다.');
    await loadEmployees();
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

    const searchInput = document.getElementById('employee-search');
    if (searchInput) {
        searchInput.addEventListener('input', renderEmployees);
    }

    await loadEmployees();
    await loadJudgeStats();
});

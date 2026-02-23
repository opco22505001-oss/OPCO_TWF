// 이벤트 상세 페이지: 댓글 및 좋아요 기능 처리

document.addEventListener('DOMContentLoaded', async () => {
    // URL에서 event ID 가져오기 (main.js의 유틸리티 함수 사용)
    const eventId = getQueryParam('id');
    if (!eventId) return; // event-detail.html 자체 로직에서 리다이렉트 처리하므로 여기선 중단

    // 좋아요 및 댓글 데이터 로드
    await loadLikeStatus(eventId);
    await loadComments(eventId);

    // 이벤트 리스너 등록
    document.getElementById('like-btn').addEventListener('click', () => toggleLike(eventId));
    document.getElementById('comment-form').addEventListener('submit', (e) => handleCommentSubmit(e, eventId));
});

// === 좋아요 기능 ===
async function loadLikeStatus(eventId) {
    if (!supabaseClient) return;

    // 1. 전체 좋아요 수 조회
    const { count, error: countError } = await supabaseClient
        .from('likes')
        .select('*', { count: 'exact', head: true })
        .eq('target_id', eventId)
        .eq('target_type', 'event');

    if (!countError) {
        document.getElementById('like-count').textContent = count;
    }

    // 2. 현재 사용자의 좋아요 여부 확인 (로그인 상태인 경우)
    const { data: sessionData } = await supabaseClient.auth.getSession();
    const user = sessionData?.session?.user;

    if (user) {
        const { data, error } = await supabaseClient
            .from('likes')
            .select('id')
            .eq('target_id', eventId)
            .eq('target_type', 'event')
            .eq('user_id', user.id)
            .maybeSingle();

        if (data) {
            // 이미 좋아요 누름
            const icon = document.getElementById('like-icon');
            icon.textContent = 'favorite'; // 꽉 찬 하트
            icon.classList.add('text-red-500');
            document.getElementById('like-btn').classList.add('bg-white/20');
        }
    }
}

async function toggleLike(eventId) {
    if (!supabaseClient) return;

    // 로그인 체크
    const { data: sessionData } = await supabaseClient.auth.getSession();
    const user = sessionData?.session?.user;

    if (!user) {
        alert('로그인이 필요한 기능입니다.');
        window.location.href = 'login.html';
        return;
    }

    // 현재 상태 확인 (UI 기반)
    const icon = document.getElementById('like-icon');
    const isLiked = icon.textContent === 'favorite';

    try {
        if (isLiked) {
            // 좋아요 취소 (삭제)
            const { error } = await supabaseClient
                .from('likes')
                .delete()
                .eq('target_id', eventId)
                .eq('target_type', 'event')
                .eq('user_id', user.id);

            if (error) throw error;

            // UI 업데이트
            icon.textContent = 'favorite_border';
            icon.classList.remove('text-red-500');
            document.getElementById('like-btn').classList.remove('bg-white/20');

            // 카운트 감소
            const countEl = document.getElementById('like-count');
            countEl.textContent = Math.max(0, parseInt(countEl.textContent) - 1);

        } else {
            // 좋아요 추가 (등록)
            const { error } = await supabaseClient
                .from('likes')
                .insert({
                    user_id: user.id,
                    target_id: eventId,
                    target_type: 'event'
                });

            if (error) throw error;

            // UI 업데이트
            icon.textContent = 'favorite';
            icon.classList.add('text-red-500');
            document.getElementById('like-btn').classList.add('bg-white/20');

            // 카운트 증가
            const countEl = document.getElementById('like-count');
            countEl.textContent = parseInt(countEl.textContent) + 1;
        }
    } catch (error) {
        console.error('좋아요 처리 오류:', error);
        alert('처리 중 오류가 발생했습니다.');
    }
}

// === 댓글 기능 ===
async function loadComments(eventId) {
    if (!supabaseClient) return;

    // 댓글 목록 및 작성자 정보 조회
    const { data: comments, error } = await supabaseClient
        .from('comments')
        .select(`
            *,
            users (
                name,
                department
            )
        `)
        .eq('target_id', eventId)
        .eq('target_type', 'event')
        .order('created_at', { ascending: false });

    if (error) {
        console.error('댓글 조회 오류:', error);
        return;
    }

    renderComments(comments);
}

function renderComments(comments) {
    const listEl = document.getElementById('comment-list');
    const countEl = document.getElementById('comment-count');

    countEl.textContent = comments.length;
    listEl.innerHTML = '';

    if (comments.length === 0) {
        listEl.innerHTML = '<p class="text-center text-text-muted py-4">첫 번째 댓글을 남겨보세요!</p>';
        return;
    }

    // 현재 사용자 확인 (삭제 버튼 표시용)
    supabaseClient.auth.getUser().then(({ data: { user } }) => {
        const currentUserId = user?.id;

        comments.forEach(comment => {
            const isMyComment = currentUserId && comment.user_id === currentUserId;
            // 닉네임이 없으면 '익명' 대신 user.email 앞부분이나 '알 수 없음' 사용 (users 테이블에 name이 nullable일 수 있음)
            const authorName = comment.users?.name || '사용자';
            const authorDept = comment.users?.department || '';
            const date = new Date(comment.created_at).toLocaleString('ko-KR', {
                year: '2-digit', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'
            });

            const commentEl = document.createElement('div');
            commentEl.className = 'flex gap-4 group';
            commentEl.innerHTML = `
                <div class="h-10 w-10 rounded-full bg-slate-200 flex items-center justify-center text-text-muted font-bold text-sm shrink-0">
                    ${authorName.substring(0, 1)}
                </div>
                <div class="flex-1">
                    <div class="flex items-center justify-between mb-1">
                        <div class="flex items-center gap-2">
                            <span class="font-bold text-text-main dark:text-white text-sm">${authorName}</span>
                            ${authorDept ? `<span class="text-xs text-text-muted px-1.5 py-0.5 bg-slate-100 dark:bg-gray-700 rounded">${authorDept}</span>` : ''}
                            <span class="text-xs text-text-muted ml-1">${date}</span>
                        </div>
                        ${isMyComment ? `
                            <button onclick="deleteComment('${comment.id}', '${comment.target_id}')" class="opacity-0 group-hover:opacity-100 transition-opacity text-xs text-red-500 hover:underline">
                                삭제
                            </button>
                        ` : ''}
                    </div>
                    <p class="text-sm text-text-main dark:text-gray-300 leading-relaxed whitespace-pre-line">${escapeHtml(comment.content)}</p>
                </div>
            `;
            listEl.appendChild(commentEl);
        });
    });
}

function escapeHtml(text) {
    if (!text) return '';
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

async function handleCommentSubmit(e, eventId) {
    e.preventDefault();
    if (!supabaseClient) return;

    const inputEl = document.getElementById('comment-input');
    const content = inputEl.value.trim();

    if (!content) return;

    // 로그인 체크
    const { data: { user } } = await supabaseClient.auth.getUser();
    if (!user) {
        alert('로그인이 필요한 기능입니다.');
        window.location.href = 'login.html';
        return;
    }

    try {
        const { error } = await supabaseClient
            .from('comments')
            .insert({
                user_id: user.id,
                target_id: eventId,
                target_type: 'event',
                content: content
            });

        if (error) throw error;

        // 입력창 초기화 및 목록 갱신
        inputEl.value = '';
        await loadComments(eventId);

    } catch (error) {
        console.error('댓글 등록 오류:', error);
        alert('댓글 등록 중 오류가 발생했습니다.');
    }
}

// 전역 함수로 노출 (HTML onclick 속성에서 접근 가능하도록)
window.deleteComment = async function (commentId, eventId) {
    if (!confirm('댓글을 삭제하시겠습니까?')) return;

    try {
        const { error } = await supabaseClient
            .from('comments')
            .delete()
            .eq('id', commentId);

        if (error) throw error;

        await loadComments(eventId);

    } catch (error) {
        console.error('댓글 삭제 오류:', error);
        alert('댓글 삭제 중 오류가 발생했습니다.');
    }
};

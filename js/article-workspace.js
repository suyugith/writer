// Integration with the existing editor, persistence and history controls.
let articleLibrary = null;
let articleRequestPending = false;
let articlePersistencePaused = false;
let articleDeletionPending = false;
let refArticleId = null;
let llmHistoryArticleId = null;

function getManagementArticle(kind) {
    const id = kind === 'ref' ? refArticleId : llmHistoryArticleId;
    return articleLibrary?.articles.find(article => article.id === id) || articleLibrary?.current;
}

function renderArticleSelector(kind) {
    const article = getManagementArticle(kind);
    const select = document.getElementById(`${kind}-article-select`);
    select.replaceChildren();
    if (!article) return;
    for (const candidate of [...articleLibrary.articles].reverse()) {
        const option = document.createElement('option');
        option.value = candidate.id;
        option.textContent = candidate.title + (candidate.id === articleLibrary.activeId ? '（当前文章）' : '');
        select.appendChild(option);
    }
    select.value = article.id;
    select.title = article.title;
    document.getElementById(`${kind}-current-article`).disabled = article.id === articleLibrary.activeId;
    if (kind === 'llm-history') {
        document.getElementById('llm-history-article-name').textContent =
            `${article.id === articleLibrary.activeId ? '当前文章' : '正在查看'}：${article.title} · 最多保留 99 条记录`;
    }
}

function selectManagementArticle(kind, id = articleLibrary?.activeId) {
    if (!articleLibrary?.articles.some(article => article.id === id)) return;
    if (kind === 'ref') {
        refArticleId = id;
        currentRefIndex = -1;
        selectRef(-1);
        renderRefList();
    } else {
        llmHistoryArticleId = id;
        renderLLMSubmissionHistory();
    }
    renderArticleSelector(kind);
}

async function initializeArticles() {
    const stored = await dbGet('writer_articles');
    const needsSharedDataMigration = !stored || (stored.schemaVersion || 1) < 2;
    if (stored && Array.isArray(stored.articles) && stored.articles.length) {
        articleLibrary = new ArticleLibrary(stored);
    } else {
        const [texts, times, stars] = await Promise.all([
            dbGet('writer_history'), dbGet('writer_history_times'), dbGet('writer_history_stars')
        ]);
        if (Array.isArray(texts) && texts.length) {
            articleLibrary = ArticleLibrary.migrate(texts, times, stars, interactionHistory);
        } else {
            articleLibrary = new ArticleLibrary();
            articleLibrary.create();
        }
    }
    if (needsSharedDataMigration) {
        // Old shared data has no reliable article ID. Adopt it once into the active
        // article, never copy it into every article or revive it after a clear.
        const [references, submissions] = await Promise.all([
            dbGet('writer_ref_data_list'), dbGet('writer_llm_submissions')
        ]);
        if (Array.isArray(references) && !articleLibrary.current.references.length) {
            articleLibrary.current.references = references;
        }
        if (Array.isArray(submissions) && !articleLibrary.current.submissions.length) {
            articleLibrary.current.submissions = submissions;
        }
        // Legacy keys are retained as a migration safety copy, but no longer read.
        if (!await persistArticles()) {
            articleLibrary = null;
            throw new Error('文章库保存失败');
        }
    }
    bindActiveArticle(true);
}

function bindActiveArticle(loadText = false) {
    const article = articleLibrary?.current;
    if (!article) return;
    history = article.history;
    historyTimes = article.times;
    historyStars = article.stars;
    historyIndex = article.index;
    interactionHistory = article.interactions;
    refDataList = article.references;
    llmSubmissions = article.submissions;
    if (loadText) {
        refArticleId = llmHistoryArticleId = article.id;
        editor.value = history[historyIndex] || '';
        currentRefIndex = -1;
        selectRef(-1);
        lastLLMReq = lastLLMRes = lastLLMErr = '';
        statusIcon.className = 'status-icon idle';
        statusIcon.title = '未调用';
        document.getElementById('llm-stats').textContent = '耗时: 0ms | 输入: 0 Tokens | 输出: 0 Tokens';
    }
    renderArticleSelector('ref');
    renderArticleSelector('llm-history');
    document.getElementById('current-article-name').textContent = article.title;
    document.getElementById('current-article-name').title = '全屏阅读：' + article.title;
    saveTimeEl.textContent = `最后保存: ${formatHistoryTime(article.updatedAt)}`;
}

async function persistArticles() {
    if (!articleLibrary || articlePersistencePaused) return false;
    try {
        await dbSet('writer_articles', articleLibrary.toJSON());
        return true;
    } catch (error) {
        saveTimeEl.textContent = '保存失败，请勿关闭页面';
        console.error('Article save failed:', error);
        return false;
    }
}

function articleChangeBlocked() {
    if (articleDeletionPending) {
        showAlert('正在删除文章，请稍后重试。');
        return true;
    }
    if (!articleLibrary) {
        showAlert('文章数据尚未加载完成，请稍后重试。');
        return true;
    }
    if (articleRequestPending || editor.readOnly) {
        showAlert('AI 正在修改当前文章，请等待完成或停止后再切换文章。');
        return true;
    }
    return false;
}

async function flushCurrentArticle() {
    clearTimeout(timeout);
    return saveState(editor.value);
}

async function createArticle(text = '', title = '') {
    if (articleChangeBlocked()) return false;
    if (!await flushCurrentArticle()) return false;
    if (articleChangeBlocked()) return false;
    articleLibrary.create(text, title);
    bindActiveArticle(true);
    currentSelectedHistoryIndex = -1;
    editor.scrollTop = 0;
    preview.scrollTop = 0;
    document.getElementById('floating-toolbar').classList.add('hidden-by-default');
    updateUI();
    if (!await persistArticles()) return false;
    closeAllDropdowns();
    closeModal();
    if (!isPreviewMode) editor.focus();
    return true;
}

async function switchArticle(id) {
    if (id === articleLibrary?.activeId || articleChangeBlocked()) return;
    if (!await flushCurrentArticle()) return;
    if (articleChangeBlocked()) return;
    if (!articleLibrary.switchTo(id)) return;
    currentSelectedHistoryIndex = -1;
    bindActiveArticle(true);
    editor.scrollTop = 0;
    preview.scrollTop = 0;
    document.getElementById('floating-toolbar').classList.add('hidden-by-default');
    await persistArticles();
    updateUI();
    renderArticleList();
    renderHistoryList();
}

function renderArticleList() {
    const container = document.getElementById('article-list-container');
    container.replaceChildren();
    if (!articleLibrary) return;
    document.getElementById('article-count').textContent = articleLibrary.articles.length;
    for (const article of [...articleLibrary.articles].reverse()) {
        const row = document.createElement('div');
        row.className = 'article-row';
        const item = document.createElement('button');
        item.className = 'article-item' + (article.id === articleLibrary.activeId ? ' active' : '');
        item.setAttribute('aria-pressed', String(article.id === articleLibrary.activeId));
        const title = document.createElement('strong');
        title.textContent = article.title;
        title.title = article.title;
        const meta = document.createElement('span');
        meta.textContent = `${article.history.length} 个版本 · ${formatHistoryTime(article.updatedAt)}`;
        const status = document.createElement('small');
        status.textContent = article.id === articleLibrary.activeId ? '正在编辑' : '点击切换文章';
        item.append(title, meta, status);
        item.onclick = () => switchArticle(article.id);
        const remove = document.createElement('button');
        remove.className = 'article-delete-btn delete-action';
        remove.innerHTML = '<svg class="ui-icon" aria-hidden="true"><use href="#icon-trash"></use></svg>';
        remove.title = `删除文章「${article.title}」`;
        remove.setAttribute('aria-label', remove.title);
        remove.onclick = () => deleteArticle(article.id);
        row.append(item, remove);
        container.appendChild(row);
    }
}

async function deleteArticle(id) {
    if (articleChangeBlocked()) return false;
    const article = articleLibrary.articles.find(item => item.id === id);
    if (!article) return false;
    const ok = await showConfirm(`确定删除文章「${article.title}」？\n将一并删除全部 ${article.history.length} 个版本、${article.references.length} 项参考资料和 ${article.submissions.length} 条 AI 修改记录，此操作不可恢复。` +
        (articleLibrary.articles.length === 1 ? '\n删除后将新建一篇空白文章。' : ''));
    if (!ok) { showModal('history-modal'); return false; }
    if (articleChangeBlocked() || !await flushCurrentArticle() || articleChangeBlocked()) return false;
    const previousArticles = articleLibrary.articles.slice();
    const previousActiveId = articleLibrary.activeId;
    if (!articleLibrary.deleteArticle(id)) return false;
    articleDeletionPending = true;
    editor.readOnly = true;
    const saved = await persistArticles();
    articleDeletionPending = false;
    editor.readOnly = false;
    if (!saved) {
        articleLibrary.articles = previousArticles;
        articleLibrary.activeId = previousActiveId;
        showModal('history-modal');
        return false;
    }
    if (previousActiveId === id) {
        currentSelectedHistoryIndex = -1;
        bindActiveArticle(true);
        editor.scrollTop = preview.scrollTop = 0;
        document.getElementById('floating-toolbar').classList.add('hidden-by-default');
        updateUI();
    } else {
        renderArticleSelector('ref');
        renderArticleSelector('llm-history');
    }
    showModal('history-modal');
    renderHistoryList();
    return true;
}

async function renameCurrentArticle() {
    if (!articleLibrary) return;
    const input = document.getElementById('history-article-title');
    const title = input.value.trim().slice(0, 60);
    if (!title) { input.value = articleLibrary.current.title; return; }
    articleLibrary.current.title = title;
    bindActiveArticle();
    await persistArticles();
    renderArticleList();
}

// Flush the pending five-second autosave when the page leaves the foreground.
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && articleLibrary && !articleRequestPending && !articlePersistencePaused) flushCurrentArticle();
});
window.addEventListener('pagehide', () => {
    if (articleLibrary && !articleRequestPending && !articlePersistencePaused) flushCurrentArticle();
});

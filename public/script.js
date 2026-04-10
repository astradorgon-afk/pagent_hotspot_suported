const API_BASE = '/api';

let socketInstance = null;

const adminState = {
    contestants: [],
    judges: [],
    categories: [],
};

const eliminationState = {
    contestants: [],
    leaderboard: [],
    filter: 'all',
    selectedIds: new Set(),
};

const judgeState = {
    categories: [],
    contestants: [],
    scoresMap: {},
    activeCategoryId: null,
};

document.addEventListener('DOMContentLoaded', () => {
    const page = document.body.dataset.page;

    if (page === 'home') {
        initHomePage();
        return;
    }

    if (page === 'admin') {
        initAdminPage();
        return;
    }

    if (page === 'elimination') {
        initEliminationPage();
        return;
    }

    if (page === 'judge') {
        initJudgePage();
    }
});

function initSocket() {
    if (socketInstance || typeof io !== 'function') return socketInstance;

    socketInstance = io();
    socketInstance.on('leaderboard_update', renderLeaderboard);
    return socketInstance;
}

function initLiveLeaderboard() {
    initSocket();
    request('/leaderboard').then(renderLeaderboard).catch(() => {});
}

async function request(path, options = {}) {
    const config = { credentials: 'include', ...options };

    if (config.body && !(config.body instanceof FormData)) {
        config.headers = {
            'Content-Type': 'application/json',
            ...(config.headers || {}),
        };

        if (typeof config.body !== 'string') {
            config.body = JSON.stringify(config.body);
        }
    }

    const response = await fetch(`${API_BASE}${path}`, config);
    const contentType = response.headers.get('content-type') || '';
    const payload = contentType.includes('application/json')
        ? await response.json()
        : await response.text();

    if (!response.ok) {
        const error = new Error(payload?.message || payload || 'Request failed.');
        error.status = response.status;
        error.payload = payload;
        throw error;
    }

    return payload;
}

function setStatus(target, message = '', tone = 'info') {
    const element = typeof target === 'string' ? document.getElementById(target) : target;
    if (!element) return;

    element.textContent = message;
    if (message) {
        element.dataset.tone = tone;
    } else {
        element.removeAttribute('data-tone');
    }
}

function clearStatuses(ids) {
    ids.forEach(id => setStatus(id, ''));
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
    }[char]));
}

function normalizeAssetPath(assetPath) {
    if (!assetPath) return '';
    return `/${String(assetPath).replace(/^[\\/]+/, '').replace(/\\/g, '/')}`;
}

function nowLabel() {
    return new Intl.DateTimeFormat(undefined, {
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
    }).format(new Date());
}

function isValidScoreValue(value) {
    if (value === '' || value === null || value === undefined) return false;

    const normalized = typeof value === 'string' ? value.trim() : value;
    if (normalized === '') return false;

    const numeric = Number(normalized);
    return Number.isFinite(numeric) && numeric >= 0 && numeric <= 100;
}

function getScoreKey(categoryId, contestantId) {
    return `${categoryId}:${contestantId}`;
}

function parseScoreNumber(value) {
    if (!isValidScoreValue(value)) return null;
    return Number(Number(value).toFixed(2));
}

function getCategoryStats(categoryId) {
    const total = judgeState.contestants.length;
    const completed = judgeState.contestants.reduce((count, contestant) => {
        const key = getScoreKey(categoryId, contestant.id);
        return count + (isValidScoreValue(judgeState.scoresMap[key]) ? 1 : 0);
    }, 0);

    return { total, completed };
}

function focusScoreInput(categoryId, contestantId) {
    const selector = `.score-input[data-category-id="${categoryId}"][data-contestant-id="${contestantId}"]`;
    document.querySelector(selector)?.focus();
}

function setActiveJudgeCategory(categoryId, focusContestantId = null) {
    const category = judgeState.categories.find(item => item.id === categoryId);
    if (!category) return;

    judgeState.activeCategoryId = category.id;
    renderJudgeSummary();
    renderJudgeScoreSheet();

    if (focusContestantId !== null) {
        focusScoreInput(category.id, focusContestantId);
    }
}

function renderLeaderboard(data) {
    const container = document.getElementById('leaderboard');
    if (!container) return;

    const status = document.getElementById('leaderboardStatus');
    if (status) {
        status.textContent = `Updated ${nowLabel()}`;
    }

    if (!Array.isArray(data) || !data.length) {
        container.innerHTML = '<div class="empty-state">No scores have been submitted yet.</div>';
        return;
    }

    const rows = data.map((entry, index) => {
        const rankClass =
            index === 0 ? 'is-first' : index === 1 ? 'is-second' : index === 2 ? 'is-third' : '';
        const coverage = entry.judge_total
            ? `${entry.judges_scored}/${entry.judge_total} judges`
            : 'No judges yet';

        return `
            <tr class="leaderboard-row ${index < 3 ? 'is-top-three' : ''}">
                <td><span class="rank-badge ${rankClass}">${index + 1}</span></td>
                <td><div class="leaderboard-name">${escapeHtml(entry.contestant_name)}</div></td>
                <td class="fw-bold">${Number(entry.final_score || 0).toFixed(2)}%</td>
                <td><span class="leaderboard-meta">${coverage}</span></td>
            </tr>
        `;
    }).join('');

    container.innerHTML = `
        <div class="table-responsive">
            <table class="table leaderboard-table align-middle">
                <thead>
                    <tr>
                        <th scope="col">Rank</th>
                        <th scope="col">Contestant</th>
                        <th scope="col">Score</th>
                        <th scope="col">Coverage</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        </div>
    `;
}

function initHomePage() {
    initLiveLeaderboard();
    document.getElementById('judgeLoginForm')?.addEventListener('submit', handleJudgeLogin);
    document.getElementById('judgeUsername')?.focus();

    request('/judge/session')
        .then(() => {
            window.location.href = 'judge.html';
        })
        .catch(() => {});
}

async function handleJudgeLogin(event) {
    event.preventDefault();

    const username = document.getElementById('judgeUsername').value.trim();
    const password = document.getElementById('judgePassword').value;

    setStatus('loginMessage', '');

    try {
        await request('/judge/login', {
            method: 'POST',
            body: { username, password },
        });

        window.location.href = 'judge.html';
    } catch (error) {
        setStatus('loginMessage', error.message, 'danger');
    }
}

function initAdminPage() {
    initLiveLeaderboard();
    bindAdminEvents();

    request('/admin/session')
        .then(async () => {
            showAdminContent(true);
            await loadAdminData();
        })
        .catch(error => {
            showAdminContent(false);
            if (error.status && error.status !== 401) {
                setStatus('adminLoginMessage', 'Unable to restore the admin session.', 'warning');
            }
        });
}

function bindAdminEvents() {
    document.getElementById('adminLoginForm')?.addEventListener('submit', handleAdminLogin);
    document.getElementById('adminLogoutBtn')?.addEventListener('click', handleAdminLogout);
    document.getElementById('addContestantForm')?.addEventListener('submit', handleAddContestant);
    document.getElementById('addJudgeForm')?.addEventListener('submit', handleAddJudge);
    document.getElementById('addCategoryForm')?.addEventListener('submit', handleAddCategory);
    document.getElementById('changeAdminPasswordForm')?.addEventListener('submit', handleAdminPasswordChange);
    document.getElementById('resetJudgePasswordForm')?.addEventListener('submit', handleJudgePasswordReset);
    document.getElementById('deleteAllDataBtn')?.addEventListener('click', handleDeleteAllData);

    document.getElementById('contestantsList')?.addEventListener('click', handleContestantListClick);
    document.getElementById('judgesList')?.addEventListener('click', handleJudgeListClick);
    document.getElementById('categoriesList')?.addEventListener('click', handleCategoryListClick);
}

function showAdminContent(show) {
    document.getElementById('adminLogin')?.classList.toggle('d-none', show);
    document.getElementById('adminContent')?.classList.toggle('d-none', !show);

    if (!show) {
        clearStatuses([
            'adminLoginMessage',
            'contestantsMessage',
            'judgesMessage',
            'categoriesMessage',
            'adminPassMessage',
            'judgePassResetMsg',
            'dangerZoneMessage',
        ]);
    }
}

async function loadAdminData() {
    const [contestants, judges, categories] = await Promise.all([
        request('/admin/contestants'),
        request('/admin/judges'),
        request('/admin/categories'),
    ]);

    adminState.contestants = contestants;
    adminState.judges = judges;
    adminState.categories = categories;

    renderAdminSummary();
    renderContestantsList();
    renderJudgesList();
    renderCategoriesList();
}

function renderAdminSummary() {
    const activeContestants = adminState.contestants.filter(contestant => !contestant.eliminated);
    const totalWeight = adminState.categories.reduce(
        (sum, category) => sum + Number(category.percentage || 0),
        0
    );

    document.getElementById('summaryContestants').textContent = activeContestants.length;
    document.getElementById('summaryJudges').textContent = adminState.judges.length;
    document.getElementById('summaryCategories').textContent = adminState.categories.length;
    document.getElementById('summaryWeight').textContent = `${totalWeight}%`;
    document.getElementById('totalPercentage').textContent = `${totalWeight}%`;

    const remaining = 100 - totalWeight;
    const isBalanced = totalWeight === 100;
    const helperText = isBalanced
        ? 'Scoring weights are balanced and ready for judging.'
        : remaining > 0
            ? `Add ${remaining}% more weight to complete the scoring rubric.`
            : `Reduce the scoring rubric by ${Math.abs(remaining)}% to get back to 100%.`;

    const summaryHint = document.getElementById('weightSummaryHint');
    const categoryHelper = document.getElementById('categoryWeightHelper');

    summaryHint.textContent = helperText;
    categoryHelper.textContent = helperText;
    summaryHint.classList.toggle('metric-alert', !isBalanced);
    categoryHelper.classList.toggle('metric-alert', !isBalanced);
}

function renderContestantsList() {
    const container = document.getElementById('contestantsList');
    if (!container) return;

    if (!adminState.contestants.length) {
        container.innerHTML = '<div class="empty-state">No contestants yet.</div>';
        return;
    }

    const contestants = [...adminState.contestants].sort((left, right) => {
        if (left.eliminated !== right.eliminated) {
            return Number(left.eliminated) - Number(right.eliminated);
        }

        return left.id - right.id;
    });

    container.innerHTML = contestants.map(contestant => {
        const imageMarkup = contestant.image_path
            ? `<div class="entity-thumb"><img src="${normalizeAssetPath(contestant.image_path)}" alt="${escapeHtml(contestant.name)}"></div>`
            : '<div class="entity-thumb is-placeholder"><i class="fa-regular fa-image"></i></div>';
        const statusText = contestant.eliminated ? 'Eliminated' : 'Active';

        return `
            <div class="entity-row ${contestant.eliminated ? 'is-eliminated' : ''}">
                <div class="entity-info">
                    ${imageMarkup}
                    <div>
                        <div class="entity-name">${escapeHtml(contestant.name)}</div>
                        <div class="entity-meta">
                            Contestant #${contestant.id}
                            <span class="entity-status ${contestant.eliminated ? 'is-eliminated' : 'is-active'}">${statusText}</span>
                        </div>
                    </div>
                </div>
                <div class="entity-actions">
                    <button type="button" class="btn btn-outline-secondary btn-sm" data-action="edit" data-id="${contestant.id}">
                        <i class="fa-solid fa-pen-to-square"></i>
                    </button>
                </div>
            </div>
        `;
    }).join('');
}

function renderJudgesList() {
    const container = document.getElementById('judgesList');
    const select = document.getElementById('judgeToReset');
    const resetButton = document.querySelector('#resetJudgePasswordForm button[type="submit"]');

    if (container) {
        container.innerHTML = adminState.judges.length
            ? adminState.judges.map(judge => `
                <div class="entity-row">
                    <div class="entity-info">
                        <div>
                            <div class="entity-name">${escapeHtml(judge.name)}</div>
                            <div class="entity-meta">@${escapeHtml(judge.username)}</div>
                        </div>
                    </div>
                    <div class="entity-actions">
                        <button type="button" class="btn btn-outline-secondary btn-sm" data-action="edit" data-id="${judge.id}">
                            <i class="fa-solid fa-pen-to-square"></i>
                        </button>
                        <button type="button" class="btn btn-outline-danger btn-sm" data-action="delete" data-id="${judge.id}">
                            <i class="fa-solid fa-trash"></i>
                        </button>
                    </div>
                </div>
            `).join('')
            : '<div class="empty-state">No judge accounts yet.</div>';
    }

    if (!select) return;

    if (adminState.judges.length) {
        select.innerHTML = adminState.judges.map(judge => `
            <option value="${judge.id}">${escapeHtml(judge.name)} (@${escapeHtml(judge.username)})</option>
        `).join('');
        select.disabled = false;
        if (resetButton) resetButton.disabled = false;
        return;
    }

    select.innerHTML = '<option value="">No judges available</option>';
    select.disabled = true;
    if (resetButton) resetButton.disabled = true;
}

function renderCategoriesList() {
    const container = document.getElementById('categoriesList');
    if (!container) return;

    if (!adminState.categories.length) {
        container.innerHTML = '<div class="empty-state">No categories yet.</div>';
        return;
    }

    container.innerHTML = adminState.categories.map(category => `
        <div class="entity-row">
            <div class="entity-info">
                <div>
                    <div class="entity-name">${escapeHtml(category.name)}</div>
                    <div class="entity-meta">${Number(category.percentage)}% of the final score</div>
                </div>
            </div>
            <div class="entity-actions">
                <button type="button" class="btn btn-outline-secondary btn-sm" data-action="edit" data-id="${category.id}">
                    <i class="fa-solid fa-pen-to-square"></i>
                </button>
                <button type="button" class="btn btn-outline-danger btn-sm" data-action="delete" data-id="${category.id}">
                    <i class="fa-solid fa-trash"></i>
                </button>
            </div>
        </div>
    `).join('');
}

function initEliminationPage() {
    bindEliminationEvents();

    request('/admin/session')
        .then(loadEliminationData)
        .catch(() => {
            window.location.href = 'admin.html';
        });
}

function bindEliminationEvents() {
    document.getElementById('adminLogoutBtn')?.addEventListener('click', handleAdminLogout);
    document.getElementById('refreshEliminationBtn')?.addEventListener('click', loadEliminationData);
    document.getElementById('selectVisibleBtn')?.addEventListener('click', () => {
        setVisibleEliminationSelection(true);
    });
    document.getElementById('clearSelectionBtn')?.addEventListener('click', () => {
        eliminationState.selectedIds.clear();
        renderEliminationDecision();
        renderEliminationRanking();
    });
    document.getElementById('eliminationForm')?.addEventListener('submit', handleEliminationSubmit);
    document.getElementById('eliminationFilters')?.addEventListener('click', handleEliminationFilterClick);
    document.getElementById('eliminationRankingList')?.addEventListener('change', handleEliminationSelectionChange);
    document.getElementById('eliminatedContestantsList')?.addEventListener('click', handleEliminatedContestantsClick);
    document.querySelectorAll('input[name="mode"]').forEach(input => {
        input.addEventListener('change', renderEliminationDecision);
    });
}

async function loadEliminationData() {
    try {
        const [contestants, leaderboard] = await Promise.all([
            request('/admin/contestants'),
            request('/leaderboard'),
        ]);

        eliminationState.contestants = contestants;
        eliminationState.leaderboard = leaderboard;

        const activeContestantIds = new Set(getActiveRankedContestants().map(contestant => contestant.id));
        eliminationState.selectedIds = new Set(
            [...eliminationState.selectedIds].filter(contestantId => activeContestantIds.has(contestantId))
        );

        renderEliminationPage();
        setStatus('eliminationMessage', '');
    } catch (error) {
        setStatus('eliminationMessage', error.message || 'Unable to load elimination data.', 'danger');
    }
}

function renderEliminationPage() {
    renderEliminationFilters();
    renderEliminationSummary();
    renderEliminationRanking();
    renderEliminationDecision();
    renderEliminatedContestants();
}

function getActiveRankedContestants() {
    const contestantsById = new Map(
        eliminationState.contestants.map(contestant => [contestant.id, contestant])
    );
    const rankedContestants = [];
    const usedIds = new Set();

    eliminationState.leaderboard.forEach(entry => {
        const contestant = contestantsById.get(entry.contestant_id);
        if (!contestant || contestant.eliminated) return;

        rankedContestants.push({
            ...contestant,
            rank: rankedContestants.length + 1,
            final_score: Number(entry.final_score || 0),
            judges_scored: Number(entry.judges_scored || 0),
            judge_total: Number(entry.judge_total || 0),
            hasScore: true,
        });
        usedIds.add(contestant.id);
    });

    eliminationState.contestants
        .filter(contestant => !contestant.eliminated && !usedIds.has(contestant.id))
        .sort((left, right) => left.id - right.id)
        .forEach(contestant => {
            rankedContestants.push({
                ...contestant,
                rank: rankedContestants.length + 1,
                final_score: null,
                judges_scored: 0,
                judge_total: 0,
                hasScore: false,
            });
        });

    return rankedContestants;
}

function getVisibleEliminationContestants() {
    const contestants = getActiveRankedContestants();

    if (eliminationState.filter === 'top10') {
        return contestants.filter(contestant => contestant.rank <= 10);
    }

    if (eliminationState.filter === 'below10') {
        return contestants.filter(contestant => contestant.rank > 10);
    }

    return contestants;
}

function renderEliminationFilters() {
    document.querySelectorAll('#eliminationFilters [data-filter]').forEach(button => {
        const isActive = button.dataset.filter === eliminationState.filter;
        button.classList.toggle('btn-primary', isActive);
        button.classList.toggle('btn-outline-secondary', !isActive);
    });
}

function renderEliminationSummary() {
    const activeContestants = getActiveRankedContestants();
    const visibleContestants = getVisibleEliminationContestants();
    const eliminatedContestants = eliminationState.contestants.filter(contestant => contestant.eliminated);

    const activeElement = document.getElementById('elimSummaryActive');
    const eliminatedElement = document.getElementById('elimSummaryEliminated');
    const selectedElement = document.getElementById('elimSummarySelected');
    const visibleElement = document.getElementById('elimSummaryVisible');
    const visibleHintElement = document.getElementById('elimVisibleHint');

    if (activeElement) activeElement.textContent = String(activeContestants.length);
    if (eliminatedElement) eliminatedElement.textContent = String(eliminatedContestants.length);
    if (selectedElement) selectedElement.textContent = String(eliminationState.selectedIds.size);
    if (visibleElement) visibleElement.textContent = String(visibleContestants.length);

    if (visibleHintElement) {
        visibleHintElement.textContent =
            eliminationState.filter === 'top10'
                ? 'Contestants ranked 1 to 10'
                : eliminationState.filter === 'below10'
                    ? 'Contestants ranked below 10'
                    : 'All active contestants';
    }
}

function renderEliminationRanking() {
    const container = document.getElementById('eliminationRankingList');
    if (!container) return;

    const activeContestants = getActiveRankedContestants();
    if (!activeContestants.length) {
        container.innerHTML = '<div class="empty-state">No active contestants are available for elimination.</div>';
        return;
    }

    const visibleContestants = getVisibleEliminationContestants();
    if (!visibleContestants.length) {
        container.innerHTML =
            eliminationState.filter === 'below10'
                ? '<div class="empty-state">There are no contestants below the top 10 right now.</div>'
                : '<div class="empty-state">No contestants match the current filter.</div>';
        return;
    }

    container.innerHTML = visibleContestants.map(contestant => {
        const checked = eliminationState.selectedIds.has(contestant.id);
        const imageMarkup = contestant.image_path
            ? `<div class="entity-thumb"><img src="${normalizeAssetPath(contestant.image_path)}" alt="${escapeHtml(contestant.name)}"></div>`
            : '<div class="entity-thumb is-placeholder"><i class="fa-regular fa-image"></i></div>';
        const rankClass =
            contestant.rank === 1
                ? 'is-first'
                : contestant.rank === 2
                    ? 'is-second'
                    : contestant.rank === 3
                        ? 'is-third'
                        : '';
        const coverage = contestant.hasScore
            ? `${contestant.judges_scored}/${contestant.judge_total} judges`
            : 'No scores yet';
        const score = contestant.hasScore ? `${contestant.final_score.toFixed(2)}%` : 'Pending';

        return `
            <label class="entity-row ranked-row ${checked ? 'is-selected' : ''}">
                <span class="selection-check">
                    <input type="checkbox" data-id="${contestant.id}" ${checked ? 'checked' : ''}>
                    <span class="selection-check-indicator"></span>
                </span>
                <span class="rank-badge ${rankClass}">${contestant.rank}</span>
                <div class="entity-info">
                    ${imageMarkup}
                    <div>
                        <div class="entity-name">${escapeHtml(contestant.name)}</div>
                        <div class="entity-meta">Contestant #${contestant.id}</div>
                    </div>
                </div>
                <div class="ranked-meta">
                    <strong>${score}</strong>
                    <span>${coverage}</span>
                </div>
            </label>
        `;
    }).join('');
}

function renderEliminatedContestants() {
    const container = document.getElementById('eliminatedContestantsList');
    if (!container) return;

    const contestants = eliminationState.contestants
        .filter(contestant => contestant.eliminated)
        .sort((left, right) => {
            if (left.eliminated_at && right.eliminated_at) {
                return right.eliminated_at.localeCompare(left.eliminated_at);
            }

            return right.id - left.id;
        });

    if (!contestants.length) {
        container.innerHTML = '<div class="empty-state">No contestants have been eliminated yet.</div>';
        return;
    }

    container.innerHTML = contestants.map(contestant => {
        const imageMarkup = contestant.image_path
            ? `<div class="entity-thumb"><img src="${normalizeAssetPath(contestant.image_path)}" alt="${escapeHtml(contestant.name)}"></div>`
            : '<div class="entity-thumb is-placeholder"><i class="fa-regular fa-image"></i></div>';

        return `
            <div class="entity-row is-eliminated">
                <div class="entity-info">
                    ${imageMarkup}
                    <div>
                        <div class="entity-name">${escapeHtml(contestant.name)}</div>
                        <div class="entity-meta">
                            Contestant #${contestant.id}
                            <span class="entity-status is-eliminated">Eliminated</span>
                        </div>
                    </div>
                </div>
                <div class="entity-actions">
                    <button type="button" class="btn btn-outline-secondary btn-sm" data-action="restore" data-id="${contestant.id}">
                        <i class="fa-solid fa-rotate-left me-2"></i>Restore
                    </button>
                </div>
            </div>
        `;
    }).join('');
}

function getSelectedEliminationMode() {
    return document.querySelector('input[name="mode"]:checked')?.value || 'eliminate-selected';
}

function renderEliminationDecision() {
    const decisionLabel = document.getElementById('eliminationDecisionLabel');
    const decisionHint = document.getElementById('eliminationDecisionHint');
    if (!decisionLabel || !decisionHint) return;

    const selectedCount = eliminationState.selectedIds.size;
    const activeCount = getActiveRankedContestants().length;
    const mode = getSelectedEliminationMode();

    decisionLabel.textContent = `${selectedCount} contestant${selectedCount === 1 ? '' : 's'} selected`;

    decisionHint.textContent =
        mode === 'eliminate-selected'
            ? `Applying now will eliminate ${selectedCount} selected contestant${selectedCount === 1 ? '' : 's'}.`
            : `Applying now will keep ${selectedCount} selected contestant${selectedCount === 1 ? '' : 's'} active and eliminate ${Math.max(activeCount - selectedCount, 0)} unselected contestant${activeCount - selectedCount === 1 ? '' : 's'}.`;

    renderEliminationSummary();
}

function handleEliminationFilterClick(event) {
    const button = event.target.closest('button[data-filter]');
    if (!button) return;

    eliminationState.filter = button.dataset.filter;
    renderEliminationFilters();
    renderEliminationSummary();
    renderEliminationRanking();
}

function handleEliminationSelectionChange(event) {
    const input = event.target.closest('input[type="checkbox"][data-id]');
    if (!input) return;

    const contestantId = Number(input.dataset.id);
    if (!contestantId) return;

    if (input.checked) {
        eliminationState.selectedIds.add(contestantId);
    } else {
        eliminationState.selectedIds.delete(contestantId);
    }

    renderEliminationDecision();
    renderEliminationRanking();
}

function setVisibleEliminationSelection(shouldSelect) {
    const visibleContestants = getVisibleEliminationContestants();

    visibleContestants.forEach(contestant => {
        if (shouldSelect) {
            eliminationState.selectedIds.add(contestant.id);
        } else {
            eliminationState.selectedIds.delete(contestant.id);
        }
    });

    renderEliminationDecision();
    renderEliminationRanking();
}

async function handleEliminationSubmit(event) {
    event.preventDefault();

    const activeContestants = getActiveRankedContestants();
    const selectedIds = [...eliminationState.selectedIds];
    const mode = getSelectedEliminationMode();

    if (!activeContestants.length) {
        setStatus('eliminationMessage', 'There are no active contestants to update.', 'warning');
        return;
    }

    if (!selectedIds.length) {
        setStatus('eliminationMessage', 'Select at least one contestant first.', 'danger');
        return;
    }

    const selectedCount = selectedIds.length;
    const affectedCount =
        mode === 'eliminate-selected'
            ? selectedCount
            : Math.max(activeContestants.length - selectedCount, 0);
    const confirmationMessage =
        mode === 'eliminate-selected'
            ? `Eliminate ${selectedCount} selected contestant${selectedCount === 1 ? '' : 's'}?`
            : `Proceed with ${selectedCount} selected contestant${selectedCount === 1 ? '' : 's'} to the next round and eliminate ${affectedCount} unselected contestant${affectedCount === 1 ? '' : 's'}?`;

    if (!window.confirm(confirmationMessage)) {
        return;
    }

    const button = document.getElementById('applyEliminationBtn');
    if (button) button.disabled = true;

    setStatus('eliminationMessage', 'Saving elimination decision...', 'warning');

    try {
        const result = await request('/admin/elimination/apply', {
            method: 'POST',
            body: { mode, contestantIds: selectedIds },
        });

        eliminationState.selectedIds.clear();
        await loadEliminationData();
        setStatus('eliminationMessage', result.message, 'success');
    } catch (error) {
        setStatus('eliminationMessage', error.message, 'danger');
    } finally {
        if (button) button.disabled = false;
    }
}

function handleEliminatedContestantsClick(event) {
    const button = event.target.closest('button[data-action="restore"]');
    if (!button) return;

    const contestantId = Number(button.dataset.id);
    const contestant = eliminationState.contestants.find(item => item.id === contestantId);
    if (!contestant) return;

    toggleContestantElimination(contestant, {
        reload: loadEliminationData,
        statusTarget: 'restoreMessage',
    });
}

async function handleAdminLogin(event) {
    event.preventDefault();
    const form = event.currentTarget;

    const username = document.getElementById('adminUsername').value.trim();
    const password = document.getElementById('adminPassword').value;

    setStatus('adminLoginMessage', '');

    try {
        await request('/admin/login', {
            method: 'POST',
            body: { username, password },
        });

        showAdminContent(true);
        await loadAdminData();
        form.reset();
    } catch (error) {
        setStatus('adminLoginMessage', error.message, 'danger');
    }
}

function handleAdminLogout() {
    request('/admin/logout', { method: 'POST' })
        .catch(() => {})
        .finally(() => {
            if (document.body.dataset.page === 'elimination') {
                window.location.href = 'admin.html';
                return;
            }

            showAdminContent(false);
        });
}

async function handleAddContestant(event) {
    event.preventDefault();

    const form = event.currentTarget;
    const formData = new FormData(form);
    formData.set('name', String(formData.get('name') || '').trim());

    setStatus('contestantsMessage', '');

    try {
        await request('/admin/contestants', {
            method: 'POST',
            body: formData,
        });

        form.reset();
        await loadAdminData();
        setStatus('contestantsMessage', 'Contestant added successfully.', 'success');
    } catch (error) {
        setStatus('contestantsMessage', error.message, 'danger');
    }
}

async function handleAddJudge(event) {
    event.preventDefault();
    const form = event.currentTarget;

    const name = document.getElementById('newJudgeName').value.trim();
    const username = document.getElementById('newJudgeUsername').value.trim();
    const password = document.getElementById('newJudgePassword').value;

    setStatus('judgesMessage', '');

    try {
        await request('/admin/judges', {
            method: 'POST',
            body: { name, username, password },
        });

        form.reset();
        await loadAdminData();
        setStatus('judgesMessage', 'Judge added successfully.', 'success');
    } catch (error) {
        setStatus('judgesMessage', error.message, 'danger');
    }
}

async function handleAddCategory(event) {
    event.preventDefault();
    const form = event.currentTarget;

    const name = document.getElementById('newCategoryName').value.trim();
    const percentage = Number.parseInt(document.getElementById('newCategoryPercentage').value, 10);

    setStatus('categoriesMessage', '');

    try {
        await request('/admin/categories', {
            method: 'POST',
            body: { name, percentage },
        });

        form.reset();
        await loadAdminData();
        setStatus('categoriesMessage', 'Category added successfully.', 'success');
    } catch (error) {
        setStatus('categoriesMessage', error.message, 'danger');
    }
}

async function handleAdminPasswordChange(event) {
    event.preventDefault();
    const form = event.currentTarget;

    const current = document.getElementById('currentAdminPass').value;
    const newPassword = document.getElementById('newAdminPass').value;
    const confirmPassword = document.getElementById('confirmAdminPass').value;

    if (newPassword !== confirmPassword) {
        setStatus('adminPassMessage', 'New passwords do not match.', 'danger');
        return;
    }

    if (newPassword.length < 6) {
        setStatus('adminPassMessage', 'New password must be at least 6 characters.', 'danger');
        return;
    }

    setStatus('adminPassMessage', '');

    try {
        const result = await request('/admin/change-password', {
            method: 'POST',
            body: { current, newPassword },
        });

        form.reset();
        setStatus('adminPassMessage', result.message, 'success');
    } catch (error) {
        setStatus('adminPassMessage', error.message, 'danger');
    }
}

async function handleJudgePasswordReset(event) {
    event.preventDefault();
    const form = event.currentTarget;

    const judgeId = document.getElementById('judgeToReset').value;
    const password = document.getElementById('newJudgePass').value;

    if (!judgeId) {
        setStatus('judgePassResetMsg', 'Choose a judge first.', 'danger');
        return;
    }

    if (password.length < 6) {
        setStatus('judgePassResetMsg', 'New password must be at least 6 characters.', 'danger');
        return;
    }

    setStatus('judgePassResetMsg', '');

    try {
        const result = await request(`/admin/judges/${judgeId}/reset-password`, {
            method: 'POST',
            body: { password },
        });

        form.reset();
        renderJudgesList();
        setStatus('judgePassResetMsg', result.message, 'success');
    } catch (error) {
        setStatus('judgePassResetMsg', error.message, 'danger');
    }
}

async function handleDeleteAllData() {
    const confirmed = window.confirm(
        'Reset all contestants, judges, scores, and restore the default categories?'
    );

    if (!confirmed) return;

    setStatus('dangerZoneMessage', 'Resetting pageant data...', 'warning');

    try {
        const result = await request('/admin/reset-all', { method: 'POST' });
        await loadAdminData();
        setStatus('dangerZoneMessage', result.message, 'success');
    } catch (error) {
        setStatus('dangerZoneMessage', error.message, 'danger');
    }
}

function handleContestantListClick(event) {
    const button = event.target.closest('button[data-action]');
    if (!button) return;

    const contestantId = Number(button.dataset.id);
    const contestant = adminState.contestants.find(item => item.id === contestantId);
    if (!contestant) return;

    if (button.dataset.action === 'edit') {
        openContestantEditor(contestant);
    }
}

function handleJudgeListClick(event) {
    const button = event.target.closest('button[data-action]');
    if (!button) return;

    const judgeId = Number(button.dataset.id);
    const judge = adminState.judges.find(item => item.id === judgeId);
    if (!judge) return;

    if (button.dataset.action === 'edit') {
        openJudgeEditor(judge);
        return;
    }

    if (button.dataset.action === 'delete') {
        deleteJudge(judge);
    }
}

function handleCategoryListClick(event) {
    const button = event.target.closest('button[data-action]');
    if (!button) return;

    const categoryId = Number(button.dataset.id);
    const category = adminState.categories.find(item => item.id === categoryId);
    if (!category) return;

    if (button.dataset.action === 'edit') {
        openCategoryEditor(category);
        return;
    }

    if (button.dataset.action === 'delete') {
        deleteCategory(category);
    }
}

function openFormModal({ title, body, submitText, onSubmit }) {
    const modalId = `modal-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const messageId = `${modalId}-message`;

    const markup = `
        <div class="modal fade" id="${modalId}" tabindex="-1" aria-hidden="true">
            <div class="modal-dialog modal-dialog-centered">
                <form class="modal-content">
                    <div class="modal-header">
                        <h5 class="modal-title">${escapeHtml(title)}</h5>
                        <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
                    </div>
                    <div class="modal-body">
                        ${body}
                        <div id="${messageId}" class="status-message mt-3" aria-live="polite"></div>
                    </div>
                    <div class="modal-footer">
                        <button type="button" class="btn btn-outline-light" data-bs-dismiss="modal">Cancel</button>
                        <button type="submit" class="btn btn-primary">${escapeHtml(submitText)}</button>
                    </div>
                </form>
            </div>
        </div>
    `;

    document.body.insertAdjacentHTML('beforeend', markup);

    const modalElement = document.getElementById(modalId);
    const messageElement = document.getElementById(messageId);
    const form = modalElement.querySelector('form');
    const modal = new bootstrap.Modal(modalElement);

    form.addEventListener('submit', async submitEvent => {
        submitEvent.preventDefault();
        setStatus(messageElement, '');

        try {
            const shouldClose = await onSubmit(form, messageElement);
            if (shouldClose !== false) {
                modal.hide();
            }
        } catch (error) {
            setStatus(messageElement, error.message || 'Unable to save changes.', 'danger');
        }
    });

    modalElement.addEventListener('hidden.bs.modal', () => modalElement.remove(), { once: true });
    modal.show();
}

function openContestantEditor(contestant) {
    const imageMarkup = contestant.image_path
        ? `
            <div class="mb-3">
                <div class="entity-thumb">
                    <img src="${normalizeAssetPath(contestant.image_path)}" alt="${escapeHtml(contestant.name)}">
                </div>
            </div>
        `
        : '';

    openFormModal({
        title: `Edit Contestant #${contestant.id}`,
        submitText: 'Save Changes',
        body: `
            ${imageMarkup}
            <div class="mb-3">
                <label class="form-label" for="editContestantName">Name</label>
                <input id="editContestantName" name="name" class="form-control" value="${escapeHtml(contestant.name)}" required>
            </div>
            <div>
                <label class="form-label" for="editContestantImage">Replace Photo</label>
                <input id="editContestantImage" name="image" type="file" class="form-control" accept="image/*">
            </div>
        `,
        onSubmit: async form => {
            const formData = new FormData(form);
            formData.set('name', String(formData.get('name') || '').trim());

            await request(`/admin/contestants/${contestant.id}`, {
                method: 'PUT',
                body: formData,
            });

            await loadAdminData();
            setStatus('contestantsMessage', 'Contestant updated successfully.', 'success');
            return true;
        },
    });
}

function openJudgeEditor(judge) {
    openFormModal({
        title: `Edit Judge #${judge.id}`,
        submitText: 'Save Changes',
        body: `
            <div class="mb-3">
                <label class="form-label" for="editJudgeName">Name</label>
                <input id="editJudgeName" name="name" class="form-control" value="${escapeHtml(judge.name)}" required>
            </div>
            <div class="mb-3">
                <label class="form-label" for="editJudgeUsername">Username</label>
                <input id="editJudgeUsername" name="username" class="form-control" value="${escapeHtml(judge.username)}" required>
            </div>
            <div>
                <label class="form-label" for="editJudgePassword">New Password</label>
                <input id="editJudgePassword" name="password" type="password" class="form-control" placeholder="Leave blank to keep the current password">
            </div>
        `,
        onSubmit: async form => {
            const name = form.elements.name.value.trim();
            const username = form.elements.username.value.trim();
            const password = form.elements.password.value;

            await request(`/admin/judges/${judge.id}`, {
                method: 'PUT',
                body: { name, username, password },
            });

            await loadAdminData();
            setStatus('judgesMessage', 'Judge updated successfully.', 'success');
            return true;
        },
    });
}

function openCategoryEditor(category) {
    openFormModal({
        title: `Edit Category #${category.id}`,
        submitText: 'Save Changes',
        body: `
            <div class="mb-3">
                <label class="form-label" for="editCategoryName">Name</label>
                <input id="editCategoryName" name="name" class="form-control" value="${escapeHtml(category.name)}" required>
            </div>
            <div>
                <label class="form-label" for="editCategoryPercentage">Weight (%)</label>
                <input id="editCategoryPercentage" name="percentage" type="number" min="1" max="100" class="form-control" value="${Number(category.percentage)}" required>
            </div>
        `,
        onSubmit: async form => {
            const name = form.elements.name.value.trim();
            const percentage = Number.parseInt(form.elements.percentage.value, 10);

            await request(`/admin/categories/${category.id}`, {
                method: 'PUT',
                body: { name, percentage },
            });

            await loadAdminData();
            setStatus('categoriesMessage', 'Category updated successfully.', 'success');
            return true;
        },
    });
}

async function toggleContestantElimination(
    contestant,
    { reload = loadAdminData, statusTarget = 'contestantsMessage' } = {}
) {
    const shouldEliminate = !contestant.eliminated;
    const confirmed = window.confirm(
        shouldEliminate
            ? `Mark ${contestant.name} as eliminated? Their scores will be preserved and they can be restored later.`
            : `Restore ${contestant.name} to the contest? Their previous scores will remain available.`
    );

    if (!confirmed) return;

    try {
        const result = await request(`/admin/contestants/${contestant.id}/elimination`, {
            method: 'POST',
            body: { eliminated: shouldEliminate },
        });
        await reload();
        setStatus(statusTarget, result.message, 'success');
    } catch (error) {
        setStatus(statusTarget, error.message, 'danger');
    }
}

async function deleteJudge(judge) {
    const confirmed = window.confirm(`Delete judge ${judge.name} and remove all of their scores?`);
    if (!confirmed) return;

    try {
        await request(`/admin/judges/${judge.id}`, { method: 'DELETE' });
        await loadAdminData();
        setStatus('judgesMessage', 'Judge deleted successfully.', 'success');
    } catch (error) {
        setStatus('judgesMessage', error.message, 'danger');
    }
}

async function deleteCategory(category) {
    const confirmed = window.confirm(
        `Delete the ${category.name} category and remove all scores saved under it?`
    );

    if (!confirmed) return;

    try {
        await request(`/admin/categories/${category.id}`, { method: 'DELETE' });
        await loadAdminData();
        setStatus('categoriesMessage', 'Category deleted successfully.', 'success');
    } catch (error) {
        setStatus('categoriesMessage', error.message, 'danger');
    }
}

function initJudgePage() {
    document.getElementById('judgeLogoutBtn')?.addEventListener('click', handleJudgeLogout);
    document.getElementById('scoringForm')?.addEventListener('submit', handleScoreSubmission);
    document.getElementById('scoringForm')?.addEventListener('input', handleScoreInput);
    document.getElementById('categoryLegend')?.addEventListener('click', handleCategorySelection);

    loadJudgeView();
}

async function loadJudgeView() {
    try {
        const session = await request('/judge/session');
        document.getElementById('judgeNameDisplay').textContent = session.judgeName;
    } catch (_error) {
        window.location.href = 'index.html';
        return;
    }

    try {
        const [categories, contestants, scores] = await Promise.all([
            request('/categories'),
            request('/contestants'),
            request('/judge/scores'),
        ]);

        judgeState.categories = categories;
        judgeState.contestants = contestants;
        judgeState.scoresMap = Object.fromEntries(
            scores.map(score => [getScoreKey(score.category_id, score.contestant_id), String(score.score)])
        );
        judgeState.activeCategoryId = categories[0]?.id ?? null;

        renderJudgeSummary();
        renderJudgeScoreSheet();
    } catch (error) {
        document.getElementById('contestantsContainer').innerHTML = `
            <div class="empty-state">${escapeHtml(error.message || 'Unable to load the score sheet.')}</div>
        `;
        setStatus('submissionMessage', error.message || 'Unable to load the score sheet.', 'danger');
    }
}

function renderJudgeSummary() {
    const legend = document.getElementById('categoryLegend');
    const totalWeight = judgeState.categories.reduce(
        (sum, category) => sum + Number(category.percentage || 0),
        0
    );

    if (legend) {
        legend.innerHTML = judgeState.categories.length
            ? judgeState.categories.map(category => `
                <button
                    type="button"
                    class="legend-item ${judgeState.activeCategoryId === category.id ? 'is-active' : ''}"
                    data-category-id="${category.id}"
                    aria-pressed="${judgeState.activeCategoryId === category.id ? 'true' : 'false'}"
                >
                    <span class="legend-main">
                        <strong>${escapeHtml(category.name)}</strong>
                        <small>${getCategoryStats(category.id).completed}/${getCategoryStats(category.id).total} contestants scored</small>
                    </span>
                    <span>${Number(category.percentage)}%</span>
                </button>
            `).join('')
            : '<div class="empty-state">No scoring categories available.</div>';
    }

    if (!judgeState.categories.length) {
        setStatus(
            'judgeConfigWarning',
            'No categories are available yet. Ask the admin to finish the setup.',
            'warning'
        );
        return;
    }

    if (totalWeight !== 100) {
        setStatus(
            'judgeConfigWarning',
            `Current category total is ${totalWeight}%. Ask the admin to adjust the scoring rubric to 100%.`,
            'warning'
        );
        return;
    }

    setStatus('judgeConfigWarning', '');
}

function renderJudgeScoreSheet() {
    const container = document.getElementById('contestantsContainer');
    if (!container) return;

    const submitButton = document.getElementById('submitScoresBtn');

    if (!judgeState.categories.length) {
        container.innerHTML = '<div class="empty-state">No categories are available for scoring yet.</div>';
        if (submitButton) submitButton.disabled = true;
        updateScoreProgress();
        return;
    }

    if (!judgeState.contestants.length) {
        container.innerHTML = '<div class="empty-state">No contestants have been added yet.</div>';
        if (submitButton) submitButton.disabled = true;
        updateScoreProgress();
        return;
    }

    if (submitButton) submitButton.disabled = false;

    const activeCategory =
        judgeState.categories.find(category => category.id === judgeState.activeCategoryId) ||
        judgeState.categories[0];

    if (!activeCategory) {
        container.innerHTML = '<div class="empty-state">No categories are available for scoring yet.</div>';
        updateScoreProgress();
        return;
    }

    judgeState.activeCategoryId = activeCategory.id;
    const categoryStats = getCategoryStats(activeCategory.id);

    const cards = judgeState.contestants.map(contestant => {
        const key = getScoreKey(activeCategory.id, contestant.id);
        const value = judgeState.scoresMap[key] ?? '';
        const isComplete = isValidScoreValue(value);

        const photo = contestant.image_path
            ? `<img src="${normalizeAssetPath(contestant.image_path)}" alt="${escapeHtml(contestant.name)}">`
            : `
                <div class="contestant-placeholder">
                    <i class="fa-regular fa-image fa-lg"></i>
                    <span>No photo</span>
                </div>
            `;

        return `
            <article class="contestant-score-card ${isComplete ? 'is-complete' : ''}" data-contestant-id="${contestant.id}">
                <div class="contestant-card-head">
                    <div class="contestant-photo">${photo}</div>
                    <div>
                        <div class="contestant-number">Contestant #${contestant.id}</div>
                        <h3 class="contestant-title">${escapeHtml(contestant.name)}</h3>
                    </div>
                </div>
                <div class="score-grid">
                    <label class="score-field">
                        <div class="score-label-row">
                            <strong>${escapeHtml(activeCategory.name)}</strong>
                            <span>${Number(activeCategory.percentage)}% weight</span>
                        </div>
                        <input
                            type="number"
                            min="0"
                            max="100"
                            step="0.01"
                            inputmode="decimal"
                            class="form-control score-input ${isComplete ? 'is-filled' : ''}"
                            data-category-id="${activeCategory.id}"
                            data-contestant-id="${contestant.id}"
                            placeholder="0.00 to 100.00"
                            value="${escapeHtml(value)}"
                        >
                    </label>
                </div>
            </article>
        `;
    }).join('');

    container.innerHTML = `
        <div class="panel utility-panel mb-4">
            <p class="section-label">Selected Category</p>
            <h2>${escapeHtml(activeCategory.name)}</h2>
            <p class="section-copy mt-2">
                Enter a score from 0 to 100 for each contestant. Decimal scores are allowed.
            </p>
            <div class="weight-summary mt-4">
                <div>
                    <div class="metric-label">Category Weight</div>
                    <strong>${Number(activeCategory.percentage)}%</strong>
                </div>
                <div>
                    <div class="metric-label">Completed</div>
                    <strong>${categoryStats.completed}/${categoryStats.total}</strong>
                </div>
            </div>
        </div>
        <div class="contestant-grid">${cards}</div>
    `;
    updateScoreProgress();
}

function updateScoreProgress() {
    const inputs = Array.from(document.querySelectorAll('.score-input'));
    const cards = Array.from(document.querySelectorAll('.contestant-score-card'));
    const total = judgeState.categories.length * judgeState.contestants.length;
    const values = Object.values(judgeState.scoresMap);
    const filled = values.filter(value => isValidScoreValue(value)).length;
    const invalid = values.filter(
        value => String(value ?? '').trim() !== '' && !isValidScoreValue(value)
    ).length;
    const remaining = total - filled;

    inputs.forEach(input => {
        const hasValue = input.value.trim() !== '';
        const valid = isValidScoreValue(input.value);
        input.classList.toggle('is-filled', valid);
        input.classList.toggle('is-invalid-entry', hasValue && !valid);
    });

    cards.forEach(card => {
        const cardInputs = Array.from(card.querySelectorAll('.score-input'));
        const complete =
            cardInputs.length > 0 && cardInputs.every(input => isValidScoreValue(input.value));
        card.classList.toggle('is-complete', complete);
    });

    const progressText = document.getElementById('scoreProgressText');
    const progressBar = document.getElementById('scoreProgressBar');
    const completionHint = document.getElementById('scoreCompletionHint');

    if (progressText) {
        progressText.textContent = total
            ? `${filled} of ${total} scores are ready to save.`
            : 'No score fields are available yet.';
    }

    if (progressBar) {
        progressBar.style.width = total ? `${(filled / total) * 100}%` : '0%';
    }

    if (completionHint) {
        if (!total) {
            completionHint.textContent = '';
        } else if (invalid) {
            completionHint.textContent = `${invalid} score field${invalid === 1 ? '' : 's'} need a number from 0 to 100. Decimals are allowed.`;
        } else if (remaining) {
            completionHint.textContent = `${remaining} score field${remaining === 1 ? '' : 's'} are still empty.`;
        } else {
            completionHint.textContent = 'Every contestant has a complete score sheet.';
        }
    }
}

async function handleScoreSubmission(event) {
    event.preventDefault();

    const button = document.getElementById('submitScoresBtn');
    const spinner = document.getElementById('loadingSpinner');
    const invalidEntry = Object.entries(judgeState.scoresMap).find(
        ([, value]) => String(value ?? '').trim() !== '' && !isValidScoreValue(value)
    );

    if (invalidEntry) {
        const [scoreKey] = invalidEntry;
        const [categoryId, contestantId] = scoreKey.split(':').map(Number);
        setActiveJudgeCategory(categoryId, contestantId);
        setStatus(
            'submissionMessage',
            'Correct the invalid scores before saving. Use numbers from 0 to 100. Decimals are allowed.',
            'danger'
        );
        return;
    }

    const scores = Object.entries(judgeState.scoresMap)
        .filter(([, value]) => isValidScoreValue(value))
        .map(([scoreKey, value]) => {
            const [categoryId, contestantId] = scoreKey.split(':').map(Number);

            return {
                category_id: categoryId,
                contestant_id: contestantId,
                score: parseScoreNumber(value),
            };
        });

    if (!scores.length) {
        setStatus('submissionMessage', 'Enter at least one score before saving.', 'danger');
        document.querySelector('.score-input')?.focus();
        return;
    }

    setStatus('submissionMessage', '');
    button.disabled = true;
    spinner.style.display = 'inline-block';

    try {
        const result = await request('/judge/scores', {
            method: 'POST',
            body: { scores },
        });

        judgeState.scoresMap = Object.fromEntries(
            scores.map(score => [getScoreKey(score.category_id, score.contestant_id), String(score.score)])
        );

        const remaining = judgeState.categories.length * judgeState.contestants.length - scores.length;
        let message = `${result.added || 0} new score${result.added === 1 ? '' : 's'} saved, ${result.updated || 0} updated.`;

        if (remaining) {
            message += ` ${remaining} field${remaining === 1 ? ' is' : 's are'} still blank.`;
        }

        if (result.skipped) {
            message += ` ${result.skipped} invalid or duplicate entr${result.skipped === 1 ? 'y was' : 'ies were'} ignored.`;
        }

        setStatus('submissionMessage', message, 'success');
        renderJudgeSummary();
        renderJudgeScoreSheet();
    } catch (error) {
        setStatus('submissionMessage', error.message, 'danger');
    } finally {
        button.disabled = false;
        spinner.style.display = 'none';
    }
}

function handleCategorySelection(event) {
    const button = event.target.closest('[data-category-id]');
    if (!button) return;

    const categoryId = Number(button.dataset.categoryId);
    setActiveJudgeCategory(categoryId);
}

function handleScoreInput(event) {
    const input = event.target.closest('.score-input');
    if (!input) {
        updateScoreProgress();
        return;
    }

    const categoryId = Number(input.dataset.categoryId);
    const contestantId = Number(input.dataset.contestantId);
    const scoreKey = getScoreKey(categoryId, contestantId);
    const rawValue = input.value.trim();

    if (rawValue === '') {
        delete judgeState.scoresMap[scoreKey];
    } else {
        judgeState.scoresMap[scoreKey] = rawValue;
    }

    renderJudgeSummary();
    updateScoreProgress();
}

function handleJudgeLogout() {
    request('/judge/logout', { method: 'POST' })
        .catch(() => {})
        .finally(() => {
            window.location.href = 'index.html';
        });
}

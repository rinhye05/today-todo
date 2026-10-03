(() => {
  const STORAGE_KEY = 'today-todos-v1';
  const SESSION_KEY = 'today-todos-sync-session-v1';
  const LAST_SYNC_KEY = 'today-todos-last-sync-v1';
  const LAST_CHANGE_KEY = 'today-todos-last-change-v1';
  const syncConfig = window.SYNC_CONFIG || {};
  const syncUrl = String(syncConfig.url || '').replace(/\/$/, '');
  const publishableKey = String(syncConfig.publishableKey || '');
  const syncConfigured = Boolean(syncUrl && publishableKey);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const iso = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const parseDate = (value) => { const [y, m, d] = value.split('-').map(Number); return new Date(y, m - 1, d); };
  const fmtDate = (value, options = { month: 'long', day: 'numeric', weekday: 'short' }) => parseDate(value).toLocaleDateString('ko-KR', options);
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const load = () => { try { const raw = localStorage.getItem(STORAGE_KEY); return raw ? JSON.parse(raw) : []; } catch { return []; } };
  let tasks = load();
  let selectedDate = iso(today);
  let shownMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  let view = 'day';
  let filter = 'all';
  let editingId = null;
  let editingSubtaskId = null;
  let addingSubtaskFor = null;
  let session = null;
  let authMode = 'login';
  let syncTimer = null;
  let pollTimer = null;
  let lastSyncedAt = Number(localStorage.getItem(LAST_SYNC_KEY) || 0);
  let lastLocalChangeAt = Number(localStorage.getItem(LAST_CHANGE_KEY) || 0);
  let applyingCloudData = false;
  let toastTimer;

  const $ = (selector) => document.querySelector(selector);
  const list = $('#task-list');
  const dialog = $('#task-dialog');
  const dateNames = { day: '하루 보기', all: '모든 할 일', upcoming: '예정된 일', completed: '완료한 일' };
  const persist = (changedTask = null) => {
    if (changedTask) changedTask.updatedAt = Date.now();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
    if (!applyingCloudData) {
      lastLocalChangeAt = Date.now();
      localStorage.setItem(LAST_CHANGE_KEY, String(lastLocalChangeAt));
      if (session) scheduleCloudSave();
    }
    render();
  };
  const escapeHTML = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const toast = (message) => { const el = $('#toast'); el.textContent = message; el.classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('visible'), 1900); };
  const setSyncLabel = (message) => { $('#sync-label').textContent = message; };
  const updateAccountUI = () => {
    $('#account-action').textContent = session?.user?.email || '기기 간 동기화';
    setSyncLabel(session ? '클라우드 동기화' : '이 기기에 저장');
  };
  const supabaseHeaders = (accessToken = '') => ({ apikey: publishableKey, ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}), 'Content-Type': 'application/json' });
  async function requestJson(url, options = {}) {
    const response = await fetch(url, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.msg || data.message || data.error_description || data.error || `요청에 실패했어요 (${response.status})`);
    return data;
  }
  async function authRequest(path, body, accessToken = '') {
    return requestJson(`${syncUrl}/auth/v1/${path}`, { method: body ? 'POST' : 'GET', headers: supabaseHeaders(accessToken), ...(body ? { body: JSON.stringify(body) } : {}) });
  }
  function saveSession(nextSession) {
    session = { ...nextSession, expires_at: nextSession.expires_at || Math.floor(Date.now() / 1000) + (nextSession.expires_in || 3600) };
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    updateAccountUI();
  }
  function restoreAuthCallback() {
    const params = new URLSearchParams(location.hash.slice(1));
    const accessToken = params.get('access_token');
    const refreshToken = params.get('refresh_token');
    if (!accessToken || !refreshToken) return;
    const expiresIn = Number(params.get('expires_in') || 3600);
    const expiresAt = Number(params.get('expires_at') || Math.floor(Date.now() / 1000) + expiresIn);
    saveSession({ access_token: accessToken, refresh_token: refreshToken, expires_in: expiresIn, expires_at: expiresAt });
    history.replaceState(null, '', `${location.pathname}${location.search}`);
  }
  function clearSession() {
    session = null;
    localStorage.removeItem(SESSION_KEY);
    clearInterval(pollTimer);
    pollTimer = null;
    updateAccountUI();
  }
  async function ensureFreshSession() {
    if (!session?.access_token) throw new Error('다시 로그인해 주세요.');
    if (session.expires_at > Math.floor(Date.now() / 1000) + 45) return;
    if (!session.refresh_token) throw new Error('로그인 시간이 만료됐어요. 다시 로그인해 주세요.');
    const refreshed = await requestJson(`${syncUrl}/auth/v1/token?grant_type=refresh_token`, { method: 'POST', headers: supabaseHeaders(), body: JSON.stringify({ refresh_token: session.refresh_token }) });
    saveSession({ ...refreshed, user: session.user });
  }
  function taskFreshness(task) { return Number(task.updatedAt || task.createdAt || 0); }
  function mergeTaskSnapshots(remoteTasks, localTasks) {
    const merged = new Map();
    for (const task of [...remoteTasks, ...localTasks]) {
      const current = merged.get(task.id);
      if (!current || taskFreshness(task) >= taskFreshness(current)) merged.set(task.id, task);
    }
    return [...merged.values()].sort((a, b) => a.date.localeCompare(b.date) || (a.createdAt || 0) - (b.createdAt || 0));
  }
  function applyCloudTasks(cloudTasks) {
    applyingCloudData = true;
    tasks = Array.isArray(cloudTasks) ? cloudTasks : [];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
    lastLocalChangeAt = 0;
    localStorage.removeItem(LAST_CHANGE_KEY);
    applyingCloudData = false;
    render();
  }
  async function readCloudDocument() {
    await ensureFreshSession();
    const query = `?owner_id=eq.${encodeURIComponent(session.user.id)}&select=tasks,updated_at&limit=1`;
    const rows = await requestJson(`${syncUrl}/rest/v1/todo_documents${query}`, { headers: supabaseHeaders(session.access_token) });
    return rows[0] || null;
  }
  async function writeCloudDocument() {
    await ensureFreshSession();
    const response = await requestJson(`${syncUrl}/rest/v1/todo_documents?on_conflict=owner_id`, {
      method: 'POST',
      headers: { ...supabaseHeaders(session.access_token), Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify({ owner_id: session.user.id, tasks }),
    });
    lastSyncedAt = Date.parse(response[0]?.updated_at || new Date().toISOString());
    localStorage.setItem(LAST_SYNC_KEY, String(lastSyncedAt));
    setSyncLabel('동기화 완료');
  }
  function scheduleCloudSave() {
    if (!session) return;
    clearTimeout(syncTimer);
    setSyncLabel('동기화 중…');
    syncTimer = setTimeout(() => writeCloudDocument().catch((error) => { setSyncLabel('동기화 대기'); console.error('Cloud sync failed:', error.message); }), 500);
  }
  async function syncInitial() {
    setSyncLabel('동기화 중…');
    const remote = await readCloudDocument();
    if (!remote) {
      if (tasks.length) await writeCloudDocument();
      else setSyncLabel('동기화 완료');
      return;
    }
    const merged = mergeTaskSnapshots(remote.tasks || [], tasks);
    const remoteIds = new Set((remote.tasks || []).map((task) => task.id));
    const needsUpload = merged.length !== remoteIds.size || merged.some((task) => !remoteIds.has(task.id) || JSON.stringify(task) !== JSON.stringify((remote.tasks || []).find((item) => item.id === task.id)));
    applyCloudTasks(merged);
    lastSyncedAt = Date.parse(remote.updated_at || 0);
    localStorage.setItem(LAST_SYNC_KEY, String(lastSyncedAt));
    if (needsUpload) await writeCloudDocument();
    else setSyncLabel('동기화 완료');
  }
  async function pollCloudDocument() {
    if (!session) return;
    try {
      const remote = await readCloudDocument();
      if (!remote) return;
      const remoteAt = Date.parse(remote.updated_at || 0);
      if (remoteAt <= lastSyncedAt) return;
      if (lastLocalChangeAt > lastSyncedAt && lastLocalChangeAt > remoteAt) {
        await writeCloudDocument();
        return;
      }
      applyCloudTasks(remote.tasks || []);
      lastSyncedAt = remoteAt;
      localStorage.setItem(LAST_SYNC_KEY, String(lastSyncedAt));
      setSyncLabel('동기화 완료');
    } catch (error) {
      setSyncLabel('다시 연결 대기');
      console.error('Cloud sync check failed:', error.message);
    }
  }
  async function restoreSession() {
    if (!syncConfigured) return;
    const stored = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
    if (!stored?.access_token) return;
    try {
      session = stored;
      await ensureFreshSession();
      const user = await authRequest('user', null, session.access_token);
      saveSession({ ...session, user });
    } catch (error) {
      clearSession();
      setSyncLabel('로그인 다시 필요');
      console.error('Session restore failed:', error.message);
      return;
    }
    try { await syncInitial(); } catch (error) { setSyncLabel('동기화 대기'); console.error('Initial sync failed:', error.message); }
    clearInterval(pollTimer);
    pollTimer = setInterval(pollCloudDocument, 10000);
  }
  function openAccountDialog() {
    const signedIn = Boolean(session?.user);
    $('#account-message').textContent = syncConfigured ? '' : '동기화 서버를 연결해야 계정을 사용할 수 있어요. 지금은 이 브라우저에 저장됩니다.';
    $('#account-copy').textContent = signedIn ? `로그인됨 · ${session.user.email} · 이 계정의 할 일이 기기 간 동기화돼요.` : '계정으로 로그인하면 여러 기기에서 같은 할 일을 볼 수 있어요.';
    $('#account-title').textContent = signedIn ? '클라우드 동기화 사용 중' : '기기 간 동기화';
    $('#account-email').previousElementSibling.classList.toggle('hidden', signedIn);
    $('#account-email').classList.toggle('hidden', signedIn);
    $('#account-password').previousElementSibling.classList.toggle('hidden', signedIn);
    $('#account-password').classList.toggle('hidden', signedIn);
    $('#account-mode-toggle').classList.toggle('hidden', signedIn || !syncConfigured);
    $('#account-submit').classList.toggle('hidden', signedIn || !syncConfigured);
    $('#account-logout').classList.toggle('hidden', !signedIn);
    $('#account-email').disabled = !syncConfigured;
    $('#account-password').disabled = !syncConfigured;
    $('#account-mode-toggle').textContent = authMode === 'login' ? '계정 만들기' : '로그인으로 돌아가기';
    $('#account-submit').textContent = authMode === 'login' ? '로그인' : '가입하기';
    $('#account-password').autocomplete = authMode === 'login' ? 'current-password' : 'new-password';
    $('#account-dialog').showModal();
  }
  async function submitAuth(event) {
    event.preventDefault();
    if (!syncConfigured) return;
    const email = $('#account-email').value.trim();
    const password = $('#account-password').value;
    const button = $('#account-submit');
    button.disabled = true;
    $('#account-message').textContent = authMode === 'login' ? '로그인 중…' : '계정을 만들고 있어요…';
    try {
      const result = authMode === 'login'
        ? await authRequest('token?grant_type=password', { email, password })
        : await authRequest('signup', { email, password, options: { emailRedirectTo: location.href.split('#')[0] } });
      if (!result.access_token) {
        $('#account-message').textContent = '확인 메일을 보냈어요. 이메일 인증을 마친 뒤 로그인해 주세요.';
        return;
      }
      saveSession(result);
      $('#account-dialog').close();
      await syncInitial();
      clearInterval(pollTimer);
      pollTimer = setInterval(pollCloudDocument, 10000);
      toast('여러 기기에서 동기화할 준비가 됐어요.');
    } catch (error) {
      $('#account-message').textContent = error.message || '로그인에 실패했어요. 입력한 정보를 확인해 주세요.';
    } finally {
      button.disabled = false;
    }
  }
  async function signOut() {
    try { if (session?.access_token) await authRequest('logout', {}, session.access_token); } catch {}
    clearSession();
    $('#account-dialog').close();
    setSyncLabel('이 기기에 저장');
  }
  const sortTasks = (items) => [...items].sort((a, b) => a.done - b.done || a.date.localeCompare(b.date) || ({ high: 0, normal: 1, low: 2 }[a.priority] - { high: 0, normal: 1, low: 2 }[b.priority]) || a.createdAt - b.createdAt);
  const subtasksDone = (task) => task.subtasks.filter((s) => s.done).length;

  function getVisibleTasks() {
    let items = tasks;
    if (view === 'day') items = items.filter((t) => t.date === selectedDate);
    if (view === 'upcoming') items = items.filter((t) => t.date > iso(today) && !t.done);
    if (view === 'completed') items = items.filter((t) => t.done);
    const query = $('#search-input').value.trim().toLocaleLowerCase('ko');
    if (query) items = items.filter((t) => t.title.toLocaleLowerCase('ko').includes(query) || t.note.toLocaleLowerCase('ko').includes(query) || t.subtasks.some((s) => s.title.toLocaleLowerCase('ko').includes(query)));
    if (filter === 'active') items = items.filter((t) => !t.done);
    if (filter === 'done') items = items.filter((t) => t.done);
    return sortTasks(items);
  }

  function render() {
    const todays = tasks.filter((t) => t.date === iso(today));
    $('#today-count').textContent = todays.filter((t) => !t.done).length;
    $('#all-count').textContent = tasks.filter((t) => !t.done).length;
    $('#crumb-label').textContent = dateNames[view];
    $('#date-eyebrow').textContent = view === 'day' ? (selectedDate === iso(today) ? 'MY DAY' : 'YOUR DAY') : view.toUpperCase();
    $('#page-title').textContent = view === 'day' ? (selectedDate === iso(today) ? '오늘의 할 일' : fmtDate(selectedDate, { month: 'long', day: 'numeric' })) : dateNames[view];
    $('#page-subtitle').textContent = view === 'day' ? (selectedDate === iso(today) ? '작은 한 걸음부터 시작해요.' : '이 날의 계획을 확인해요.') : view === 'upcoming' ? '다가오는 날의 계획을 살펴봐요.' : view === 'completed' ? '지금까지 해낸 일들이에요.' : '생각나는 일을 모두 담아두세요.';
    const selectedItems = tasks.filter((t) => t.date === selectedDate);
    const remaining = selectedItems.filter((t) => !t.done).length;
    const done = selectedItems.filter((t) => t.done).length;
    const percent = selectedItems.length ? Math.round(done / selectedItems.length * 100) : 0;
    $('#summary-open').textContent = remaining; $('#summary-done').textContent = done;
    $('#progress-label').textContent = `${percent}%`; $('#progress-bar').style.width = `${percent}%`;
    document.querySelectorAll('.nav-item').forEach((el) => el.classList.toggle('active', el.dataset.view === view));
    $('#month-label').textContent = shownMonth.toLocaleDateString('ko-KR', { year: 'numeric', month: 'long' });
    $('#selected-date-label').textContent = fmtDate(selectedDate);
    renderCalendar(); renderTaskList(); renderAgenda();
  }

  function renderTaskList() {
    const items = getVisibleTasks();
    if (!items.length) {
      const headline = $('#search-input').value.trim() ? '검색 결과가 없어요' : filter === 'done' ? '아직 완료한 일이 없어요' : filter === 'active' ? '진행 중인 일이 없어요' : view === 'day' ? '이 날은 여유롭네요' : '아직 할 일이 없어요';
      const copy = $('#search-input').value.trim() ? '다른 단어로 찾아보거나 새 할 일을 추가해보세요.' : '해야 할 일을 적어두면 여기에 모아둘게요.';
      list.innerHTML = `<div class="empty-state"><div class="empty-icon">✦</div><h3>${headline}</h3><p>${copy}</p><button class="text-link" data-action="new">＋ 할 일 추가하기</button></div>`;
      return;
    }
    list.innerHTML = items.map((task) => {
      const count = task.subtasks.length;
      const priority = task.priority !== 'normal' ? `<span class="priority ${task.priority}">${task.priority === 'high' ? '높음' : '낮음'}</span>` : '';
      const dateMeta = view !== 'day' ? `<span>◷ ${escapeHTML(fmtDate(task.date, { month: 'short', day: 'numeric' }))}</span>` : '';
      const subtasks = task.subtasks.map((sub) => {
        const isEditing = editingSubtaskId === `${task.id}:${sub.id}`;
        const title = isEditing
          ? `<form class="subtask-edit" data-task="${task.id}" data-sub="${sub.id}"><input class="subtask-edit-input" maxlength="120" value="${escapeHTML(sub.title)}" aria-label="하위 할 일 수정"><button type="submit" aria-label="수정 저장">저장</button><button type="button" data-action="canceleditsub" aria-label="수정 취소">취소</button></form>`
          : `<button type="button" class="subtask-title" data-action="editsub" data-task="${task.id}" data-sub="${sub.id}" title="눌러서 수정">${escapeHTML(sub.title)}</button>`;
        return `<div class="subtask-row ${sub.done ? 'done' : ''}"><input type="checkbox" data-action="subtoggle" data-task="${task.id}" data-sub="${sub.id}" ${sub.done ? 'checked' : ''} aria-label="${escapeHTML(sub.title)} 완료">${title}<button type="button" class="subtask-delete" data-action="subdelete" data-task="${task.id}" data-sub="${sub.id}" aria-label="하위 주제 삭제">×</button></div>`;
      }).join('');
      const subtaskInput = addingSubtaskFor === task.id
        ? `<form class="subtask-entry" data-task="${task.id}"><input id="subtask-entry" maxlength="120" placeholder="하위 주제 입력…" aria-label="하위 주제 입력" autocomplete="off"><button type="submit" aria-label="하위 주제 저장">추가</button><button type="button" data-action="cancelsub" aria-label="입력 취소">취소</button></form>`
        : `<button type="button" class="subtask-add" data-action="addsub" data-id="${task.id}">＋ 하위 주제 추가</button>`;
      return `<article class="task-card ${task.done ? 'is-done' : ''}"><input type="checkbox" class="task-check" data-action="toggle" data-id="${task.id}" ${task.done ? 'checked' : ''} aria-label="${escapeHTML(task.title)} 완료"><div class="task-body"><div class="task-title-line"><button type="button" class="task-title" data-action="edit" data-id="${task.id}" title="눌러서 수정 또는 날짜 변경">${escapeHTML(task.title)}</button><div class="task-tools"><button type="button" data-action="edit" data-id="${task.id}" title="수정">···</button></div></div>${task.note ? `<div class="task-meta"><span>${escapeHTML(task.note)}</span></div>` : ''}<div class="task-meta">${dateMeta}${priority}${count ? `<span class="subtask-progress">▦ ${subtasksDone(task)}/${count}</span>` : ''}</div><div class="subtask-list">${subtasks}${subtaskInput}</div></div></article>`;
    }).join('');
  }

  function renderCalendar() {
    const year = shownMonth.getFullYear(), month = shownMonth.getMonth();
    const first = new Date(year, month, 1), start = new Date(year, month, 1 - first.getDay());
    const weekdays = ['일', '월', '화', '수', '목', '금', '토'].map((d) => `<div class="weekday">${d}</div>`).join('');
    let days = '';
    for (let i = 0; i < 42; i++) {
      const date = new Date(start); date.setDate(start.getDate() + i);
      const key = iso(date), outside = date.getMonth() !== month;
      const classes = ['calendar-day', outside ? 'outside' : '', key === iso(today) ? 'today' : '', key === selectedDate ? 'selected' : '', tasks.some((t) => t.date === key && !t.done) ? 'has-task' : ''].filter(Boolean).join(' ');
      days += `<button class="${classes}" data-date="${key}" aria-label="${date.toLocaleDateString('ko-KR')}${tasks.some((t) => t.date === key) ? ', 할 일 있음' : ''}">${date.getDate()}</button>`;
    }
    $('#calendar-grid').innerHTML = weekdays + days;
  }

  function renderAgenda() {
    const items = sortTasks(tasks.filter((t) => t.date === selectedDate));
    $('#agenda-title').textContent = selectedDate === iso(today) ? '오늘의 일정' : fmtDate(selectedDate, { month: 'long', day: 'numeric' });
    $('#agenda-count').textContent = items.length ? `${items.filter((t) => !t.done).length}개 남음` : '할 일이 없어요';
    $('#agenda-list').innerHTML = items.slice(0, 5).map((task) => `<div class="agenda-item ${task.done ? 'done' : ''}"><button class="agenda-check ${task.done ? 'done' : ''}" data-action="toggle" data-id="${task.id}" aria-label="${escapeHTML(task.title)} 완료">${task.done ? '✓' : ''}</button><button type="button" class="agenda-title" data-action="edit" data-id="${task.id}" title="눌러서 수정">${escapeHTML(task.title)}</button></div>`).join('');
  }

  function openDialog(task = null) {
    editingId = task?.id ?? null;
    $('#dialog-title').textContent = task ? '할 일 수정' : '새 할 일';
    $('#dialog-eyebrow').textContent = task ? 'EDIT TASK' : 'NEW TASK';
    $('#task-title').value = task?.title ?? '';
    $('#task-note').value = task?.note ?? '';
    $('#task-date').value = task?.date ?? selectedDate;
    $('#task-priority').value = task?.priority ?? 'normal';
    $('#delete-task').classList.toggle('hidden', !task);
    dialog.showModal(); setTimeout(() => $('#task-title').focus(), 50);
  }
  function closeDialog() { dialog.close(); editingId = null; }
  function saveTask(event) {
    event.preventDefault();
    const title = $('#task-title').value.trim(); if (!title) return;
    const values = { title, note: $('#task-note').value.trim(), date: $('#task-date').value, priority: $('#task-priority').value };
    let changedTask;
    if (editingId) { changedTask = tasks.find((t) => t.id === editingId); Object.assign(changedTask, values); toast('할 일을 수정했어요.'); }
    else { const now = Date.now(); changedTask = { id: uid(), ...values, done: false, subtasks: [], createdAt: now, updatedAt: now }; tasks.push(changedTask); toast('할 일을 저장했어요.'); }
    selectedDate = values.date; shownMonth = new Date(parseDate(values.date).getFullYear(), parseDate(values.date).getMonth(), 1);
    closeDialog(); persist(changedTask);
  }

  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-action]');
    if (target) {
      const task = tasks.find((t) => t.id === target.dataset.id || t.id === target.dataset.task);
      switch (target.dataset.action) {
        case 'new': openDialog(); break;
        case 'edit': if (task) openDialog(task); break;
        case 'toggle': if (task) { task.done = !task.done; persist(task); } break;
        case 'addsub': if (task) { addingSubtaskFor = task.id; renderTaskList(); $('#subtask-entry')?.focus(); } break;
        case 'cancelsub': addingSubtaskFor = null; renderTaskList(); break;
        case 'editsub': if (task) { editingSubtaskId = `${task.id}:${target.dataset.sub}`; renderTaskList(); const input = $('.subtask-edit-input'); input?.focus(); input?.select(); } break;
        case 'canceleditsub': editingSubtaskId = null; renderTaskList(); break;
        case 'subdelete': if (task) { task.subtasks = task.subtasks.filter((s) => s.id !== target.dataset.sub); persist(task); } break;
      }
    }
    const day = event.target.closest('[data-date]');
    if (day) { selectedDate = day.dataset.date; const date = parseDate(selectedDate); shownMonth = new Date(date.getFullYear(), date.getMonth(), 1); view = 'day'; render(); }
  });
  document.addEventListener('submit', (event) => {
    const editForm = event.target.closest('.subtask-edit');
    if (editForm) {
      event.preventDefault();
      const task = tasks.find((t) => t.id === editForm.dataset.task);
      const sub = task?.subtasks.find((s) => s.id === editForm.dataset.sub);
      const title = editForm.querySelector('input').value.trim();
      if (!task || !sub || !title) { editForm.querySelector('input').focus(); return; }
      sub.title = title;
      editingSubtaskId = null;
      persist(task);
      return;
    }
    const form = event.target.closest('.subtask-entry');
    if (!form) return;
    event.preventDefault();
    const task = tasks.find((t) => t.id === form.dataset.task);
    const input = form.querySelector('input');
    const title = input.value.trim();
    if (!task || !title) { input.focus(); return; }
    task.subtasks.push({ id: uid(), title, done: false });
    persist(task);
    $('#subtask-entry')?.focus();
  });
  document.addEventListener('change', (event) => {
    const input = event.target;
    if (input.dataset.action === 'subtoggle') {
      const task = tasks.find((t) => t.id === input.dataset.task);
      const sub = task?.subtasks.find((s) => s.id === input.dataset.sub);
      if (sub) {
        sub.done = input.checked;
        persist(task);
      }
    }
  });
  document.querySelectorAll('.nav-item').forEach((button) => button.addEventListener('click', () => { view = button.dataset.view; filter = 'all'; document.querySelectorAll('.filter-tab').forEach((t) => t.classList.toggle('selected', t.dataset.filter === 'all')); render(); }));
  document.querySelectorAll('.filter-tab').forEach((button) => button.addEventListener('click', () => { filter = button.dataset.filter; document.querySelectorAll('.filter-tab').forEach((t) => t.classList.toggle('selected', t === button)); renderTaskList(); }));
  $('#new-task').addEventListener('click', () => openDialog()); $('#agenda-add').addEventListener('click', () => openDialog());
  $('#prev-month').addEventListener('click', () => { shownMonth = new Date(shownMonth.getFullYear(), shownMonth.getMonth() - 1, 1); renderCalendar(); $('#month-label').textContent = shownMonth.toLocaleDateString('ko-KR', { year: 'numeric', month: 'long' }); });
  $('#next-month').addEventListener('click', () => { shownMonth = new Date(shownMonth.getFullYear(), shownMonth.getMonth() + 1, 1); renderCalendar(); $('#month-label').textContent = shownMonth.toLocaleDateString('ko-KR', { year: 'numeric', month: 'long' }); });
  $('#go-today').addEventListener('click', () => { selectedDate = iso(today); shownMonth = new Date(today.getFullYear(), today.getMonth(), 1); view = 'day'; render(); });
  $('#search-input').addEventListener('input', renderTaskList);
  $('#task-form').addEventListener('submit', saveTask); $('#close-dialog').addEventListener('click', closeDialog); $('#cancel-dialog').addEventListener('click', closeDialog);
  $('#delete-task').addEventListener('click', () => { if (!editingId) return; if (confirm('이 할 일을 삭제할까요? 하위 주제도 함께 삭제돼요.')) { tasks = tasks.filter((t) => t.id !== editingId); closeDialog(); persist(); toast('할 일을 삭제했어요.'); } });
  dialog.addEventListener('click', (event) => { if (event.target === dialog) closeDialog(); });
  $('#account-action').addEventListener('click', openAccountDialog);
  $('#account-form').addEventListener('submit', submitAuth);
  $('#close-account-dialog').addEventListener('click', () => $('#account-dialog').close());
  $('#account-dialog').addEventListener('click', (event) => { if (event.target === $('#account-dialog')) $('#account-dialog').close(); });
  $('#account-mode-toggle').addEventListener('click', () => { authMode = authMode === 'login' ? 'signup' : 'login'; $('#account-message').textContent = ''; $('#account-dialog').close(); openAccountDialog(); });
  $('#account-logout').addEventListener('click', signOut);
  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); $('#search-input').focus(); }
    if (event.key === 'Escape' && event.target.id === 'subtask-entry') { addingSubtaskFor = null; renderTaskList(); }
    if (event.key === 'Escape' && event.target.classList.contains('subtask-edit-input')) { editingSubtaskId = null; renderTaskList(); }
  });
  render();
  updateAccountUI();
  restoreAuthCallback();
  restoreSession();
})();

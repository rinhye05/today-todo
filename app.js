(() => {
  const STORAGE_KEY = 'today-todos-v1';
  const SESSION_KEY = 'today-todos-sync-session-v1';
  const LAST_SYNC_KEY = 'today-todos-last-sync-v1';
  const LAST_CHANGE_KEY = 'today-todos-last-change-v1';
  const schedule = window.TodoSchedule;
  const syncConfig = window.SYNC_CONFIG || {};
  const syncUrl = String(syncConfig.url || '').replace(/\/$/, '');
  const publishableKey = String(syncConfig.publishableKey || '');
  const syncConfigured = Boolean(syncUrl && publishableKey);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const iso = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const parseDate = (value) => { const [y, m, d] = value.split('-').map(Number); return new Date(y, m - 1, d); };
  const fmtDate = (value, options = { month: 'long', day: 'numeric', weekday: 'short' }) => parseDate(value).toLocaleDateString('ko-KR', options);
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const load = () => { try { const records = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); return Array.isArray(records) ? records : []; } catch { return []; } };
  const loadedRecords = load();
  const plannerTypes = new Set(['category', 'plan', 'event', 'plan-check']);
  let plannerRecords = loadedRecords.filter((record) => plannerTypes.has(record.type));
  let tasks = loadedRecords.filter((record) => record.type !== 'routine' && !plannerTypes.has(record.type));
  let routines = loadedRecords.filter((record) => record.type === 'routine').map(schedule.normalizeRoutine);
  const followDate = () => localStorage.getItem('todo-follow-date') === 'true';
  let selectedDate = iso(today);
  let shownMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  let view = 'overview';
  let filter = 'all';
  let dayCategories = null;
  let dayKinds = null;
  let editingId = null;
  let editingSubtaskId = null;
  let actionContext = null;
  let dateContext = null;
  let routineContext = null;
  let editingRoutineId = null;
  let selectedRoutineId = '';
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
  const dateNames = { overview: '전체 보기', day: '하루 보기', all: '모든 할 일', upcoming: '예정된 일', completed: '완료한 일', routines: '나의 루틴', planner: '주간 플래너', events: '일정' };
  const saveRecords = () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...tasks, ...routines, ...plannerRecords]));
    if (!applyingCloudData) {
      lastLocalChangeAt = Date.now();
      localStorage.setItem(LAST_CHANGE_KEY, String(lastLocalChangeAt));
      if (session) scheduleCloudSave();
    }
  };
  const persist = (changedTask = null) => {
    if (changedTask) changedTask.updatedAt = Date.now();
    saveRecords();
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
    return [...merged.values()].sort((a, b) => String(a.date || a.startDate || '').localeCompare(String(b.date || b.startDate || '')) || (a.createdAt || 0) - (b.createdAt || 0));
  }
  function applyCloudTasks(cloudTasks) {
    applyingCloudData = true;
    const records = Array.isArray(cloudTasks) ? cloudTasks : [];
    tasks = records.filter((record) => record.type !== 'routine' && !plannerTypes.has(record.type));
    plannerRecords = records.filter((record) => plannerTypes.has(record.type));
    routines = records.filter((record) => record.type === 'routine').map(schedule.normalizeRoutine);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
    lastLocalChangeAt = 0;
    localStorage.removeItem(LAST_CHANGE_KEY);
    applyingCloudData = false;
    generateRoutineTasks();
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
      body: JSON.stringify({ owner_id: session.user.id, tasks: [...tasks, ...routines, ...plannerRecords] }),
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
      if (tasks.length || routines.length || plannerRecords.length) await writeCloudDocument();
      else setSyncLabel('동기화 완료');
      return;
    }
    const localRecords = [...tasks, ...routines, ...plannerRecords];
    const merged = mergeTaskSnapshots(remote.tasks || [], localRecords);
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

  function matchesDayFilters(item, kind) {
    return (!dayKinds || dayKinds.has(kind)) && (!dayCategories || dayCategories.has(item.categoryId || ''));
  }

  function dayFilterOptions() {
    return {
      category: [{ id: '', name: '카테고리 없음' }, ...plannerRecords.filter((item) => item.type === 'category' && !item.deleted).sort((a, b) => (a.order ?? a.createdAt ?? 0) - (b.order ?? b.createdAt ?? 0)).map((item) => ({ id: item.id, name: item.name, color: item.color }))],
      kind: [{ id: 'task', name: '할 일' }, { id: 'routine', name: '루틴' }, { id: 'plan', name: '플랜' }],
    };
  }

  function updateDayFilterLabels() {
    for (const [group, options] of Object.entries(dayFilterOptions())) {
      const selection = group === 'category' ? dayCategories : dayKinds;
      const chosen = selection ? options.filter((item) => selection.has(item.id)) : options;
      $(`#day-${group}-label`).textContent = chosen.length === options.length ? '전체' : chosen.length ? `${chosen.length}개 선택` : '선택 없음';
    }
  }

  function renderDayFilters() {
    $('#day-filters').classList.toggle('hidden', view !== 'day');
    for (const [group, options] of Object.entries(dayFilterOptions())) {
      const selection = group === 'category' ? dayCategories : dayKinds;
      $(`#day-${group}-options`).innerHTML = `<button type="button" class="text-link" data-day-filter-all="${group}">전체 선택</button>` + options.map((item) => `<label><input type="checkbox" data-day-filter="${group}" value="${escapeHTML(item.id)}" ${!selection || selection.has(item.id) ? 'checked' : ''}>${item.color ? `<i class="day-filter-color" style="background:${window.TodoPlannerCore.safeColor(item.color)}"></i>` : ''}<span>${escapeHTML(item.name)}</span></label>`).join('');
    }
    updateDayFilterLabels();
  }

  function daySortTime(item, time = item.routineTime) {
    const deadline = window.TodoDeadline.timestamp(item);
    if (Number.isFinite(deadline)) return deadline;
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time || '')) return Infinity;
    return new Date(`${selectedDate}T${time}:00`).getTime();
  }


  function getVisibleTasks() {
    let items = tasks.filter((task) => task.type !== 'routine');
    if (view === 'day') items = items.filter((t) => t.date === selectedDate && matchesDayFilters(t, t.routineId ? 'routine' : 'task'));
    if (view === 'upcoming') items = window.TodoDeadline.upcoming(items, iso(today));
    if (view === 'completed') items = items.filter((t) => t.done);
    const query = $('#search-input').value.trim().toLocaleLowerCase('ko');
    if (query) items = items.filter((t) => t.title.toLocaleLowerCase('ko').includes(query) || t.note.toLocaleLowerCase('ko').includes(query) || t.subtasks.some((s) => s.title.toLocaleLowerCase('ko').includes(query)));
    if (filter === 'active') items = items.filter((t) => !t.done);
    if (filter === 'done') items = items.filter((t) => t.done);
    const sorted = view === 'day' ? window.TodoPlannerCore.sortDailyItems(items, selectedDate) : view === 'upcoming' ? items : sortTasks(items);
    const positions = new Map(sorted.map((item, index) => [item.id, index]));
    return view === 'upcoming' ? sorted : sorted.sort((a, b) => (a.order ?? positions.get(a.id)) - (b.order ?? positions.get(b.id)));
  }

  function generateRoutineTasks() {
    const ahead = new Date(today); ahead.setDate(ahead.getDate() + 30);
    const through = [iso(ahead), selectedDate, iso(new Date(shownMonth.getFullYear(), shownMonth.getMonth() + 1, 0))].sort().at(-1);
    let changed = false;
    routines.forEach((routine) => {
      if (!schedule.validDate(routine.startDate) || routine.startDate > through) return;
      for (const task of tasks.filter((item) => item.routineId === routine.id)) {
        if (task.routineTime !== undefined) continue;
        task.routineTime = schedule.routineTimeOn(routine, task.routineDate || task.date);
        task.updatedAt = Date.now();
        changed = true;
      }
      const generatedDates = new Set(routine.occurrences);
      const existingDates = new Set(tasks.filter((task) => task.routineId === routine.id).map((task) => task.routineDate || task.date));
      const date = parseDate(routine.startDate);
      const end = routine.endDate && routine.endDate < through ? routine.endDate : through;
      while (iso(date) <= end) {
        const key = iso(date);
        if (schedule.isScheduled(routine, key) && !generatedDates.has(key)) {
          if (!existingDates.has(key)) tasks.push(buildRoutineTask(routine, key));
          routine.occurrences.push(key);
          routine.updatedAt = Date.now();
          changed = true;
        }
        date.setDate(date.getDate() + 1);
      }
    });
    if (changed) saveRecords();
  }

  function buildRoutineTask(routine, date) {
    const now = Date.now();
    const task = { id: `routine-${routine.id}-${date}`, title: routine.subtask ? routine.parentTitle : routine.title, note: routine.note, date, priority: routine.priority, categoryId: routine.categoryId || '', done: false, subtasks: [], createdAt: now, updatedAt: now, routineId: routine.id, routineDate: date, routineTime: schedule.routineTimeOn(routine, date), placement: routine.placement };
    if (routine.subtask) task.subtasks.push({ id: `sub-${routine.id}-${date}`, title: routine.title, done: false, routineId: routine.id });
    return task;
  }

  function openTaskActions(task, sub = null) {
    if (!task) return;
    actionContext = { taskId: task.id, subId: sub?.id ?? null };
    $('#task-actions-title').textContent = sub ? sub.title : task.title;
    $('#task-actions-dialog').showModal();
  }

  function currentActionTarget() {
    const task = tasks.find((item) => item.id === actionContext?.taskId);
    const sub = task?.subtasks.find((item) => item.id === actionContext?.subId);
    return { task, sub };
  }

  function registerRoutine(task, sub) {
    if (!task) return;
    const existing = routines.find((routine) => routine.id === (sub?.routineId || task.routineId));
    if (existing) { openRoutineDialog(existing); return; }
    openRoutineDialog(null, task, sub);
  }

  function updateRoutineFields() {
    const frequency = $('#routine-frequency').value;
    $('#routine-weekday-field').classList.toggle('hidden', frequency !== 'weekly');
    $('#routine-monthday-field').classList.toggle('hidden', frequency !== 'monthly');
    $('#routine-monthday').disabled = frequency !== 'monthly';
    $('#routine-interval-unit').textContent = { daily: '일마다', weekly: '주마다', monthly: '개월마다' }[frequency];
    const custom = $('#routine-custom-times').checked;
    $('#routine-common-time-field').classList.toggle('hidden', custom);
    $('#routine-time').disabled = custom;
    $('#routine-day-times').classList.toggle('hidden', !custom);
    const selected = frequency === 'weekly' ? [...document.querySelectorAll('#routine-weekdays input:checked')].map((input) => Number(input.value)) : [0, 1, 2, 3, 4, 5, 6];
    document.querySelectorAll('.routine-day-time-row').forEach((row) => {
      const active = custom && selected.includes(Number(row.dataset.day));
      row.classList.toggle('hidden', !active);
      row.querySelector('input').disabled = !active;
    });
    const timed = custom ? selected.some((day) => Boolean($(`#routine-time-day-${day}`)?.value)) : Boolean($('#routine-time').value);
    $('#routine-show-in-planner').disabled = !timed || $('#routine-placement').value === 'bottom';
    if (!timed || $('#routine-placement').value === 'bottom') $('#routine-show-in-planner').checked = false;
  }

  function openRoutineDialog(routine = null, task = null, sub = null) {
    editingRoutineId = routine?.id || null;
    routineContext = task ? { taskId: task.id, subId: sub?.id || null } : null;
    $('#routine-form').reset();
    $('#routine-dialog-title').textContent = routine ? '루틴 수정하기' : '루틴 만들기';
    $('#routine-title').value = routine?.title || sub?.title || task?.title || '';
    $('#routine-note').value = routine?.note || (sub ? '' : task?.note) || '';
    $('#routine-time').value = routine?.time || '';
    $('#routine-custom-times').checked = Boolean(routine?.dayTimes);
    $('#routine-day-times').innerHTML = [1, 2, 3, 4, 5, 6, 0].map((day) => `<div class="routine-day-time-row day-time-row" data-day="${day}"><label for="routine-time-day-${day}">${['일','월','화','수','목','금','토'][day]}요일</label><input class="text-field" type="time" id="routine-time-day-${day}" aria-label="${['일','월','화','수','목','금','토'][day]}요일 루틴 시각" value="${escapeHTML(routine?.dayTimes?.[day] ?? routine?.time ?? '')}" /></div>`).join('');
    $('#routine-show-in-planner').checked = Boolean(routine?.showInPlanner);
    $('#routine-priority').value = routine?.priority || task?.priority || 'normal';
    $('#routine-placement').value = routine?.placement || task?.placement || 'auto';
    window.TodoPlanner.fillCategories($('#routine-category'), routine?.categoryId || task?.categoryId || '');
    $('#routine-frequency').value = routine?.frequency || 'weekly';
    $('#routine-interval').value = routine?.interval || 1;
    $('#routine-start').value = routine?.startDate || selectedDate;
    $('#routine-end').value = routine?.endDate || '';
    $('#routine-end').min = $('#routine-start').value;
    $('#routine-monthday').value = routine?.monthDay || parseDate($('#routine-start').value).getDate();
    const weekdays = routine?.weekdays || [1, 2, 3, 4, 5];
    document.querySelectorAll('#routine-weekdays input').forEach((input) => { input.checked = weekdays.includes(Number(input.value)); });
    $('#routine-summary').textContent = sub ? `${task.title}의 하위 할 일을 반복해요.` : routine?.subtask ? `${routine.parentTitle}의 하위 할 일을 반복해요.` : '이 할 일을 루틴으로 이어가요.';
    $('#routine-summary').classList.toggle('hidden', !task && !routine?.subtask);
    $('#delete-routine').classList.toggle('hidden', !routine);
    $('#routine-edit-help').classList.toggle('hidden', !routine);
    $('#routine-error').textContent = '';
    updateRoutineFields();
    $('#routine-dialog').showModal();
    $('#routine-title').focus();
  }

  function deleteRoutine(id) {
    const routine = routines.find((item) => item.id === id);
    if (!routine || !confirm(`“${routine.title}” 루틴을 삭제할까요? 과거 기록과 완료한 일정은 남고, 오늘 이후의 미완료 일정은 삭제돼요.`)) return;
    tasks = tasks.filter((task) => task.routineId !== id || (task.routineDate || task.date) < iso(today) || task.done || (routine.subtask && task.subtasks.some((sub) => sub.routineId === id && sub.done)));
    routines = routines.filter((item) => item.id !== id);
    if (selectedRoutineId === id) selectedRoutineId = '';
    $('#routine-dialog').close();
    persist();
    toast('루틴을 삭제했어요. 과거 기록은 남겨두었어요.');
  }

  function render() {
    generateRoutineTasks();
    window.TodoPlanner.prepare();
    const todays = tasks.filter((t) => t.date === iso(today));
    $('#today-count').textContent = todays.filter((t) => !t.done).length + window.TodoPlanner.dayPlans(iso(today)).filter((plan) => !plan.done && !plan.blocked).length;
    $('#all-count').textContent = tasks.filter((t) => !t.done).length;
    $('#routine-count').textContent = routines.length;
    $('#crumb-label').textContent = dateNames[view];
    $('#date-eyebrow').textContent = view === 'day' ? (selectedDate === iso(today) ? 'MY DAY' : 'YOUR DAY') : view.toUpperCase();
    $('#page-title').textContent = view === 'day' ? (selectedDate === iso(today) ? '오늘의 할 일' : fmtDate(selectedDate, { month: 'long', day: 'numeric' })) : dateNames[view];
    $('#page-subtitle').textContent = view === 'day' ? (selectedDate === iso(today) ? '작은 한 걸음부터 시작해요.' : '이 날의 계획을 확인해요.') : view === 'routines' ? '반복하는 작은 습관, 달력에 쌓이는 나의 기록.' : view === 'upcoming' ? '마감이 가까운 순으로 표시해요. 마감 없는 할 일은 계획 날짜순이에요.' : view === 'completed' ? '지금까지 해낸 일들이에요.' : '생각나는 일을 모두 담아두세요.';
    const routineView = view === 'routines';
    const extendedView = ['overview', 'planner', 'events'].includes(view);
    $('.summary-row').classList.toggle('hidden', routineView || extendedView);
    $('.list-toolbar').classList.toggle('hidden', routineView || extendedView);
    list.classList.toggle('hidden', routineView || extendedView);
    $('#routine-list').classList.toggle('hidden', !routineView);
    $('#new-routine').classList.toggle('hidden', routineView || ['planner', 'events'].includes(view));
    const createLabel = routineView ? '새 루틴' : view === 'planner' ? '새 플랜' : view === 'events' ? '새 일정' : '새 할 일';
    $('#new-task').innerHTML = `<span>＋</span> ${createLabel}`;
    $('#new-task').setAttribute('aria-label', `${createLabel} 만들기`);
    if (view === 'planner' || view === 'events') $('#new-task').dataset.plannerAction = view === 'planner' ? 'new-plan' : 'new-event';
    else delete $('#new-task').dataset.plannerAction;
    $('.main-area').dataset.view = view;
    $('#list-day-control').classList.toggle('hidden', view !== 'day');
    $('#list-jump-date').value = selectedDate;
    $('#task-controls').classList.toggle('hidden', !['day', 'overview'].includes(view));
    $('#bulk-move').title = `${fmtDate(selectedDate)}의 일반 미완료 할 일을 옮겨요`;
    const selectedItems = view === 'all' ? tasks : view === 'completed' ? tasks.filter((t) => t.done) : view === 'upcoming' ? window.TodoDeadline.upcoming(tasks, iso(today)) : [...tasks.filter((t) => t.date === selectedDate), ...(view === 'day' ? window.TodoPlanner.dayPlans(selectedDate).filter((plan) => !plan.blocked) : [])];
    $('#progress-scope').textContent = view === 'day' ? (selectedDate === iso(today) ? '오늘의 진행률' : '이 날의 진행률') : '목록 진행률';
    const remaining = selectedItems.filter((t) => !t.done).length;
    const done = selectedItems.filter((t) => t.done).length;
    const percent = selectedItems.length ? Math.round(done / selectedItems.length * 100) : 0;
    $('#summary-open').textContent = remaining; $('#summary-done').textContent = done;
    $('#progress-label').textContent = `${percent}%`; $('#progress-bar').style.width = `${percent}%`;
    document.querySelectorAll('.nav-item').forEach((el) => {
      el.classList.toggle('active', el.dataset.view === view);
      el.setAttribute('aria-label', dateNames[el.dataset.view]);
      el.title = dateNames[el.dataset.view];
      if (el.dataset.view === view) el.setAttribute('aria-current', 'page');
      else el.removeAttribute('aria-current');
    });
    const mobileNav = $('.mobile-nav');
    const currentNav = mobileNav.querySelector('.active');
    if (mobileNav.clientWidth && currentNav) mobileNav.scrollLeft = currentNav.offsetLeft - mobileNav.clientWidth / 2 + currentNav.offsetWidth / 2;
    $('#month-label').textContent = shownMonth.toLocaleDateString('ko-KR', { year: 'numeric', month: 'long' });
    $('#selected-date-label').textContent = fmtDate(selectedDate);
    renderDayFilters(); renderRoutineSelector(); renderCalendar(); renderTaskList(); renderAgenda(); renderRoutineList();
    window.TodoPlanner.render();
  }

  function renderRoutineSelector() {
    const plans = plannerRecords.filter((item) => item.type === 'plan' && item.showInCalendar === true);
    if (!routines.some((routine) => routine.id === selectedRoutineId) && !plans.some((plan) => `plan:${plan.id}` === selectedRoutineId)) selectedRoutineId = '';
    $('#calendar-routine').innerHTML = '<option value="">전체 할 일</option><optgroup label="플랜별 기록">' + plans.map((plan) => `<option value="plan:${escapeHTML(plan.id)}">${escapeHTML(plan.title)}${plan.deletedFrom ? ' (삭제된 플랜)' : ''}</option>`).join('') + '</optgroup><optgroup label="루틴별 기록">' + routines.map((routine) => `<option value="${escapeHTML(routine.id)}">${escapeHTML(routine.title)}</option>`).join('') + '</optgroup>';
    $('#calendar-routine').value = selectedRoutineId;
    $('#task-calendar-legend').classList.toggle('hidden', Boolean(selectedRoutineId));
    $('#routine-calendar-legend').classList.toggle('hidden', !selectedRoutineId);
  }

  function renderRoutineList() {
    if (!routines.length) {
      $('#routine-list').innerHTML = '<div class="empty-state"><div class="empty-icon">↻</div><h3>꾸준히 하고 싶은 일이 있나요?</h3><p>요일과 기간을 정하면 할 일에 자동으로 추가돼요.</p><button class="text-link" data-action="newroutine">＋ 첫 루틴 만들기</button></div>';
      return;
    }
    $('#routine-list').innerHTML = routines.map((routine) => {
      const status = schedule.occurrenceStatus(routine, iso(today), tasks, iso(today));
      const timeDescription = routine.dayTimes ? [1, 2, 3, 4, 5, 6, 0].filter((day) => routine.dayTimes[day]).map((day) => `${['일','월','화','수','목','금','토'][day]} ${routine.dayTimes[day]}`).join(' · ') : routine.time;
      const ended = routine.endDate && routine.endDate < iso(today);
      const label = ended ? '기간 종료' : routine.startDate > iso(today) ? '시작 예정' : { done: '오늘 완료', pending: '오늘 할 루틴', off: '오늘은 쉬는 날' }[status] || '반복 중';
      return `<article class="routine-card"><div class="routine-card-heading"><span class="routine-icon">↻</span><div><h3>${escapeHTML(routine.title)}</h3><p>${escapeHTML(schedule.describeRoutine(routine))}</p></div><span class="routine-state ${status === 'done' ? 'done' : ''}">${label}</span></div>${routine.note ? `<p class="routine-card-note">${escapeHTML(routine.note)}</p>` : ''}<p class="routine-period">${escapeHTML(fmtDate(routine.startDate, { year: 'numeric', month: 'short', day: 'numeric' }))} — ${routine.endDate ? escapeHTML(fmtDate(routine.endDate, { year: 'numeric', month: 'short', day: 'numeric' })) : '계속 반복'}</p>${timeDescription ? `<p class="routine-time-settings">◷ ${escapeHTML(timeDescription)} · ${routine.showInPlanner ? '시간표 표시' : '목록 표시'}</p>` : ''}<div class="routine-card-actions"><button class="secondary-button" data-action="routinecalendar" data-routine="${escapeHTML(routine.id)}">달력 기록 보기</button><button class="text-link" data-action="editroutine" data-routine="${escapeHTML(routine.id)}">수정</button><button class="text-link danger-text" data-action="deleteroutine" data-routine="${escapeHTML(routine.id)}">삭제</button></div></article>`;
    }).join('');
  }

  function renderTaskList() {
    const items = getVisibleTasks();
    const query = $('#search-input').value.trim().toLocaleLowerCase('ko');
    const plans = view === 'day' ? window.TodoPlanner.dayPlans(selectedDate).filter((plan) => matchesDayFilters(plan, 'plan') && (filter !== 'done' || plan.done) && (filter !== 'active' || (!plan.done && !plan.blocked)) && (!query || `${plan.title} ${plan.note || ''}`.toLocaleLowerCase('ko').includes(query))) : [];
    plans.sort((a, b) => daySortTime(a, a.startTime) - daySortTime(b, b.startTime));
    const planCards = plans.map((plan) => window.TodoPlanner.dayPlanCard(plan, selectedDate)).join('');
    if (!items.length && !plans.length) {
      const headline = $('#search-input').value.trim() || (view === 'day' && (dayCategories || dayKinds)) ? '검색 결과가 없어요' : filter === 'done' ? '아직 완료한 일이 없어요' : filter === 'active' ? '진행 중인 일이 없어요' : view === 'day' ? '이 날은 여유롭네요' : '아직 할 일이 없어요';
      const copy = $('#search-input').value.trim() || (view === 'day' && (dayCategories || dayKinds)) ? '다른 단어로 찾아보거나 새 할 일을 추가해보세요.' : '해야 할 일을 적어두면 여기에 모아둘게요.';
      list.innerHTML = `<div class="empty-state"><div class="empty-icon">✦</div><h3>${headline}</h3><p>${copy}</p><button class="text-link" data-action="new">＋ 할 일 추가하기</button></div>`;
      return;
    }
    list.innerHTML = items.map((task) => {
      const count = task.subtasks.length;
      const priority = task.priority !== 'normal' ? `<span class="priority ${task.priority}">${task.priority === 'high' ? '높음' : '낮음'}</span>` : '';
      const dateMeta = view !== 'day' ? `<span>◷ ${escapeHTML(fmtDate(task.date, { month: 'short', day: 'numeric' }))}</span>` : '';
      const routineMeta = task.routineId && routines.some((routine) => routine.id === task.routineId) ? `<button class="routine-badge" data-action="routinecalendar" data-routine="${escapeHTML(task.routineId)}">↻ 루틴</button>` : '';
      const categoryMeta = window.TodoPlanner.categoryBadge(task.categoryId);
      const timeMeta = task.routineTime ? `<span class="routine-time-meta">◷ ${escapeHTML(task.routineTime)}</span>` : '';
      const deadlineMeta = window.TodoDeadline.describe(task);
      const subtasks = task.subtasks.map((sub) => {
        const isEditing = editingSubtaskId === `${task.id}:${sub.id}`;
        const title = isEditing
          ? `<form class="subtask-edit" data-task="${task.id}" data-sub="${sub.id}"><input class="subtask-edit-input" maxlength="120" value="${escapeHTML(sub.title)}" aria-label="하위 할 일 수정"><button type="submit" aria-label="수정 저장">저장</button><button type="button" data-action="canceleditsub" aria-label="수정 취소">취소</button></form>`
          : `<button type="button" class="subtask-title" data-action="subtaskmenu" data-task="${task.id}" data-sub="${sub.id}" title="할 일 작업">${escapeHTML(sub.title)}</button>`;
        return `<div class="subtask-row ${sub.done ? 'done' : ''}"><input type="checkbox" data-action="subtoggle" data-task="${task.id}" data-sub="${sub.id}" ${sub.done ? 'checked' : ''} aria-label="${escapeHTML(sub.title)} 완료">${title}<button type="button" class="subtask-delete" data-action="subdelete" data-task="${task.id}" data-sub="${sub.id}" aria-label="하위 주제 삭제">×</button></div>`;
      }).join('');
      const subtaskInput = addingSubtaskFor === task.id
        ? `<form class="subtask-entry" data-task="${task.id}"><input id="subtask-entry" maxlength="120" placeholder="하위 주제 입력…" aria-label="하위 주제 입력" autocomplete="off"><button type="submit" aria-label="하위 주제 저장">추가</button><button type="button" data-action="cancelsub" aria-label="입력 취소">취소</button></form>`
        : `<button type="button" class="subtask-add" data-action="addsub" data-id="${task.id}">＋ 하위 주제 추가</button>`;
      return `<article data-task-id="${task.id}" class="task-card ${task.done ? 'is-done' : ''}"><button type="button" draggable="true" class="task-drag" data-drag-task="${task.id}" aria-label="할일 순서 변경">⠿</button><input type="checkbox" class="task-check" data-action="toggle" data-id="${task.id}" ${task.done ? 'checked' : ''} aria-label="${escapeHTML(task.title)} 완료"><div class="task-body"><div class="task-title-line"><button type="button" class="task-title" data-action="taskmenu" data-id="${task.id}" title="할 일 작업">${escapeHTML(task.title)}</button><div class="task-tools"><button type="button" data-action="taskmenu" data-id="${task.id}" title="할 일 작업" aria-label="할 일 작업">···</button></div></div><textarea class="inline-note" data-note-task="${task.id}" rows="1" maxlength="500" placeholder="메모 추가" aria-label="${escapeHTML(task.title)} 메모">${escapeHTML(task.note || '')}</textarea><div class="task-meta">${dateMeta}${routineMeta}${categoryMeta}${timeMeta}${priority}${deadlineMeta ? `<span class="deadline-badge ${!task.done && window.TodoDeadline.timestamp(task) < Date.now() ? 'overdue' : ''}">${escapeHTML(deadlineMeta)}</span>` : ''}${count ? `<span class="subtask-progress">▦ ${subtasksDone(task)}/${count}</span>` : ''}</div><div class="subtask-list">${subtasks}${subtaskInput}</div></div></article>`;
    }).join('') + planCards;
    window.TodoPlanner.resizeNotes(list);
  }

  function renderCalendar() {
    const year = shownMonth.getFullYear(), month = shownMonth.getMonth();
    const first = new Date(year, month, 1), start = new Date(year, month, 1 - first.getDay());
    const weekdays = ['일', '월', '화', '수', '목', '금', '토'].map((d) => `<div class="weekday">${d}</div>`).join('');
    let days = '';
    const routine = routines.find((item) => item.id === selectedRoutineId);
    const statusNames = { done: '루틴 완료', missed: '루틴 미완료', pending: '오늘 대기', planned: '루틴 예정', off: '반복 없는 날' };
    for (let i = 0; i < 42; i++) {
      const date = new Date(start); date.setDate(start.getDate() + i);
      const key = iso(date), outside = date.getMonth() !== month;
      const planHistory = selectedRoutineId === '__plans' || selectedRoutineId.startsWith('plan:');
      const info = window.TodoPlanner.calendarInfo(key, selectedRoutineId.startsWith('plan:') ? selectedRoutineId.slice(5) : null);
      const status = routine ? schedule.occurrenceStatus(routine, key, tasks, iso(today)) : planHistory ? info.status : '';
      const classes = ['calendar-day', outside ? 'outside' : '', key === iso(today) ? 'today' : '', key === selectedDate ? 'selected' : '', view === 'overview' && window.TodoPlannerCore.weekStart(key) === window.TodoPlannerCore.weekStart(selectedDate) ? 'viewed-week' : '', routine || planHistory ? `routine-${status}` : tasks.some((t) => t.date === key && !t.done) || info.events ? 'has-task' : '', info.events ? 'has-event' : ''].filter(Boolean).join(' ');
      const description = routine ? statusNames[status] : planHistory ? info.description : info.events ? '일정 있음' : tasks.some((t) => t.date === key) ? '할 일 있음' : '할 일 없음';
      days += `<button class="${classes}" data-date="${key}" aria-pressed="${key === selectedDate}" aria-label="${date.toLocaleDateString('ko-KR')}, ${description}" title="${description}">${date.getDate()}${(routine || planHistory) && status === 'done' ? '<span class="day-status-mark">✓</span>' : (routine || planHistory) && status === 'missed' ? '<span class="day-status-mark">−</span>' : ''}</button>`;
    }
    $('#calendar-grid').innerHTML = weekdays + days;
    if (selectedRoutineId === '__plans' || selectedRoutineId.startsWith('plan:')) window.TodoPlanner.renderCalendarHistory(selectedDate, shownMonth, selectedRoutineId.startsWith('plan:') ? selectedRoutineId.slice(5) : null);
    else renderRoutineHistory(routine);
  }

  function renderRoutineHistory(routine) {
    $('#routine-month-stats').classList.toggle('hidden', !routine);
    $('#routine-day-detail').classList.toggle('hidden', !routine);
    if (!routine) return;
    const stats = { done: 0, missed: 0, pending: 0, planned: 0 };
    const end = new Date(shownMonth.getFullYear(), shownMonth.getMonth() + 1, 0).getDate();
    for (let day = 1; day <= end; day++) {
      const key = iso(new Date(shownMonth.getFullYear(), shownMonth.getMonth(), day));
      const status = schedule.occurrenceStatus(routine, key, tasks, iso(today));
      if (status !== 'off') stats[status]++;
    }
    const elapsed = stats.done + stats.missed;
    $('#routine-month-stats').innerHTML = `<div><b>${stats.done}</b><span>완료</span></div><div><b>${stats.missed}</b><span>미완료</span></div><div><b>${elapsed ? Math.round(stats.done / elapsed * 100) : 0}%</b><span>수행률</span></div><p>선택한 달의 기록 · 오늘 대기와 예정일 제외</p>`;
    const status = schedule.occurrenceStatus(routine, selectedDate, tasks, iso(today));
    const labels = { done: '완료했어요', missed: '수행하지 못했어요', pending: '오늘의 루틴이 기다려요', planned: '예정된 루틴이에요', off: '루틴을 쉬는 날이에요' };
    $('#routine-day-detail').innerHTML = `<span class="routine-detail-date">${escapeHTML(fmtDate(selectedDate))}</span><strong>${escapeHTML(routine.title)}</strong><p class="status-${status}">${labels[status]}</p>${status !== 'off' && selectedDate <= iso(today) ? `<button class="secondary-button" data-action="routinetoggle" data-routine="${escapeHTML(routine.id)}" data-occurrence="${selectedDate}">${status === 'done' ? '완료 취소하기' : '완료로 기록하기'}</button>` : ''}`;
  }

  function renderAgenda() {
    const items = sortTasks(tasks.filter((t) => t.date === selectedDate && (!selectedRoutineId || selectedRoutineId === '__plans' || selectedRoutineId.startsWith('plan:') || t.routineId === selectedRoutineId)));
    $('#agenda-title').textContent = selectedDate === iso(today) ? '오늘의 일정' : fmtDate(selectedDate, { month: 'long', day: 'numeric' });
    $('#agenda-count').textContent = items.length ? `${items.filter((t) => !t.done).length}개 남음` : '할 일이 없어요';
    $('#agenda-list').innerHTML = items.slice(0, 5).map((task) => `<div class="agenda-item ${task.done ? 'done' : ''}"><button class="agenda-check ${task.done ? 'done' : ''}" data-action="toggle" data-id="${task.id}" aria-label="${escapeHTML(task.title)} 완료">${task.done ? '✓' : ''}</button><button type="button" class="agenda-title" data-action="taskmenu" data-id="${task.id}" title="할 일 작업">${escapeHTML(task.title)}</button></div>`).join('');
  }

  function updateTaskPlanOptions(preferred = $('#task-plan').value) {
    const date = $('#task-date').value, categoryId = $('#task-category').value;
    const task = tasks.find((item) => item.id === editingId);
    const time = window.TodoPlannerCore.minutes(task?.routineTime);
    const candidates = schedule.validDate(date) && categoryId ? window.TodoPlannerCore.dayModel(plannerRecords, [], date).plans.filter((plan) => plan.categoryId === categoryId && (!Number.isFinite(time) || (plan.start <= time && time < plan.end))) : [];
    const select = $('#task-plan');
    select.replaceChildren(new Option('자동 선택 · 첫 수행 가능한 플랜', ''), ...candidates.map((plan) => new Option(`${plan.title} · ${plan.startTime}–${plan.endTime}${plan.blocked ? ' · 일정으로 제외' : ''}`, plan.id)));
    if (preferred && !candidates.some((plan) => plan.id === preferred)) {
      const plan = plannerRecords.find((item) => item.id === preferred && item.type === 'plan');
      select.add(new Option(`${plan?.title || '지정한 플랜'} · 현재 날짜·카테고리에 맞지 않음 (목록에 표시)`, preferred));
    }
    select.value = preferred || '';
    $('#task-plan-field').classList.toggle('hidden', $('#task-placement').value === 'bottom');
    select.disabled = $('#task-placement').value === 'bottom';
  }

  function openDialog(task = null) {
    editingId = task?.id ?? null;
    $('#dialog-title').textContent = task ? '할 일 수정' : '새 할 일';
    $('#dialog-eyebrow').textContent = task ? 'EDIT TASK' : 'NEW TASK';
    $('#task-title').value = task?.title ?? '';
    $('#task-note').value = task?.note ?? '';
    $('#task-date').value = task?.date ?? selectedDate;
    $('#task-deadline').value = window.TodoDeadline.inputValue(task || {});
    $('#task-priority').value = task?.priority ?? 'normal';
    $('#task-placement').value = task?.placement || 'auto';
    window.TodoPlanner.fillCategories($('#task-category'), task?.categoryId || '');
    updateTaskPlanOptions(task?.planId || '');
    $('#delete-task').classList.toggle('hidden', !task);
    dialog.showModal(); setTimeout(() => $('#task-title').focus(), 50);
  }
  function closeDialog() { dialog.close(); editingId = null; }
  function saveTask(event) {
    event.preventDefault();
    const title = $('#task-title').value.trim(); if (!title) return;
    const deadline = $('#task-deadline').value;
    if (deadline && !Number.isFinite(new Date(deadline).getTime())) return;
    const values = { title, note: $('#task-note').value.trim(), date: $('#task-date').value, deadline: deadline ? new Date(deadline).toISOString() : null, priority: $('#task-priority').value, categoryId: $('#task-category').value, placement: $('#task-placement').value, planId: $('#task-plan').value || null };
    let changedTask;
    if (editingId) { changedTask = tasks.find((t) => t.id === editingId); if (changedTask.routineId && !changedTask.routineDate) changedTask.routineDate = changedTask.date; Object.assign(changedTask, values); toast('할 일을 수정했어요.'); }
    else { const now = Date.now(); changedTask = { id: uid(), ...values, done: false, subtasks: [], createdAt: now, updatedAt: now }; tasks.push(changedTask); toast('할 일을 저장했어요.'); }
    if (!editingId || followDate()) { selectedDate = values.date; shownMonth = new Date(parseDate(values.date).getFullYear(), parseDate(values.date).getMonth(), 1); }
    closeDialog(); persist(changedTask);
  }

  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-action]');
    if (target) {
      const task = tasks.find((t) => t.id === target.dataset.id || t.id === target.dataset.task);
      switch (target.dataset.action) {
        case 'new': openDialog(); break;
        case 'newroutine': openRoutineDialog(); break;
        case 'editroutine': openRoutineDialog(routines.find((routine) => routine.id === target.dataset.routine)); break;
        case 'deleteroutine': deleteRoutine(target.dataset.routine); break;
        case 'routinecalendar':
          selectedRoutineId = target.dataset.routine;
          render();
          $('#calendar-routine').focus();
          $('.calendar-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          break;
        case 'routinetoggle': {
          const routine = routines.find((item) => item.id === target.dataset.routine);
          const date = target.dataset.occurrence;
          if (!routine || date > iso(today) || schedule.occurrenceStatus(routine, date, tasks, iso(today)) === 'off') break;
          let occurrence = schedule.occurrenceTask(tasks, routine, date);
          if (!occurrence) { occurrence = buildRoutineTask(routine, date); tasks.push(occurrence); if (!routine.occurrences.includes(date)) routine.occurrences.push(date); }
          if (routine.subtask) {
            let sub = occurrence.subtasks.find((item) => item.routineId === routine.id);
            if (!sub) { sub = { id: uid(), title: routine.title, done: false, routineId: routine.id }; occurrence.subtasks.push(sub); }
            sub.done = !sub.done;
            occurrence.done = occurrence.subtasks.every((item) => item.done);
          } else { occurrence.done = !occurrence.done; occurrence.subtasks.forEach((sub) => { sub.done = occurrence.done; }); }
          persist(occurrence);
          break;
        }
        case 'edit': if (task) openDialog(task); break;
        case 'taskmenu': if (task) openTaskActions(task); break;
        case 'subtaskmenu': if (task) openTaskActions(task, task.subtasks.find((sub) => sub.id === target.dataset.sub)); break;
        case 'toggle': if (task) { task.done = !task.done; task.subtasks.forEach((sub) => { sub.done = task.done; }); persist(task); } break;
        case 'addsub': if (task) { addingSubtaskFor = task.id; renderTaskList(); $('#subtask-entry')?.focus(); } break;
        case 'cancelsub': addingSubtaskFor = null; renderTaskList(); break;
        case 'canceleditsub': editingSubtaskId = null; renderTaskList(); break;
        case 'subdelete': if (task) { task.subtasks = task.subtasks.filter((s) => s.id !== target.dataset.sub); persist(task); } break;
      }
    }
    const day = event.target.closest('[data-date]');
    if (day) { selectedDate = day.dataset.date; const date = parseDate(selectedDate); shownMonth = new Date(date.getFullYear(), date.getMonth(), 1); if (view !== 'overview') view = 'day'; render(); }
  });
  $('#task-actions-dialog').addEventListener('click', (event) => {
    const button = event.target.closest('[data-task-action]');
    if (!button) return;
    const { task, sub } = currentActionTarget();
    const action = button.dataset.taskAction;
    $('#task-actions-dialog').close();
    if (!task) return;
    if (action === 'date') {
      dateContext = { taskId: task.id, subId: sub?.id ?? null };
      $('#move-date').value = task.date;
      $('#move-deadline').textContent = window.TodoDeadline.describe(task) || '마감이 설정되지 않은 할 일이에요.';
      $('#date-dialog').showModal();
    } else if (action === 'today') {
      if (task.routineId && !task.routineDate) task.routineDate = task.date;
      task.date = iso(today);
      if (followDate()) { selectedDate = task.date; shownMonth = new Date(today.getFullYear(), today.getMonth(), 1); }
      persist(task);
      toast('오늘 할 일로 옮겼어요.');
    } else if (action === 'routine') {
      registerRoutine(task, sub);
    } else if (action === 'edit') {
      if (sub) {
        editingSubtaskId = `${task.id}:${sub.id}`;
        renderTaskList();
        const input = $('.subtask-edit-input'); input?.focus(); input?.select();
      } else openDialog(task);
    } else if (action === 'delete') {
      const message = sub ? '이 하위 할 일을 삭제할까요?' : '이 할 일을 삭제할까요? 하위 할 일도 함께 삭제돼요.';
      if (confirm(message)) {
        if (sub) task.subtasks = task.subtasks.filter((item) => item.id !== sub.id);
        else tasks = tasks.filter((item) => item.id !== task.id);
        persist(task);
        toast('삭제했어요.');
      }
    }
  });
  $('#close-task-actions').addEventListener('click', () => $('#task-actions-dialog').close());
  document.querySelectorAll('[data-close-dialog]').forEach((button) => button.addEventListener('click', () => document.getElementById(button.dataset.closeDialog).close()));
  $('#date-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const task = tasks.find((item) => item.id === dateContext?.taskId);
    if (!task) return;
    if (task.routineId && !task.routineDate) task.routineDate = task.date;
    task.date = $('#move-date').value;
    const movedDate = parseDate(task.date);
    if (followDate()) { selectedDate = task.date; shownMonth = new Date(movedDate.getFullYear(), movedDate.getMonth(), 1); }
    $('#date-dialog').close();
    persist(task);
    toast('날짜를 바꿨어요.');
  });
  $('#routine-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const existing = routines.find((item) => item.id === editingRoutineId);
    const task = routineContext ? tasks.find((item) => item.id === routineContext.taskId) : null;
    const sub = task?.subtasks.find((item) => item.id === routineContext?.subId);
    const title = $('#routine-title').value.trim();
    const startDate = $('#routine-start').value, endDate = $('#routine-end').value;
    const frequency = $('#routine-frequency').value;
    const weekdays = [...document.querySelectorAll('#routine-weekdays input:checked')].map((input) => Number(input.value));
    const customTimes = $('#routine-custom-times').checked;
    const time = customTimes ? '' : $('#routine-time').value;
    const timeDays = frequency === 'weekly' ? weekdays : [0, 1, 2, 3, 4, 5, 6];
    const dayTimes = customTimes ? Object.fromEntries(timeDays.map((day) => [day, $(`#routine-time-day-${day}`).value])) : null;
    const validTimes = [time, ...Object.values(dayTimes || {})].every((value) => !value || /^([01]\d|2[0-3]):[0-5]\d$/.test(value));
    const error = !title ? '루틴 이름을 입력해 주세요.' : !schedule.validDate(startDate) ? '시작 날짜를 확인해 주세요.' : endDate && (!schedule.validDate(endDate) || endDate < startDate) ? '종료 날짜는 시작 날짜 이후로 설정해 주세요.' : frequency === 'weekly' && !weekdays.length ? '반복할 요일을 하나 이상 선택해 주세요.' : !validTimes ? '요일별 수행 시각을 확인해 주세요.' : '';
    $('#routine-error').textContent = error;
    if (error) return;
    const now = Date.now();
    const routine = schedule.normalizeRoutine({ ...existing, id: existing?.id || uid(), type: 'routine', title, note: $('#routine-note').value.trim(), categoryId: $('#routine-category').value, priority: $('#routine-priority').value, placement: $('#routine-placement').value, time, dayTimes, showInPlanner: $('#routine-show-in-planner').checked, frequency, interval: Number($('#routine-interval').value), monthDay: Number($('#routine-monthday').value), startDate, endDate, weekdays, subtask: existing?.subtask || Boolean(sub), parentTitle: existing?.parentTitle || task?.title || title, occurrences: existing?.occurrences || [], createdAt: existing?.createdAt || now, updatedAt: now });
    if (existing) {
      tasks = tasks.filter((item) => item.routineId !== existing.id || (item.routineDate || item.date) < iso(today) || item.done || (routine.subtask && item.subtasks.some((child) => child.routineId === routine.id && child.done)));
      routine.occurrences = [...new Set([...existing.occurrences.filter((date) => date < iso(today)), ...tasks.filter((item) => item.routineId === routine.id).map((item) => item.routineDate || item.date)])];
      routine.scheduleChangedOn = iso(today);
      routine.historyDates = [...new Set([...(existing.historyDates || []), ...routine.occurrences.filter((date) => date < iso(today))])];
      routines = routines.map((item) => item.id === routine.id ? routine : item);
    } else {
      routines.push(routine);
      if (task && schedule.isScheduled(routine, task.date)) {
        task.routineId = routine.id;
        task.routineDate = task.date;
        task.routineTime = schedule.routineTimeOn(routine, task.routineDate || task.date);
        task.placement = routine.placement;
        if (sub) sub.routineId = routine.id;
        routine.occurrences.push(task.date);
        task.updatedAt = now;
      }
    }
    selectedRoutineId = routine.id;
    $('#routine-dialog').close();
    persist(routine);
    toast(existing ? '루틴을 수정했어요.' : '루틴을 만들었어요. 달력에서 기록을 확인해 보세요.');
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
        sub.done = input.checked; task.done = task.subtasks.length > 0 && task.subtasks.every((item) => item.done);
        persist(task);
      }
    }
  });
  document.querySelectorAll('.nav-item').forEach((button) => button.addEventListener('click', () => { view = button.dataset.view; filter = 'all'; document.querySelectorAll('.filter-tab').forEach((t) => t.classList.toggle('selected', t.dataset.filter === 'all')); render(); }));
  document.querySelectorAll('.filter-tab').forEach((button) => button.addEventListener('click', () => { filter = button.dataset.filter; document.querySelectorAll('.filter-tab').forEach((t) => t.classList.toggle('selected', t === button)); renderTaskList(); }));
  $('#new-task').addEventListener('click', () => { if (view === 'planner' || view === 'events') return; view === 'routines' ? openRoutineDialog() : openDialog(); }); $('#agenda-add').addEventListener('click', () => openDialog());
  $('#new-routine').addEventListener('click', () => openRoutineDialog());
  $('#routine-frequency').addEventListener('change', updateRoutineFields);
  $('#routine-time').addEventListener('input', updateRoutineFields);
  $('#routine-placement').addEventListener('change', updateRoutineFields);
  $('#routine-form').addEventListener('input', (event) => {
    if (event.target.id === 'routine-custom-times' && event.target.checked) document.querySelectorAll('#routine-day-times input').forEach((input) => { if (!input.value) input.value = $('#routine-time').value; });
    if (event.target.id === 'routine-custom-times' || event.target.closest('#routine-day-times, #routine-weekdays')) updateRoutineFields();
  });
  $('#clear-routine-time').addEventListener('click', () => { $('#routine-time').value = ''; document.querySelectorAll('#routine-day-times input').forEach((input) => { input.value = ''; }); updateRoutineFields(); });
  $('#routine-start').addEventListener('change', () => { $('#routine-end').min = $('#routine-start').value; });
  $('#delete-routine').addEventListener('click', () => deleteRoutine(editingRoutineId));
  $('#calendar-routine').addEventListener('change', (event) => { selectedRoutineId = event.target.value; render(); });
  $('#prev-month').addEventListener('click', () => { shownMonth = new Date(shownMonth.getFullYear(), shownMonth.getMonth() - 1, 1); render(); });
  $('#next-month').addEventListener('click', () => { shownMonth = new Date(shownMonth.getFullYear(), shownMonth.getMonth() + 1, 1); render(); });
  function showToday() { selectedDate = iso(today); shownMonth = new Date(today.getFullYear(), today.getMonth(), 1); view = 'day'; filter = 'all'; selectedRoutineId = ''; $('#search-input').value = ''; document.querySelectorAll('.filter-tab').forEach((tab) => tab.classList.toggle('selected', tab.dataset.filter === 'all')); render(); }
  function showListDate(date) {
    if (!schedule.validDate(date)) return;
    selectedDate = date;
    const value = parseDate(date);
    shownMonth = new Date(value.getFullYear(), value.getMonth(), 1);
    render();
  }
  $('#list-jump-date').addEventListener('change', (event) => showListDate(event.target.value));
  $('#list-prev-day').addEventListener('click', () => showListDate(window.TodoPlannerCore.addDays(selectedDate, -1)));
  $('#list-next-day').addEventListener('click', () => showListDate(window.TodoPlannerCore.addDays(selectedDate, 1)));
  $('#list-today').addEventListener('click', showToday);
  $('#go-today').addEventListener('click', () => {
    if (view === 'overview') {
      selectedDate = iso(today);
      shownMonth = new Date(today.getFullYear(), today.getMonth(), 1);
      render();
    } else showToday();
  });
  $('#clear-task-deadline').addEventListener('click', () => { $('#task-deadline').value = ''; });
  $('#search-input').addEventListener('input', renderTaskList);
  $('#day-filters').addEventListener('change', (event) => {
    const group = event.target.dataset.dayFilter;
    if (!group) return;
    const selection = new Set([...document.querySelectorAll(`[data-day-filter="${group}"]:checked`)].map((input) => input.value));
    const value = selection.size === dayFilterOptions()[group].length ? null : selection;
    if (group === 'category') dayCategories = value; else dayKinds = value;
    updateDayFilterLabels(); renderTaskList();
  });
  $('#day-filters').addEventListener('click', (event) => {
    const group = event.target.dataset.dayFilterAll;
    if (group || event.target.id === 'reset-day-filters') {
      if (!group || group === 'category') dayCategories = null;
      if (!group || group === 'kind') dayKinds = null;
      renderDayFilters(); renderTaskList();
    }
  });
  document.addEventListener('click', (event) => {
    document.querySelectorAll('.day-filter-dropdown[open]').forEach((dropdown) => { if (!dropdown.contains(event.target)) dropdown.open = false; });
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') document.querySelectorAll('.day-filter-dropdown[open]').forEach((dropdown) => { dropdown.open = false; dropdown.querySelector('summary').focus(); });
  });

  for (const id of ['task-date', 'task-category', 'task-placement']) $(`#${id}`).addEventListener('change', () => updateTaskPlanOptions());
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
  document.addEventListener('input', (event) => {
    const id = event.target.dataset.noteTask;
    if (!id) return;
    const task = tasks.find((item) => item.id === id);
    if (task) { task.note = event.target.value; task.updatedAt = Date.now(); saveRecords(); }
    window.TodoPlanner.resizeNotes(event.target.parentElement);
  });
  let draggedTask = null;
  document.addEventListener('dragstart', (event) => {
    if (!event.target.dataset.dragTask) return;
    draggedTask = event.target.dataset.dragTask;
    event.dataTransfer.setData('text/plain', draggedTask);
    event.dataTransfer.effectAllowed = 'move';
  });
  list.addEventListener('dragover', (event) => { if (draggedTask && event.target.closest('[data-task-id]')) event.preventDefault(); });
  list.addEventListener('drop', (event) => {
    const target = event.target.closest('[data-task-id]');
    if (!draggedTask || !target) return;
    event.preventDefault();
    const items = getVisibleTasks();
    const source = items.find((item) => item.id === draggedTask);
    if (!source || source.id === target.dataset.taskId) return;
    const reordered = items.filter((item) => item !== source);
    reordered.splice(reordered.findIndex((item) => item.id === target.dataset.taskId), 0, source);
    reordered.forEach((item, order) => { item.order = order; item.updatedAt = Date.now(); });
    draggedTask = null; persist();
  });
  document.addEventListener('dragend', () => { draggedTask = null; });
  $('#bulk-move').addEventListener('click', () => {
    $('#bulk-move-date').value = selectedDate;
    $('#bulk-source').textContent = fmtDate(selectedDate);
    $('#bulk-dialog').dataset.source = selectedDate;
    $('#bulk-dialog').showModal();
  });
  $('#bulk-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const date = $('#bulk-move-date').value;
    if (!schedule.validDate(date)) return;
    const items = tasks.filter((item) => item.date === $('#bulk-dialog').dataset.source && !item.done && !item.routineId && !item.planId && !item.subtasks?.some((sub) => sub.routineId));
    items.forEach((item) => { item.date = date; item.updatedAt = Date.now(); });
    $('#bulk-dialog').close(); persist(); toast(`${items.length}개의 할 일을 옮겼어요.`);
  });
  $('#follow-task-date').checked = followDate();
  $('#follow-task-date').addEventListener('change', (event) => localStorage.setItem('todo-follow-date', String(event.target.checked)));
  window.TodoPlanner.init({
    getState: () => ({ tasks, routines, records: plannerRecords, today: iso(today), selectedDate, shownMonth: iso(shownMonth), view }),
    mutate: (fn) => { fn({ tasks, routines, records: plannerRecords }); persist(); },
    selectDate: (date, nextView = view) => { selectedDate = date; const d = parseDate(date); shownMonth = new Date(d.getFullYear(), d.getMonth(), 1); view = nextView; render(); },
    openTask: (date, task = null) => { selectedDate = date; openDialog(task); },
    toast,
  });
  generateRoutineTasks();
  render();
  updateAccountUI();
  restoreAuthCallback();
  restoreSession();
  window.TodoChatGPT.init({ getRemaining: () => sortTasks(tasks.filter((task) => task.date === iso(today) && !task.done)) });
  window.TodoReminders.init({
    getRemaining: () => window.TodoDeadline.remaining(tasks),
    showToday,
    onTick: () => {
      const now = new Date(); now.setHours(0, 0, 0, 0);
      if (iso(now) === iso(today)) return;
      const previous = iso(today);
      today.setTime(now.getTime());
      if (selectedDate === previous) { selectedDate = iso(today); shownMonth = new Date(today.getFullYear(), today.getMonth(), 1); }
      render();
    },
  });
})();

(() => {
  const SETTINGS_KEY = 'today-todos-reminder-v1';
  const FIRED_KEY = 'today-todos-reminder-fired-v1';
  const $ = (selector) => document.querySelector(selector);
  const escapeHTML = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  function loadSettings() {
    try {
      const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
      return { enabled: stored.enabled === true, time: /^([01]\d|2[0-3]):[0-5]\d$/.test(stored.time) ? stored.time : '20:00' };
    } catch { return { enabled: false, time: '20:00' }; }
  }

  function init({ getRemaining, showToday, onTick }) {
    let settings = loadSettings();
    const registration = 'serviceWorker' in navigator && window.isSecureContext
      ? navigator.serviceWorker.register('sw.js').then(() => navigator.serviceWorker.ready).catch(() => null)
      : Promise.resolve(null);

    function permissionUI() {
      const supported = 'Notification' in window && window.isSecureContext;
      const permission = supported ? Notification.permission : 'unsupported';
      $('#notification-permission-status').textContent = {
        granted: '허용됨 · 앱 알림과 시스템 알림을 함께 보내요.',
        denied: '차단됨 · 앱 안에서 알려드려요. 브라우저의 사이트 설정에서 허용할 수 있어요.',
        default: '알림을 허용하면 다른 창을 보고 있어도 확인할 수 있어요.',
        unsupported: '이 환경에서는 앱 안의 알림을 사용할 수 있어요.',
      }[permission];
      $('#request-notification-permission').disabled = permission !== 'default';
      $('#request-notification-permission').textContent = permission === 'granted' ? '허용됨' : permission === 'denied' ? '차단됨' : permission === 'unsupported' ? '앱 알림 사용' : '알림 허용';
    }

    function updateAction() {
      $('#notification-action').textContent = settings.enabled ? `♧ 알림 ${settings.time}` : '♧ 알림 설정';
    }

    function openSettings() {
      settings = loadSettings();
      $('#notification-enabled').checked = settings.enabled;
      $('#notification-time').value = settings.time;
      const items = getRemaining();
      $('#notification-preview').textContent = `미완료 ${items.length}개 · 오늘 마감 ${items.filter((task) => window.TodoDeadline.dueToday(task)).length}개를 먼저 알려드려요. 루틴도 함께 표시해요.`;
      permissionUI();
      $('#notification-dialog').showModal();
    }

    async function notify(test = false) {
      const items = getRemaining();
      const due = items.filter((task) => window.TodoDeadline.dueToday(task));
      const title = items.length ? `오늘 남은 할 일 ${items.length}개${due.length ? ` · 오늘 마감 ${due.length}개` : ''}${test ? ' · 테스트' : ''}` : '오늘의 할 일을 모두 마쳤어요 · 테스트';
      $('#reminder-title').textContent = title;
      $('#reminder-list').innerHTML = items.length ? items.map((task) => {
        const subtasks = task.subtasks.filter((sub) => !sub.done);
        const deadline = window.TodoDeadline.describe(task);
        return `<li${window.TodoDeadline.dueToday(task) ? ' class="due-today"' : ''}>${window.TodoDeadline.dueToday(task) ? '⏰ 오늘 마감 · ' : ''}${escapeHTML(task.title)}${deadline ? `<small>${escapeHTML(deadline)}</small>` : ''}${subtasks.length ? `<small>${subtasks.map((sub) => escapeHTML(sub.title)).join(' · ')}</small>` : ''}</li>`;
      }).join('') : '<li>남은 할 일이 없어요. 편안한 하루 보내세요.</li>';
      $('#reminder-banner').classList.remove('hidden');
      if (!('Notification' in window) || Notification.permission !== 'granted') return;
      const body = items.length ? items.slice(0, 5).map((task) => `${window.TodoDeadline.dueToday(task) ? '⏰ 오늘 마감' : '•'} ${task.title}${window.TodoDeadline.dueToday(task) ? ` (${window.TodoDeadline.describe(task)})` : ''}`).join('\n') + (items.length > 5 ? `\n외 ${items.length - 5}개 · 앱에서 전체 목록 확인` : '') : '오늘 남은 할 일이 없어요.';
      const options = { body, icon: 'todo-192.png', tag: test ? 'today-todo-test' : 'today-todo-daily', data: { url: './?show=today' } };
      try {
        const worker = await registration;
        if (worker) await worker.showNotification(title, options);
        else {
          const notification = new Notification(title, options);
          notification.onclick = () => { window.focus(); showToday(); notification.close(); };
        }
      } catch {
        $('#notification-permission-status').textContent = '시스템 알림을 표시하지 못했어요. 앱 안의 알림에서 목록을 확인해 주세요.';
      }
    }

    async function check() {
      onTick();
      settings = loadSettings();
      updateAction();
      const deliver = () => {
        const key = window.TodoSchedule.reminderKey(settings, new Date(), localStorage.getItem(FIRED_KEY));
        if (!key) return;
        // Persist before displaying so refreshes and additional tabs do not repeat an alert.
        localStorage.setItem(FIRED_KEY, key);
        if (getRemaining().length) return notify();
      };
      if (navigator.locks) await navigator.locks.request('today-todo-reminder', deliver);
      else await deliver();
    }

    $('#notification-action').addEventListener('click', openSettings);
    $('#notification-form').addEventListener('submit', (event) => {
      event.preventDefault();
      settings = { enabled: $('#notification-enabled').checked, time: $('#notification-time').value };
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
      $('#notification-dialog').close();
      updateAction();
      check();
    });
    $('#request-notification-permission').addEventListener('click', async () => {
      try { await Notification.requestPermission(); } catch {}
      permissionUI();
    });
    $('#test-notification').addEventListener('click', () => { $('#notification-dialog').close(); notify(true); });
    $('#dismiss-reminder').addEventListener('click', () => $('#reminder-banner').classList.add('hidden'));
    $('#reminder-show-today').addEventListener('click', () => { $('#reminder-banner').classList.add('hidden'); showToday(); });
    window.addEventListener('focus', () => { check(); if ($('#notification-dialog').open) permissionUI(); });
    window.addEventListener('storage', (event) => { if (event.key === SETTINGS_KEY) check(); });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
    navigator.serviceWorker?.addEventListener('message', (event) => { if (event.data?.type === 'show-today') showToday(); });
    setInterval(check, 15000);
    updateAction();
    check();
  }

  window.TodoReminders = { init };
})();

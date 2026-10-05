(() => {
  const $ = (selector) => document.querySelector(selector);
  const dialog = $('#chatgpt-dialog');
  let getRemaining = () => [];
  let session = null;
  let running = null;
  let statusLoading = false;
  let modelsLoading = false;
  let modelsRevision = 0;

  async function request(path, options = {}) {
    const response = await fetch(path, { cache: 'no-store', signal: AbortSignal.timeout(20000), ...options });
    const data = await response.json().catch(() => ({}));
    if (response.status === 404) throw new Error('GPT 도우미를 사용하려면 앱 서버로 접속해 주세요.');
    if (!response.ok) throw new Error(data.error || 'ChatGPT 연결을 확인하지 못했어요.');
    return data;
  }

  function controls() {
    const ready = Boolean(session?.canInvoke);
    $('#chatgpt-send').disabled = !ready || Boolean(running) || modelsLoading || !$('#chatgpt-model').value;
    $('#chatgpt-model').disabled = !ready || Boolean(running) || modelsLoading;
    $('#refresh-chatgpt-models').disabled = !ready || Boolean(running) || modelsLoading;
    $('#chatgpt-connect').disabled = !session?.configured || statusLoading || Boolean(running);
    $('#chatgpt-disconnect').disabled = Boolean(running) || statusLoading;
    $('#chatgpt-stop').classList.toggle('hidden', !running);
    $('#chatgpt-prompt').disabled = Boolean(running);
    $('#chatgpt-include-tasks').disabled = Boolean(running);
    document.querySelectorAll('[data-gpt-prompt]').forEach((button) => { button.disabled = Boolean(running); });
  }

  function context() {
    const tasks = getRemaining().map((task) => ({
      title: String(task.title || '').slice(0, 120), note: String(task.note || '').slice(0, 500), priority: task.priority || 'normal',
      subtasks: (task.subtasks || []).filter((item) => !item.done).map((item) => ({ title: String(item.title || '').slice(0, 120), note: String(item.note || '').slice(0, 500) })),
    }));
    $('#chatgpt-tasks-preview').textContent = tasks.length ? tasks.map((task) => `• ${task.title}${task.note ? ` — ${task.note}` : ''}${task.subtasks.map((item) => `\n  - ${item.title}${item.note ? ` — ${item.note}` : ''}`).join('')}`).join('\n') : '오늘 남은 할 일이 없어요.';
    $('#chatgpt-context-preview').classList.toggle('hidden', !$('#chatgpt-include-tasks').checked);
    return JSON.stringify(tasks);
  }

  async function loadModels() {
    if (!session?.canInvoke || running) return;
    const revision = ++modelsRevision;
    modelsLoading = true;
    controls();
    const previous = $('#chatgpt-model').value;
    $('#chatgpt-model').replaceChildren(new Option('모델을 불러오고 있어요…', ''));
    try {
      const data = await request('api/chatgpt/models');
      if (revision !== modelsRevision) return;
      $('#chatgpt-model').replaceChildren(...data.models.map((model) => new Option(model.name, model.id)));
      if (!data.models.length) $('#chatgpt-model').append(new Option('사용 가능한 모델이 없어요', ''));
      if (data.models.some((model) => model.id === previous)) $('#chatgpt-model').value = previous;
    } catch (error) {
      if (revision !== modelsRevision) return;
      $('#chatgpt-model').replaceChildren(new Option('모델을 다시 불러와 주세요', ''));
      $('#chatgpt-error').textContent = error.message;
    } finally { if (revision === modelsRevision) { modelsLoading = false; controls(); } }
  }

  async function refreshSession() {
    if (statusLoading || running) return;
    statusLoading = true;
    controls();
    try {
      const previous = session;
      session = await request('api/chatgpt/session');
      const changed = previous && (previous.csrfToken !== session.csrfToken || previous.connected !== session.connected);
      if (changed) {
        $('#chatgpt-answer').textContent = '';
        $('#chatgpt-answer-panel').classList.add('hidden');
        $('#chatgpt-copy').disabled = true;
        window.TodoUsage?.reset();
      }
      $('#chatgpt-account').textContent = session.connected ? (session.account.email || session.account.name) : 'ChatGPT 계정 연결';
      $('#chatgpt-disconnect').classList.toggle('hidden', !session.connected);
      $('#chatgpt-connect').classList.toggle('hidden', Boolean(session.canInvoke));
      $('#chatgpt-plan-label').textContent = session.canInvoke ? '내 ChatGPT 구독 사용' : '';
      $('#chatgpt-connection-status').textContent = !session.configured ? 'ChatGPT 연결은 준비 중이에요. 서비스 등록 후 사용할 수 있어요.' :
        session.canInvoke ? '계정이 연결됐어요. 질문하면 내 구독으로 답변을 받아요.' :
        session.connected ? (session.planEnabled ? '계정은 연결됐어요. 구독 사용 권한을 승인하려면 다시 연결해 주세요.' : '계정은 연결됐어요. 구독을 통한 모델 호출은 서비스 승인 후 사용할 수 있어요.') : '내 ChatGPT 계정을 연결해 질문할 수 있어요.';
      if (!session.canInvoke) {
        modelsRevision++;
        modelsLoading = false;
        $('#chatgpt-model').replaceChildren(new Option('계정을 연결하면 선택할 수 있어요', ''));
      } else if (!previous?.canInvoke || changed || !$('#chatgpt-model').value) await loadModels();
      let welcomed = false;
      try { welcomed = localStorage.getItem('today-todos-chatgpt-welcome-v1') === 'true'; } catch {}
      $('#chatgpt-welcome').classList.toggle('hidden', !session.canInvoke || welcomed);
    } catch (error) {
      session = null;
      modelsRevision++;
      modelsLoading = false;
      $('#chatgpt-connection-status').textContent = error.message;
      $('#chatgpt-connect').classList.remove('hidden');
      $('#chatgpt-disconnect').classList.add('hidden');
    } finally { statusLoading = false; controls(); }
  }

  async function connect() {
    $('#chatgpt-error').textContent = '';
    $('#chatgpt-connect').disabled = true;
    try {
      if (session.authOrigin && session.authOrigin !== location.origin) {
        location.assign(`${session.authOrigin}/?chatgpt=connect`); return;
      }
      const data = await request('auth/chatgpt/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      location.assign(data.authorizationUrl);
    } catch (error) { $('#chatgpt-error').textContent = error.message; controls(); }
  }

  async function ask(event) {
    event.preventDefault();
    if (running || !session?.canInvoke || !$('#chatgpt-model').value) return;
    $('#chatgpt-error').textContent = '';
    const payload = { prompt: $('#chatgpt-prompt').value.trim(), model: $('#chatgpt-model').value };
    if ($('#chatgpt-include-tasks').checked) {
      payload.context = context();
      if (payload.context.length > 20000) { $('#chatgpt-error').textContent = '함께 보낼 목록이 너무 길어요. 목록 보내기를 끄고 질문해 주세요.'; return; }
    }
    if (!payload.prompt) return;
    const current = new AbortController();
    running = current;
    controls();
    $('#chatgpt-answer-panel').classList.remove('hidden');
    $('#chatgpt-answer').textContent = '';
    $('#chatgpt-answer-status').textContent = '답변을 준비하고 있어요…';
    $('#chatgpt-copy').disabled = true;
    let completed = false;
    let reader;
    try {
      const response = await fetch('api/chatgpt/respond', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
        body: JSON.stringify(payload), signal: AbortSignal.any([current.signal, AbortSignal.timeout(185000)]),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || '질문을 보내지 못했어요.');
      }
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const consume = (line) => {
        if (!line.trim()) return;
        const item = JSON.parse(line);
        if (item.type === 'error') throw new Error(item.error);
        if (item.type === 'delta') { $('#chatgpt-answer').textContent += item.text; $('#chatgpt-answer-status').textContent = '답변 중…'; }
        if (item.type === 'completed') completed = true;
      };
      while (!completed) {
        const { done, value } = await reader.read();
        if (done) { buffer += decoder.decode(); if (buffer.trim()) consume(buffer); break; }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) consume(line);
      }
      if (!completed) throw new Error('연결이 중간에 끊겼어요. 일부 답변만 표시돼요.');
      $('#chatgpt-answer-status').textContent = '답변 완료';
      window.TodoUsage?.refresh(true);
    } catch (error) {
      $('#chatgpt-answer-status').textContent = current.signal.aborted ? '중지됨 · 일부 답변일 수 있어요' : '답변 미완료';
      if (!current.signal.aborted) $('#chatgpt-error').textContent = error.name === 'TimeoutError' ? '답변 시간이 초과됐어요. 다시 질문해 주세요.' : error.message;
    } finally {
      await reader?.cancel().catch(() => {});
      running = null;
      controls();
      $('#chatgpt-copy').disabled = !$('#chatgpt-answer').textContent;
    }
  }

  window.TodoChatGPT = {
    init(options) {
      getRemaining = options.getRemaining;
      $('#chatgpt-action').addEventListener('click', () => { dialog.showModal(); context(); refreshSession(); });
      $('#close-chatgpt').addEventListener('click', () => dialog.close());
      dialog.addEventListener('close', () => running?.abort());
      $('#chatgpt-connect').addEventListener('click', connect);
      $('#chatgpt-disconnect').addEventListener('click', async () => {
        $('#chatgpt-disconnect').disabled = true;
        $('#chatgpt-error').textContent = '';
        try {
          const result = await request('api/chatgpt/logout', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken }, body: '{}' });
          await refreshSession();
          if (!result.revoked) $('#chatgpt-error').textContent = '이 앱에서는 연결을 해제했어요. 원격 권한 해제는 확인되지 않았으니 ChatGPT 설정에서도 앱 연결을 해제해 주세요.';
        } catch (error) { $('#chatgpt-error').textContent = error.message; controls(); }
      });
      $('#chatgpt-welcome-done').addEventListener('click', () => { try { localStorage.setItem('today-todos-chatgpt-welcome-v1', 'true'); } catch {} $('#chatgpt-welcome').classList.add('hidden'); });
      $('#chatgpt-form').addEventListener('submit', ask);
      $('#chatgpt-stop').addEventListener('click', () => running?.abort());
      $('#chatgpt-include-tasks').addEventListener('change', context);
      $('#chatgpt-model').addEventListener('change', controls);
      $('#refresh-chatgpt-models').addEventListener('click', () => { $('#chatgpt-error').textContent = ''; loadModels(); });
      document.querySelectorAll('[data-gpt-prompt]').forEach((button) => button.addEventListener('click', () => { $('#chatgpt-prompt').value = button.dataset.gptPrompt; $('#chatgpt-prompt').focus(); }));
      $('#chatgpt-copy').addEventListener('click', async () => {
        try { await navigator.clipboard.writeText($('#chatgpt-answer').textContent); $('#chatgpt-answer-status').textContent = '복사했어요'; }
        catch { $('#chatgpt-error').textContent = '복사를 허용하지 않는 브라우저예요. 답변을 선택해서 복사해 주세요.'; }
      });
      window.addEventListener('focus', () => { if (dialog.open) refreshSession(); });
      const url = new URL(location.href);
      const callback = url.searchParams.get('chatgpt');
      if (callback) {
        url.searchParams.delete('chatgpt'); history.replaceState(null, '', url);
        dialog.showModal();
        const errors = { access_denied: 'ChatGPT 연결을 취소했어요.', invalid_state: '로그인 요청이 만료됐어요. 다시 연결해 주세요.', invalid_identity: '로그인 정보를 확인하지 못했어요. 다시 연결해 주세요.', reauthorize: '인증에 실패했어요. 다시 연결해 주세요.', connection_failed: 'ChatGPT 연결에 실패했어요. 다시 시도해 주세요.' };
        if (errors[callback]) $('#chatgpt-error').textContent = errors[callback];
      }
      refreshSession().then(() => { if (callback === 'connect' && session?.configured) connect(); });
    },
  };
})();

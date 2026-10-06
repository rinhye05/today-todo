(() => {
  const $ = (selector) => document.querySelector(selector);
  const preferenceKey = 'today-todos-show-gpt-usage-v1';
  const escapeHTML = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  let visible = true;
  try { visible = localStorage.getItem(preferenceKey) !== 'false'; } catch {}
  let loading = false;
  let lastData = null;
  let pollable = true;
  let controller = null;
  const windowName = (minutes) => minutes === 300 ? '5시간' : minutes === 10080 ? '주간' : minutes && minutes % 1440 === 0 ? `${minutes / 1440}일` : minutes && minutes % 60 === 0 ? `${minutes / 60}시간` : minutes ? `${minutes}분` : '사용 구간';

  function render(data) {
    $('#usage-limits').innerHTML = data.windows.length ? data.windows.map((window) => {
      const remaining = Math.max(0, Math.min(100, Number(window.remainingPercent) || 0));
      const color = remaining <= 15 ? 'low' : remaining <= 35 ? 'warning' : '';
      const reset = window.resetsAt ? new Date(window.resetsAt * 1000).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '확인 불가';
      return `<div class="usage-limit ${color}"><div class="usage-limit-head"><strong>${escapeHTML(window.name === 'codex' ? 'Codex' : window.name)} · ${windowName(window.windowMinutes)}</strong><b>${Number(remaining.toFixed(1))}% <small>남음</small></b></div><div class="usage-track" role="meter" aria-label="${escapeHTML(window.name)} ${windowName(window.windowMinutes)} 남은 사용량" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${remaining}"><span style="width:${remaining}%"></span></div><p>초기화 ${escapeHTML(reset)}</p></div>`;
    }).join('') : '<p class="usage-message">계정에서 표시할 사용량 정보가 없어요.</p>';
  }

  async function refresh(force = false) {
    if (loading || !visible) return;
    loading = true;
    const current = new AbortController();
    controller = current;
    $('#refresh-usage').disabled = true;
    try {
      const response = await fetch(`api/usage${force ? '?refresh=1' : ''}`, { cache: 'no-store', signal: AbortSignal.any([current.signal, AbortSignal.timeout(20000)]) });
      if (response.status === 404) { pollable = false; throw new Error('사용량을 확인하려면 앱 서버로 접속해 주세요.'); }
      if (!response.ok) throw new Error('사용량 서버에 연결하지 못했어요.');
      const data = await response.json();
      if (current.signal.aborted) return;
      pollable = data.pollable !== false;
      $('#usage-source').textContent = data.source === 'local-codex' ? '서버의 로컬 Codex 계정' : '내 ChatGPT 계정';
      if (!data.available && !pollable) {
        lastData = null;
        $('#usage-updated').textContent = data.code === 'usage_not_supported' ? '조회 지원 대기' : '계정 연결 필요';
        $('#usage-updated').classList.remove('stale');
        $('#usage-limits').innerHTML = `<p class="usage-message">${escapeHTML(data.error || '사용량 조회를 지원하지 않아요.')} <a href="https://chatgpt.com/settings/usage" class="chatgpt-usage-link" target="_blank" rel="noopener noreferrer">ChatGPT 설정 → 사용량</a></p>`;
        return;
      }
      if (!data.available) throw new Error(data.error || '사용량을 가져오지 못했어요.');
      lastData = data;
      render(data);
      $('#usage-updated').textContent = `${new Date(data.checkedAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })} 확인 · 30초 자동 갱신`;
      $('#usage-updated').classList.remove('stale');
    } catch (error) {
      if (current.signal.aborted) return;
      $('#usage-updated').textContent = lastData ? '갱신 실패 · 마지막 확인값' : '연결 확인 필요';
      $('#usage-updated').classList.add('stale');
      if (!lastData) $('#usage-limits').innerHTML = `<p class="usage-message">${escapeHTML(error.message)}</p>`;
    } finally {
      if (controller === current) { controller = null; loading = false; $('#refresh-usage').disabled = false; }
    }
  }

  function setVisible(next, persist = true) {
    visible = next;
    $('#usage-panel').classList.toggle('hidden', !visible);
    $('#show-gpt-usage').checked = visible;
    if (persist) { try { localStorage.setItem(preferenceKey, String(next)); } catch {} }
    if (!visible) { controller?.abort(); controller = null; loading = false; $('#refresh-usage').disabled = false; }
    else refresh(true);
  }

  $('#settings-action').addEventListener('click', () => $('#settings-dialog').showModal());
  $('#mobile-settings-action').addEventListener('click', () => $('#settings-dialog').showModal());
  for (const id of ['close-settings', 'done-settings']) $(`#${id}`).addEventListener('click', () => $('#settings-dialog').close());
  $('#show-gpt-usage').addEventListener('change', (event) => setVisible(event.target.checked));
  $('#hide-usage').addEventListener('click', () => { setVisible(false); (matchMedia('(max-width: 900px)').matches ? $('#mobile-settings-action') : $('#settings-action')).focus(); });
  $('#refresh-usage').addEventListener('click', () => refresh(true));
  document.addEventListener('visibilitychange', () => { if (!document.hidden && pollable) refresh(); });
  window.addEventListener('storage', (event) => { if (event.key === preferenceKey || event.key === null) setVisible(event.key === null || event.newValue !== 'false', false); });
  setInterval(() => { if (!document.hidden && pollable) refresh(); }, 30000);
  window.TodoUsage = {
    refresh,
    reset: () => {
      controller?.abort(); controller = null; loading = false; lastData = null; pollable = true;
      $('#usage-limits').textContent = '계정 사용량을 확인하고 있어요.';
      refresh(true);
    },
  };
  setVisible(visible, false);
})();

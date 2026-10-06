(() => {
  const toggle = document.querySelector('#time-24-hour');
  toggle.checked = localStorage.getItem('todo-time-24') !== 'false';
  function update() {
    document.querySelectorAll('input[type="time"], input[type="datetime-local"], input[data-time-input]').forEach((input) => {
      if (!input.dataset.timeInput) input.dataset.timeInput = input.type;
      const dateTime = input.dataset.timeInput === 'datetime-local';
      input.type = toggle.checked ? 'text' : input.dataset.timeInput;
      if (toggle.checked) {
        input.placeholder = dateTime ? 'YYYY-MM-DDTHH:MM' : 'HH:MM'; input.inputMode = dateTime ? 'text' : 'numeric';
        input.pattern = (dateTime ? '[0-9]{4}-[0-9]{2}-[0-9]{2}T' : '') + '([01][0-9]|2[0-3]):[0-5][0-9]';
        input.maxLength = dateTime ? 16 : 5;
      } else { input.removeAttribute('pattern'); input.removeAttribute('maxlength'); }
    });
  }
  toggle.addEventListener('change', () => { localStorage.setItem('todo-time-24', String(toggle.checked)); update(); });
  new MutationObserver(update).observe(document.body, { childList: true, subtree: true });
  update();
  const smallScreen = matchMedia('(max-width: 1199px)');
  const panel = document.querySelector('#usage-panel');
  const compactUsage = document.querySelector('#compact-usage');
  function placeUsage() {
    if (smallScreen.matches) document.querySelector('#compact-usage-content').append(panel);
    else document.querySelector('#settings-action').before(panel);
    compactUsage.hidden = !smallScreen.matches || panel.classList.contains('hidden');
  }
  smallScreen.addEventListener('change', placeUsage); placeUsage();
  new MutationObserver(placeUsage).observe(panel, { attributes: true, attributeFilter: ['class'] });

  // Keep a modal inside the visible screen when a virtual keyboard is open.
  let viewportFrame = null;
  function fitDialogs() {
    viewportFrame = null;
    const viewport = window.visualViewport;
    const height = viewport?.height || window.innerHeight;
    document.documentElement.style.setProperty('--dialog-available-height', `${height}px`);
    document.documentElement.style.setProperty('--dialog-center', `${(viewport?.offsetTop || 0) + height / 2}px`);
  }
  function scheduleDialogFit() {
    if (viewportFrame === null) viewportFrame = requestAnimationFrame(fitDialogs);
  }
  window.addEventListener('resize', scheduleDialogFit);
  window.visualViewport?.addEventListener('resize', scheduleDialogFit);
  window.visualViewport?.addEventListener('scroll', scheduleDialogFit);
  fitDialogs();
})();

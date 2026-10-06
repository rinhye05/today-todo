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
  const smallScreen = matchMedia('(max-width: 1060px)');
  const panel = document.querySelector('#usage-panel');
  function placeUsage() {
    if (smallScreen.matches) document.querySelector('.topbar').after(panel);
    else document.querySelector('#settings-action').before(panel);
  }
  smallScreen.addEventListener('change', placeUsage); placeUsage();
})();

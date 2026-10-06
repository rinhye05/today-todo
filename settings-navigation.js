(() => {
  const settings = document.querySelector('#settings-dialog');
  const entries = [...settings.querySelectorAll('[data-settings-dialog]')];
  const backButtons = new Map();
  let origin = null;

  for (const entry of entries) {
    const dialog = document.getElementById(entry.dataset.settingsDialog);
    const heading = dialog.querySelector('.dialog-head > div');
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'settings-back-button';
    back.hidden = true;
    back.innerHTML = '<span aria-hidden="true">‹</span> 설정으로 돌아가기';
    heading.prepend(back);
    backButtons.set(dialog, back);
    back.addEventListener('click', () => dialog.close());

    dialog.addEventListener('close', () => {
      // Account sign-in can close and reopen the same dialog in one action.
      if (dialog.open || origin?.dialog !== dialog) return;
      const previous = origin;
      origin = null;
      back.hidden = true;
      if (document.querySelector('dialog[open]')) return;
      settings.showModal();
      settings.scrollTop = previous.scrollTop;
      previous.entry.focus({ preventScroll: true });
    });
  }

  // Let each screen's existing click handler open it after leaving the menu.
  settings.addEventListener('click', (event) => {
    const entry = event.target.closest('[data-settings-dialog]');
    if (!entry || !settings.contains(entry)) return;
    const dialog = document.getElementById(entry.dataset.settingsDialog);
    origin = { dialog, entry, scrollTop: settings.scrollTop };
    backButtons.get(dialog).hidden = false;
    settings.close();
  }, true);
})();

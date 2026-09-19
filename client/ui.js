(() => {
  const $ = id => document.getElementById(id);

  // Keep the opening-screen redesign isolated from the functional app CSS.
  if (!document.querySelector('link[data-visio-minimal-home]')) {
    const stylesheet = document.createElement('link');
    stylesheet.rel = 'stylesheet';
    stylesheet.href = '/home-minimal.css';
    stylesheet.dataset.visioMinimalHome = 'true';
    document.head.appendChild(stylesheet);
  }

  const viewer = $('viewer');
  const statusNode = $('status');
  const toggle = $('toggle-assistant');
  const bubble = document.querySelector('.miro-bubble');
  const liveMiro = document.querySelector('.miro-live');
  const companionStage = document.querySelector('.companion-stage');
  const homeDock = $('home-dock');

  if (!viewer || !statusNode || !toggle) return;

  // Put the actual start button in the center of the Miro/orb composition.
  // index.js can still move assistant-controls between home-dock and live-dock.
  if (companionStage && homeDock && homeDock.parentElement !== companionStage) {
    companionStage.appendChild(homeDock);
  }

  function mapAssistantState(value = '') {
    const text = value.toLowerCase();
    if (text.includes('look') || text.includes('scan') || text.includes('search') || text.includes('find')) return 'looking';
    if (text.includes('speak')) return 'speaking';
    if (text.includes('listen') || text.includes('ready')) return 'listening';
    if (text.includes('pause') || text.includes('clear') || text.includes('off')) return 'paused';
    if (text.includes('connect') || text.includes('open') || text.includes('prepar')) return 'connecting';
    return 'idle';
  }

  function syncVisualState() {
    const state = mapAssistantState(statusNode.textContent);
    viewer.dataset.assistantState = state;
    if (liveMiro) liveMiro.dataset.state = state;
    document.body.dataset.visioState = state;

    if (!bubble) return;
    const copy = {
      idle: 'Ready when you are.',
      connecting: 'One second…',
      listening: 'I’m listening.',
      looking: 'Let me look.',
      speaking: 'Here’s what I found.',
      paused: 'I’ll be here.',
    };
    bubble.textContent = copy[state] || copy.idle;
  }

  new MutationObserver(syncVisualState).observe(statusNode, {
    subtree: true,
    childList: true,
    characterData: true,
  });

  new MutationObserver(() => {
    document.body.dataset.assistantOpen = String(toggle.getAttribute('aria-expanded') === 'true');
  }).observe(toggle, { attributes: true, attributeFilter: ['aria-expanded', 'data-active'] });

  // Keep the existing dynamic label for accessibility, but the redesigned
  // opening screen displays only the circular control.
  const toggleLabel = $('toggle-label');
  if (toggleLabel) {
    const syncToggleLabel = () => {
      toggle.setAttribute('aria-label', toggleLabel.textContent.trim() || 'Start Visio');
    };
    new MutationObserver(syncToggleLabel).observe(toggleLabel, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    syncToggleLabel();
  }

  document.querySelectorAll('.ideas span').forEach(chip => {
    chip.setAttribute('role', 'presentation');
  });

  // Quiet discoverability cue: if the opening screen is untouched for 3s,
  // surface a small bottom toast. Any interaction suppresses it.
  const hint = document.createElement('button');
  hint.type = 'button';
  hint.id = 'start-hint-toast';
  hint.className = 'start-hint-toast';
  hint.textContent = 'Press to start';
  hint.setAttribute('aria-label', 'Press to start Visio');
  document.body.appendChild(hint);

  let hintTimer = null;

  function hideHint() {
    hint.classList.remove('is-visible');
  }

  function cancelHint() {
    if (hintTimer) {
      clearTimeout(hintTimer);
      hintTimer = null;
    }
    hideHint();
  }

  function armHint() {
    cancelHint();
    if (document.body.dataset.immersive === 'true') return;

    hintTimer = setTimeout(() => {
      hintTimer = null;
      const assistantOpen = toggle.getAttribute('aria-expanded') === 'true';
      if (!assistantOpen && document.body.dataset.immersive !== 'true') {
        hint.classList.add('is-visible');
      }
    }, 3000);
  }

  function noteInteraction(event) {
    if (event?.target === hint) return;
    cancelHint();
  }

  ['pointerdown', 'touchstart', 'keydown', 'wheel'].forEach(type => {
    window.addEventListener(type, noteInteraction, { passive: true });
  });

  hint.addEventListener('click', () => {
    cancelHint();
    if (toggle.getAttribute('aria-expanded') !== 'true' && !toggle.disabled) {
      toggle.click();
    }
  });

  new MutationObserver(() => {
    if (document.body.dataset.immersive === 'true') cancelHint();
    else armHint();
  }).observe(document.body, { attributes: true, attributeFilter: ['data-immersive'] });

  syncVisualState();
  armHint();
})();

(() => {
  const $ = id => document.getElementById(id);

  const viewer = $('viewer');
  const statusNode = $('status');
  const toggle = $('toggle-assistant');
  const bubble = document.querySelector('.miro-bubble');
  const liveMiro = document.querySelector('.miro-live');

  if (!viewer || !statusNode || !toggle) return;

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

  document.querySelectorAll('.ideas span').forEach(chip => {
    chip.setAttribute('role', 'presentation');
  });

  syncVisualState();
})();

// Intentionally RAM-only: pause retains context; reload/forget clears it.
export function createMemory() {
  return { goal: null, discoveries: [], transcript: [], places: [] };
}

export function updateGoal(memory, values) {
  if (typeof values.summary !== 'string' || !values.summary.trim()) throw new Error('A goal summary is required.');
  const previous = memory.goal || { category: 'general', preferences: [], maxPrice: null, currency: null };
  const next = { ...previous, summary: values.summary.trim().slice(0, 1000) };
  if (typeof values.category === 'string') next.category = values.category.slice(0, 80);
  if (Array.isArray(values.preferences)) next.preferences = values.preferences.filter(x => typeof x === 'string').slice(0, 12).map(x => x.slice(0, 120));
  if (values.maxPrice === null || (Number.isFinite(values.maxPrice) && values.maxPrice >= 0)) next.maxPrice = values.maxPrice;
  if (values.currency === null || typeof values.currency === 'string') next.currency = values.currency?.slice(0, 12) ?? null;
  memory.goal = next;
  return next;
}

export function rememberScene(memory, discovery) {
  memory.discoveries.push(discovery);
  // Do not collapse similarly named menus: two restaurants can share dish names.
  memory.discoveries = memory.discoveries.slice(-12);
}

export function rememberMessage(memory, role, text) {
  const value = String(text || '').trim().slice(0, 2000);
  if (!value) return;
  const last = memory.transcript.at(-1);
  if (last?.role === role && last.text === value) return;
  memory.transcript.push({ role, text: value });
  memory.transcript = memory.transcript.slice(-24);
}

export function snapshot(memory) {
  return {
    goal: memory.goal,
    discoveries: memory.discoveries.slice(-4),
    conversation: memory.transcript.slice(-12),
    places: memory.places,
    note: 'Observations are historical. Inspect again before making claims about the current position or scene.',
  };
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemory, updateGoal, rememberScene, rememberMessage, snapshot } from '../client/memory.js';

test('a budget survives a preference change and can be explicitly cleared', () => {
  const memory = createMemory();
  updateGoal(memory, { summary: 'Chicken under $20', preferences: ['chicken'], maxPrice: 20, currency: 'USD' });
  updateGoal(memory, { summary: 'Very spicy chicken under $20', preferences: ['chicken', 'very spicy'] });
  assert.equal(memory.goal.maxPrice, 20); assert.equal(memory.goal.currency, 'USD');
  updateGoal(memory, { summary: 'Read this sign', category: 'translation', preferences: [], maxPrice: null, currency: null });
  assert.equal(memory.goal.maxPrice, null); assert.deepEqual(memory.goal.preferences, []);
});

test('recall preserves observations and prices without rescanning or mutating them', () => {
  const memory = createMemory();
  rememberScene(memory, { capturedAt: 'now', scene: { relevantItems: [{ name: 'Pollo', price: 14.99 }, { name: 'Enchiladas', price: 12.5 }] } });
  rememberMessage(memory, 'user', 'Which is cheaper?');
  const recalled = snapshot(memory);
  assert.equal(recalled.discoveries[0].scene.relevantItems[1].price, 12.5);
  assert.equal(memory.discoveries.length, 1);
  assert.notEqual(recalled.discoveries, memory.discoveries);
});

test('histories stay bounded and duplicate transcript echoes are suppressed', () => {
  const memory = createMemory();
  for (let i = 0; i < 40; i++) { rememberScene(memory, { capturedAt: String(i) }); rememberMessage(memory, 'user', String(i)); }
  rememberMessage(memory, 'user', '39');
  assert.equal(memory.discoveries.length, 12); assert.equal(memory.transcript.length, 24);
  assert.equal(snapshot(memory).discoveries.length, 4); assert.equal(snapshot(memory).conversation.length, 12);
  const fresh = createMemory(); assert.equal(fresh.goal, null); assert.equal(fresh.discoveries.length, 0);
});

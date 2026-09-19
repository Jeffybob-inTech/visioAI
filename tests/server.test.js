import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/server.js';
import { buildVisionPayload, parseImage, visionRequestSchema } from '../server/vision.js';
import { agentConfig, TOOL_CONFIGS } from '../scripts/create-agent.mjs';

const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lYQAAAAASUVORK5CYII=';
const goal = { summary: 'Very spicy chicken under $20', category: 'food', preferences: ['chicken', 'very spicy'], maxPrice: 20, currency: 'USD' };
const scene = {
  sceneType: 'menu', imageQuality: 'usable', needsMovement: false, movementInstruction: null,
  language: 'Spanish', observations: ['Two chicken dishes, with visible prices and spice labels.'],
  relevantItems: [
    { name: 'Pollo a la Diabla', translatedName: 'Devil-style chicken', price: 14.99, currency: 'USD', reason: 'Menu explicitly says muy picante.', location: 'Upper half', details: 'Arroz y frijoles.' },
    { name: 'Enchiladas de Pollo', translatedName: 'Chicken enchiladas', price: 12.5, currency: 'USD', reason: 'Menu explicitly says picante suave.', location: 'Lower half', details: null },
  ], answerConfidence: 0.9, uncertainty: null,
};
const env = { GEMINI_API_KEY: 'test-secret-gemini', ELEVENLABS_API_KEY: 'test-secret-eleven', ELEVENLABS_AGENT_ID: 'test-agent', ELEVENLABS_AUTO_SYNC: 'false', GOOGLE_PLACES_API_KEY: 'test-secret-places', CLIENT_ORIGINS: 'https://visio.example' };
async function server(t, fetchImpl, overrides = {}) {
  const instance = createApp({ env: { ...env, ...overrides }, fetchImpl }).listen(0, '127.0.0.1');
  await new Promise(resolve => instance.once('listening', resolve));
  t.after(() => new Promise(resolve => instance.close(resolve)));
  const url = `http://127.0.0.1:${instance.address().port}`;
  return async (route, body, headers = {}) => fetch(url + route, {
    method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test('vision sends image, goal, prior evidence, and schema without putting secrets in payload', async t => {
  let outgoing;
  const call = await server(t, async (url, init) => {
    outgoing = { url, init, body: JSON.parse(init.body) };
    return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(scene) }] } }] });
  });
  const response = await call('/api/vision', { image, goal, question: 'Which is spicier?', previousContext: [{ capturedAt: '2026-09-19', scene }] });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).scene, scene);
  assert.equal(outgoing.init.headers['x-goog-api-key'], env.GEMINI_API_KEY);
  const context = JSON.parse(outgoing.body.contents[0].parts[0].text);
  assert.equal(context.goal.maxPrice, 20); assert.equal(context.previousContext.length, 1);
  assert.equal(outgoing.body.contents[0].parts[1].inlineData.mimeType, 'image/png');
  assert.equal(outgoing.body.generationConfig.responseJsonSchema.type, 'object');
  assert.ok(!outgoing.init.body.includes(env.GEMINI_API_KEY));
});

test('unusable frames cannot return confident recommendations', async t => {
  const call = await server(t, async () => Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ ...scene, imageQuality: 'insufficient' }) }] } }] }));
  const response = await call('/api/vision', { image, goal });
  const { scene: result } = await response.json();
  assert.equal(result.needsMovement, true); assert.equal(result.relevantItems.length, 0);
  assert.ok(result.answerConfidence <= 0.4); assert.ok(result.movementInstruction);
});

test('invalid, oversized, non-image, and excessive-history inputs never call the provider', async t => {
  let calls = 0;
  const call = await server(t, async () => { calls++; throw new Error('must not call'); });
  for (const body of [
    { image: 'https://private.invalid/photo' }, { image: 'data:image/png;base64,AAAAAAAAAAAAAAAAAAAA' },
    { image, goal: { ...goal, maxPrice: -5 } }, { image, previousContext: Array(5).fill({ capturedAt: 'now', scene }) },
    { image: `data:image/png;base64,${'A'.repeat(3_200_000)}` },
  ]) {
    const response = await call('/api/vision', body);
    assert.ok([400, 413].includes(response.status));
  }
  assert.equal(calls, 0);
});

test('invalid or truncated model output is rejected instead of presented as evidence', async t => {
  for (const data of [
    { candidates: [{ content: { parts: [{ text: 'not json' }] } }] },
    { candidates: [{ content: { parts: [{ text: '{"sceneType":"menu"}' }] } }] },
    { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: JSON.stringify(scene) }] } }] },
    { promptFeedback: { blockReason: 'SAFETY' } },
  ]) {
    const call = await server(t, async () => Response.json(data));
    assert.equal((await call('/api/vision', { image })).status, 502);
  }
});

test('provider failures are sanitized and never reflect credentials', async t => {
  for (const status of [401, 403, 429, 500]) {
    const call = await server(t, async () => Response.json({ key: env.GEMINI_API_KEY }, { status }));
    const response = await call('/api/vision', { image });
    assert.equal(response.status, status === 429 ? 429 : 502);
    assert.ok(!(await response.text()).includes(env.GEMINI_API_KEY));
  }
});

test('CORS is exact and errors stay readable to the approved frontend', async t => {
  const call = await server(t, async () => { throw new Error('must not call'); });
  const blocked = await call('/api/config', undefined, { Origin: 'https://visio.example.attacker.invalid' });
  assert.equal(blocked.status, 403); assert.equal(blocked.headers.get('Access-Control-Allow-Origin'), null);
  const allowed = await call('/api/vision', { image: 'invalid' }, { Origin: 'https://visio.example' });
  assert.equal(allowed.status, 400); assert.equal(allowed.headers.get('Access-Control-Allow-Origin'), 'https://visio.example');
});

test('voice endpoint returns only ephemeral conversation token and disables caching', async t => {
  const call = await server(t, async (url, init) => {
    assert.equal(url.searchParams.get('agent_id'), 'test-agent');
    assert.equal(init.headers['xi-api-key'], env.ELEVENLABS_API_KEY);
    return Response.json({ token: 'ephemeral', extra: 'discard' });
  });
  const response = await call('/api/elevenlabs-token');
  assert.deepEqual(await response.json(), { conversationToken: 'ephemeral' });
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('missing configuration reports capabilities and a useful error', async t => {
  const call = await server(t, async () => { throw new Error('must not call'); }, { GEMINI_API_KEY: '', ELEVENLABS_API_KEY: '', GOOGLE_PLACES_API_KEY: '' });
  assert.deepEqual(await (await call('/api/config')).json(), { capabilities: { vision: false, search: false, voice: false, places: false } });
  assert.equal((await call('/api/elevenlabs-token')).status, 503);
  assert.equal((await call('/api/vision', { image })).status, 503);
  assert.equal((await call('/api/health')).status, 200);
});

test('Places preserves attribution and does not pretend to know menu prices', async t => {
  let sent;
  const call = await server(t, async (url, init) => {
    sent = JSON.parse(init.body);
    return Response.json({ places: [{ displayName: { text: 'Restaurant' }, formattedAddress: '1 Main St', googleMapsUri: 'https://maps.google.com/', attributions: [{ provider: 'Example' }] }] });
  });
  const response = await call('/api/places', { query: 'chicken restaurants', latitude: 37.2, longitude: -80.4 });
  const result = await response.json();
  assert.equal(sent.locationBias.circle.center.latitude, 37.2);
  assert.equal(result.source, 'Google Maps'); assert.equal(result.places[0].attributions.length, 1);
  assert.match(result.caveat, /do not verify/);
  assert.equal((await call('/api/places', { query: 'food', latitude: 100, longitude: 0 })).status, 400);
});

test('agent setup registers every client tool as a blocking tool and waits for spoken camera guidance', () => {
  assert.deepEqual(TOOL_CONFIGS.map(tool => tool.name), ['set_goal', 'inspect_scene', 'recall_memory', 'find_places', 'search_web', 'pause_assistant']);
  assert.ok(TOOL_CONFIGS.every(tool => tool.expects_response));
  assert.equal(TOOL_CONFIGS.find(tool => tool.name === 'inspect_scene').execution_mode, 'post_tool_speech');
  const config = agentConfig(['test-tool']);
  assert.equal(config.platform_settings.auth.enable_auth, true);
  assert.ok(config.conversation_config.conversation.client_events.includes('client_tool_call'));
});

test('vision uses schema constrained output, untrusted-document instructions, and bounded input', () => {
  const input = visionRequestSchema.parse({ image, goal });
  const payload = buildVisionPayload(input, parseImage(image));
  assert.equal(payload.generationConfig.responseMimeType, 'application/json');
  assert.match(payload.systemInstruction.parts[0].text, /untrusted data/);
  assert.equal(payload.contents.length, 1);
});

test('web search enables grounding and returns only actual provider source links', async t => {
  let outgoing;
  const call = await server(t, async (url, init) => {
    outgoing = JSON.parse(init.body);
    return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'The museum opens at 10 a.m.' }] }, groundingMetadata: {
      groundingChunks: [{ web: { uri: 'https://museum.example/hours', title: 'Museum hours' } }, { web: { uri: 'javascript:alert(1)', title: 'Bad link' } }],
      searchEntryPoint: { renderedContent: '<div>Google Search</div>' },
    } }] });
  });
  const response = await call('/api/search', { query: 'Museum opening hours today' });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(outgoing.tools, [{ googleSearch: {} }]);
  assert.equal(outgoing.contents[0].parts[0].text, 'Museum opening hours today');
  assert.deepEqual(result.sources, [{ url: 'https://museum.example/hours', title: 'Museum hours' }]);
  assert.equal(result.searchSuggestions, '<div>Google Search</div>');
  assert.ok(!JSON.stringify(result).includes(env.GEMINI_API_KEY));
});

test('web search rejects ungrounded or incomplete answers', async t => {
  for (const candidate of [
    { content: { parts: [{ text: 'A confident answer with no search sources.' }] } },
    { finishReason: 'MAX_TOKENS', content: { parts: [{ text: 'Partial answer' }] }, groundingMetadata: { groundingChunks: [{ web: { uri: 'https://example.com' } }] } },
  ]) {
    const call = await server(t, async () => Response.json({ candidates: [candidate] }));
    const response = await call('/api/search', { query: 'Look up the menu' });
    assert.equal(response.status, 502); assert.equal((await response.json()).error.code, 'UNGROUNDED_SEARCH');
  }
});

test('invalid searches and missing search credentials never call the provider', async t => {
  let calls = 0;
  const call = await server(t, async () => { calls++; throw new Error('must not call'); }, { GEMINI_API_KEY: '' });
  assert.equal((await call('/api/search', { query: '' })).status, 400);
  assert.equal((await call('/api/search', { query: 'x'.repeat(501) })).status, 400);
  assert.equal((await call('/api/search', { query: 'opening hours' })).status, 503);
  assert.equal(calls, 0);
});

test('provider permission and model failures explain the configuration to check', async t => {
  for (const [status, hint] of [[403, /GEMINI_API_KEY.*restrictions/], [404, /GEMINI_MODEL/], [429, /quota or rate limit/]]) {
    const call = await server(t, async () => Response.json({}, { status }));
    const response = await call('/api/vision', { image });
    assert.match((await response.json()).error.message, hint);
  }
});

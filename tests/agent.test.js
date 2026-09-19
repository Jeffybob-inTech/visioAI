import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentPreparer } from '../server/agent.js';
import { AGENT_PROMPT, TOOL_CONFIGS, agentConfig } from '../server/agent-config.js';
import { createApp } from '../server/server.js';

const env = { ELEVENLABS_API_KEY: 'private-test-key', ELEVENLABS_AGENT_ID: 'existing-agent' };

function provider({ ready = false, rejectPatchOnce = false } = {}) {
  const tools = new Map([['unrelated', { type: 'webhook', name: 'existing_custom_tool' }]]);
  if (ready) TOOL_CONFIGS.forEach(tool => tools.set(tool.name, { ...tool, optional_provider_default: null }));
  else tools.set('old-scan', { type: 'client', name: 'inspect_scene', expects_response: false });
  const config = ready ? agentConfig([...tools.keys()]).conversation_config : {
    agent: { prompt: { prompt: 'Chat only', llm: 'existing-model', tool_ids: [...tools.keys()] }, dynamic_variables: { dynamic_variable_placeholders: { custom: 'keep' } } },
    tts: { voice_id: 'keep-my-voice' }, conversation: { client_events: ['audio'] },
  };
  const calls = [];
  let patch;
  return {
    calls, tools, get patch() { return patch; },
    fetchImpl: async (url, init) => {
      const endpoint = new URL(url).pathname.replace('/v1/convai/', '');
      calls.push(`${init.method || 'GET'} ${endpoint}`);
      if (endpoint === 'agents/existing-agent' && init.method === 'GET') return Response.json({ conversation_config: config });
      if (endpoint.startsWith('tools/') && init.method === 'GET') return Response.json({ id: endpoint.slice(6), tool_config: tools.get(endpoint.slice(6)) });
      if (endpoint === 'tools' && init.method === 'POST') {
        const tool = JSON.parse(init.body).tool_config; const id = `new-${tool.name}`;
        tools.set(id, tool); return Response.json({ id });
      }
      if (endpoint === 'agents/existing-agent' && init.method === 'PATCH') {
        if (rejectPatchOnce) { rejectPatchOnce = false; return Response.json({}, { status: 500 }); }
        patch = JSON.parse(init.body); return Response.json({ agent_id: 'existing-agent' });
      }
      if (endpoint === 'conversation/token') {
        assert.ok(ready || patch, 'agent must be configured before a voice token is issued');
        return Response.json({ token: 'ephemeral' });
      }
      throw new Error(`Unexpected provider request: ${endpoint}`);
    },
  };
}

test('repairs an existing chat-only agent, replaces broken scan tool, preserves unrelated settings, and shares concurrent work', async () => {
  const mock = provider();
  const prepare = createAgentPreparer({ env, fetchImpl: mock.fetchImpl });
  const [a, b] = await Promise.all([prepare(), prepare()]);
  assert.deepEqual(a, b); assert.equal(a.updated, true);
  const patch = mock.patch.conversation_config;
  assert.equal(patch.agent.prompt.prompt, AGENT_PROMPT);
  assert.ok(patch.agent.prompt.tool_ids.includes('unrelated'));
  assert.ok(!patch.agent.prompt.tool_ids.includes('old-scan'));
  assert.equal(patch.agent.prompt.tool_ids.length, TOOL_CONFIGS.length + 1);
  assert.equal(patch.agent.prompt.llm, undefined); assert.equal(patch.tts, undefined);
  assert.equal(patch.agent.dynamic_variables.dynamic_variable_placeholders.custom, 'keep');
  assert.ok(patch.conversation.client_events.includes('client_tool_call'));
  assert.equal(mock.calls.filter(call => call === 'POST tools').length, TOOL_CONFIGS.length);
  await prepare();
  assert.equal(mock.calls.filter(call => call === 'PATCH agents/existing-agent').length, 1);
});

test('an already configured agent is read without mutations or duplicate tools', async () => {
  const mock = provider({ ready: true });
  const result = await createAgentPreparer({ env, fetchImpl: mock.fetchImpl })();
  assert.equal(result.updated, false);
  assert.ok(mock.calls.every(call => call.startsWith('GET ')));
});

test('setup retries a failed patch without recreating successfully created tools', async () => {
  const mock = provider({ rejectPatchOnce: true });
  const prepare = createAgentPreparer({ env, fetchImpl: mock.fetchImpl });
  await assert.rejects(prepare, /HTTP 500/);
  await prepare();
  assert.equal(mock.calls.filter(call => call === 'POST tools').length, TOOL_CONFIGS.length);
});

test('agent permission failures identify the required access without leaking provider content', async () => {
  const prepare = createAgentPreparer({ env, fetchImpl: async () => Response.json({ detail: env.ELEVENLABS_API_KEY }, { status: 403 }) });
  await assert.rejects(prepare, error => {
    assert.match(error.message, /read\/write Agents and tools/);
    assert.ok(!error.message.includes(env.ELEVENLABS_API_KEY)); return true;
  });
});

test('default token route prepares tools before issuing tokens and only synchronizes once', async t => {
  const mock = provider();
  const app = createApp({ env, fetchImpl: mock.fetchImpl }).listen(0, '127.0.0.1');
  await new Promise(resolve => app.once('listening', resolve));
  t.after(() => new Promise(resolve => app.close(resolve)));
  for (let i = 0; i < 2; i++) {
    const response = await fetch(`http://127.0.0.1:${app.address().port}/api/elevenlabs-token`);
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { conversationToken: 'ephemeral' });
  }
  assert.equal(mock.calls.filter(call => call === 'PATCH agents/existing-agent').length, 1);
});

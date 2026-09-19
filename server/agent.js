import { AGENT_PROMPT, TOOL_CONFIGS, agentConfig } from './agent-config.js';
import { ApiError, providerJSON } from './provider.js';

// ElevenLabs adds optional defaults to tool schemas; compare only our contract.
function contains(actual, expected) {
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((value, i) => contains(actual[i], value));
  if (expected && typeof expected === 'object') return actual && Object.entries(expected).every(([key, value]) => contains(actual[key], value));
  return actual === expected;
}

// One setup per server process, shared by simultaneous session requests.
// A failed setup is retryable; successfully created tools are reused on retry.
export function createAgentPreparer({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  let pending;
  const staged = new Map();
  return function prepareAgent() {
    if (pending) return pending;
    pending = sync().catch(error => { pending = null; throw error; });
    return pending;
  };

  async function sync() {
    if (!env.ELEVENLABS_API_KEY || !env.ELEVENLABS_AGENT_ID) throw new ApiError(503, 'VOICE_NOT_CONFIGURED', 'Add ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID on Render.');
    const signal = AbortSignal.timeout(55_000);
    const api = (endpoint, method = 'GET', body) => providerJSON(fetchImpl,
      `https://api.elevenlabs.io/v1/convai/${endpoint}`, {
        method, headers: { 'xi-api-key': env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}), signal,
      }, 'ElevenLabs agent setup');
    const endpoint = `agents/${encodeURIComponent(env.ELEVENLABS_AGENT_ID)}`;
    const agent = await api(endpoint);
    if (!agent.conversation_config?.agent) throw new ApiError(502, 'INVALID_AGENT', 'ElevenLabs did not return the configured agent. Check ELEVENLABS_AGENT_ID.');
    const config = agent.conversation_config;
    const prompt = config.agent.prompt || {};
    const existingIds = [...new Set(prompt.tool_ids || [])];
    const tools = await Promise.all(existingIds.map(async id => ({ id, ...(await api(`tools/${encodeURIComponent(id)}`)) })));
    const ownedNames = new Set(TOOL_CONFIGS.map(tool => tool.name));
    const ids = tools.filter(tool => !ownedNames.has(tool.tool_config?.name)).map(tool => tool.id);
    for (const desired of TOOL_CONFIGS) {
      const match = tools.find(tool => contains(tool.tool_config, desired));
      let id = match?.id || staged.get(desired.name);
      if (!id) {
        const created = await api('tools', 'POST', { tool_config: desired });
        if (!created.id) throw new ApiError(502, 'INVALID_TOOL', 'ElevenLabs did not return a tool ID. Check the agent setup in ElevenLabs.');
        id = created.id; staged.set(desired.name, id);
      }
      ids.push(id);
    }
    const requiredEvents = agentConfig([]).conversation_config.conversation.client_events;
    const events = [...new Set([...(config.conversation?.client_events || []), ...requiredEvents])];
    const dynamic = config.agent.dynamic_variables || {};
    const placeholders = { ...dynamic.dynamic_variable_placeholders, session_context: dynamic.dynamic_variable_placeholders?.session_context ?? '{}' };
    const legacyTools = prompt.tools || [];
    const hasLegacyOwned = legacyTools.some(tool => ownedNames.has(tool.name));
    const changed = prompt.prompt !== AGENT_PROMPT || !contains(existingIds, ids)
      || !contains(config.conversation?.client_events, events)
      || dynamic.dynamic_variable_placeholders?.session_context == null || hasLegacyOwned;
    if (changed) {
      // PATCH only our integration fields. Preserve voice, LLM, auth, privacy,
      // unrelated tools, and the user's other agent settings.
      await api(endpoint, 'PATCH', { conversation_config: {
        agent: {
          prompt: { prompt: AGENT_PROMPT, tool_ids: ids,
            ...(hasLegacyOwned ? { tools: legacyTools.filter(tool => !ownedNames.has(tool.name)) } : {}) },
          dynamic_variables: { ...dynamic, dynamic_variable_placeholders: placeholders },
        },
        conversation: { client_events: events },
      } });
    }
    return { updated: changed, tools: TOOL_CONFIGS.map(tool => tool.name) };
  }
}

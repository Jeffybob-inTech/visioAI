import dotenv from 'dotenv';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
dotenv.config({ path: path.join(root, '.env'), quiet: true });

export { AGENT_PROMPT, TOOL_CONFIGS, agentConfig } from '../server/agent-config.js';
import { TOOL_CONFIGS, agentConfig } from '../server/agent-config.js';
import { createAgentPreparer } from '../server/agent.js';

async function main() {
  if (process.argv.includes('--dry-run')) {
    console.log(JSON.stringify({ tools: TOOL_CONFIGS, agent: agentConfig(TOOL_CONFIGS.map(tool => `<${tool.name}_tool_id>`)) }, null, 2));
    return;
  }
  if (!process.env.ELEVENLABS_API_KEY) throw new Error('Add ELEVENLABS_API_KEY to the root .env first.');
  if (process.env.ELEVENLABS_AGENT_ID) {
    const result = await createAgentPreparer()();
    console.log(`VisioAI agent ${result.updated ? 'updated' : 'already configured'} with ${result.tools.join(', ')}. Reconnect the browser to use it.`);
    return;
  }
  const checkpointPath = path.join(root, '.agent-setup.json');
  let checkpoint = { tools: {} };
  try { checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  async function persist() { await writeFile(checkpointPath, JSON.stringify(checkpoint, null, 2), { mode: 0o600 }); }
  async function post(endpoint, body) {
    const response = await fetch(`https://api.elevenlabs.io/v1/convai/${endpoint}`, {
      method: 'POST', headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      const detail = typeof result.detail === 'string' ? result.detail : result.detail?.message || 'Check the key’s Agents permissions and model availability.';
      throw new Error(`ElevenLabs ${endpoint}: HTTP ${response.status}. ${detail}`);
    }
    return response.json();
  }
  if (!checkpoint.agentId) {
    const ids = [];
    for (const config of TOOL_CONFIGS) {
      const hash = createHash('sha256').update(JSON.stringify(config)).digest('hex');
      const existing = checkpoint.tools[config.name];
      if (existing && existing.hash !== hash) throw new Error(`Saved tool ${config.name} differs from the current definition. Review .agent-setup.json before creating another agent.`);
      if (!existing) {
        const result = await post('tools', { tool_config: config });
        if (!result.id) throw new Error('Tool creation returned no ID. Check ElevenLabs before retrying.');
        checkpoint.tools[config.name] = { id: result.id, hash }; await persist();
        console.log(`Created ${config.name}.`);
      }
      ids.push(checkpoint.tools[config.name].id);
    }
    const result = await post('agents/create', agentConfig(ids, process.env.ELEVENLABS_VOICE_ID));
    if (!result.agent_id) throw new Error('Agent creation returned no ID. Check ElevenLabs before retrying.');
    checkpoint.agentId = result.agent_id; await persist();
  }
  const envPath = path.join(root, '.env');
  let contents = await readFile(envPath, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
  const setting = `ELEVENLABS_AGENT_ID=${checkpoint.agentId}`;
  contents = /^ELEVENLABS_AGENT_ID=.*$/m.test(contents) ? contents.replace(/^ELEVENLABS_AGENT_ID=.*$/m, setting) : `${contents}\n${setting}\n`;
  await writeFile(envPath, contents, { mode: 0o600 });
  console.log(`Created VisioAI agent ${checkpoint.agentId}. Saved ELEVENLABS_AGENT_ID to .env. Copy this ID to Render too.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

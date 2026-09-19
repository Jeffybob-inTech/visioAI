export class ApiError extends Error {
  constructor(status, code, message) { super(message); Object.assign(this, { status, code }); }
}

// Keep provider bodies and keys private, while identifying the failing setup step.
export async function providerJSON(fetchImpl, url, options, service) {
  try {
    const response = await fetchImpl(url, options);
    if (!response.ok) {
      await response.body?.cancel();
      const voice = service.startsWith('ElevenLabs');
      const key = voice ? 'ELEVENLABS_API_KEY' : service === 'Nearby search' ? 'GOOGLE_PLACES_API_KEY' : 'GEMINI_API_KEY';
      let hint = 'Check the provider configuration and try again.';
      if (response.status === 401) hint = `Check ${key} on Render; the provider rejected its credentials.`;
      if (response.status === 403) hint = voice
        ? 'Allow this ElevenLabs key to read/write Agents and tools and initiate conversations.'
        : `Check ${key}, its API restrictions, API enablement, and billing in Google Cloud.`;
      if (response.status === 404) hint = voice
        ? 'Check ELEVENLABS_AGENT_ID and that the key belongs to the same ElevenLabs workspace.'
        : 'Check GEMINI_MODEL (or GEMINI_SEARCH_MODEL for search); that model may not be available to this key.';
      if (response.status === 400) hint = voice
        ? 'ElevenLabs rejected the agent/tool settings. Check the agent model supports client tools.'
        : `Check ${key} and the selected model; web search requires Google Search grounding support.`;
      if (response.status === 429) throw new ApiError(429, 'PROVIDER_BUSY', `${service} quota or rate limit reached. Check usage/billing or try again shortly.`);
      throw new ApiError(502, 'PROVIDER_ERROR', `${service} failed (HTTP ${response.status}). ${hint}`);
    }
    return await response.json();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (options.signal?.aborted) throw new ApiError(504, 'PROVIDER_TIMEOUT', `${service} took too long. Please try again.`);
    throw new ApiError(502, 'PROVIDER_UNAVAILABLE', `${service} is unavailable. Please try again.`);
  }
}

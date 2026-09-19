import express from 'express';
import cors from 'cors';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildVisionPayload, parseImage, visionRequestSchema, visionResultSchema } from './vision.js';
import { ApiError, providerJSON } from './provider.js';
import { createAgentPreparer } from './agent.js';
import { buildSearchPayload, readSearchResult } from './search.js';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });

function requestSignal(req, res, timeoutMs = 25_000) {
  const controller = new AbortController();
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });
  req.on('aborted', () => controller.abort());
  return AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]);
}

export function createApp({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const app = express();
  const prepareAgent = createAgentPreparer({ env, fetchImpl });
  app.disable('x-powered-by');
  const proxy = Number(env.TRUST_PROXY || 0);
  app.set('trust proxy', Number.isInteger(proxy) && proxy >= 0 ? proxy : 0);
  const origins = new Set((env.CLIENT_ORIGINS || 'https://visioai-delta.vercel.app,http://localhost:5173,http://127.0.0.1:5173')
    .split(',').map(value => value.trim().replace(/\/$/, '')).filter(Boolean));
  app.use(cors({
    origin(origin, callback) {
      if (!origin || origins.has(origin)) return callback(null, true);
      callback(new ApiError(403, 'ORIGIN_NOT_ALLOWED', 'This website is not allowed to use the server.'));
    },
    methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type'], maxAge: 600,
  }));
  app.use((req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    next();
  });
  app.get('/api/health', (req, res) => res.json({ ok: true, service: 'visioai' }));
  app.get('/', (req, res) => res.json({ service: 'VisioAI API', health: '/api/health', client: 'Deploy client/dist to Vercel.' }));
  const capabilities = () => ({
    vision: Boolean(env.GEMINI_API_KEY),
    search: Boolean(env.GEMINI_API_KEY),
    voice: Boolean(env.ELEVENLABS_API_KEY && env.ELEVENLABS_AGENT_ID),
    places: Boolean(env.GOOGLE_PLACES_API_KEY),
  });
  app.get('/api/config', (req, res) => res.json({ capabilities: capabilities() }));
  const limit = (max, windowMs = 60_000) => rateLimit({
    windowMs, limit: max, standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: { code: 'RATE_LIMIT', message: 'Too many requests. Please wait a minute and try again.' } },
  });
  app.use('/api', limit(100));
  app.use(express.json({ limit: '3mb' }));

  app.get('/api/elevenlabs-token', limit(10), async (req, res) => {
    if (!capabilities().voice) throw new ApiError(503, 'VOICE_NOT_CONFIGURED', 'Voice is not configured yet. Add the ElevenLabs key and agent ID on the server.');
    if (env.ELEVENLABS_AUTO_SYNC !== 'false') await prepareAgent();
    if (req.aborted || res.destroyed) return;
    const url = new URL('https://api.elevenlabs.io/v1/convai/conversation/token');
    url.searchParams.set('agent_id', env.ELEVENLABS_AGENT_ID);
    const data = await providerJSON(fetchImpl, url, {
      headers: { 'xi-api-key': env.ELEVENLABS_API_KEY }, signal: requestSignal(req, res, 15_000),
    }, 'ElevenLabs voice');
    if (typeof data.token !== 'string' || !data.token) throw new ApiError(502, 'INVALID_TOKEN', 'Voice did not return a session token.');
    res.json({ conversationToken: data.token });
  });

  app.post('/api/vision', limit(24), async (req, res) => {
    const parsed = visionRequestSchema.safeParse(req.body);
    if (!parsed.success) throw new ApiError(400, 'INVALID_REQUEST', 'The image, goal, or visual context is invalid.');
    let image;
    try { image = parseImage(parsed.data.image); }
    catch (error) { throw new ApiError(400, 'INVALID_IMAGE', error.message); }
    if (!capabilities().vision) throw new ApiError(503, 'VISION_NOT_CONFIGURED', 'Vision is not configured yet. Add the Gemini key on the server.');
    const model = env.GEMINI_MODEL || 'gemini-3.8-flash';
    if (!/^[a-zA-Z0-9._-]+$/.test(model)) throw new ApiError(503, 'INVALID_MODEL', 'The server model setting is invalid.');
    const data = await providerJSON(fetchImpl,
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
        body: JSON.stringify(buildVisionPayload(parsed.data, image)), signal: requestSignal(req, res),
      }, 'Vision');
    const candidate = data.candidates?.[0];
    if (candidate?.finishReason && candidate.finishReason !== 'STOP') throw new ApiError(502, 'INCOMPLETE_VISION', 'I could not read that frame reliably. Please try another angle.');
    let scene;
    try {
      const text = candidate?.content?.parts?.filter(part => typeof part.text === 'string' && !part.thought).map(part => part.text).join('');
      scene = visionResultSchema.parse(JSON.parse(text));
    } catch {
      throw new ApiError(502, 'INVALID_VISION_RESULT', 'I could not read that frame reliably. Please try again.');
    }
    // Never return high-confidence guidance from an explicitly unusable frame.
    if (scene.imageQuality === 'insufficient') {
      scene.needsMovement = true;
      scene.movementInstruction ||= 'Hold the camera steady and try a closer view.';
      scene.relevantItems = [];
      scene.answerConfidence = Math.min(scene.answerConfidence, 0.4);
    }
    if (!scene.needsMovement) scene.movementInstruction = null;
    res.json({ scene, capturedAt: new Date().toISOString() });
  });

  const searchRequest = z.object({ query: z.string().trim().min(2).max(500) });
  app.post('/api/search', limit(8), async (req, res) => {
    const parsed = searchRequest.safeParse(req.body);
    if (!parsed.success) throw new ApiError(400, 'INVALID_SEARCH', 'Enter a search query of 2 to 500 characters.');
    if (!capabilities().search) throw new ApiError(503, 'SEARCH_NOT_CONFIGURED', 'Web search needs GEMINI_API_KEY on Render.');
    const model = env.GEMINI_SEARCH_MODEL || env.GEMINI_MODEL || 'gemini-3.8-flash';
    if (!/^[a-zA-Z0-9._-]+$/.test(model)) throw new ApiError(503, 'INVALID_MODEL', 'The server search model setting is invalid.');
    const data = await providerJSON(fetchImpl,
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
        body: JSON.stringify(buildSearchPayload(parsed.data.query)), signal: requestSignal(req, res),
      }, 'Web search');
    const result = readSearchResult(data, parsed.data.query);
    if (!result) throw new ApiError(502, 'UNGROUNDED_SEARCH', 'Google Search returned no usable sources. Try a more specific search.');
    res.json(result);
  });

  const placesRequest = z.object({
    query: z.string().trim().min(2).max(200),
    latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180),
  });
  app.post('/api/places', limit(8), async (req, res) => {
    const parsed = placesRequest.safeParse(req.body);
    if (!parsed.success) throw new ApiError(400, 'INVALID_LOCATION', 'A search and valid location are required.');
    if (!capabilities().places) throw new ApiError(503, 'PLACES_NOT_CONFIGURED', 'Nearby search needs GOOGLE_PLACES_API_KEY on Render. You can still search the web with a city or area.');
    const { query, latitude, longitude } = parsed.data;
    const data = await providerJSON(fetchImpl, 'https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'X-Goog-Api-Key': env.GOOGLE_PLACES_API_KEY,
        'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.googleMapsUri,places.attributions',
      },
      body: JSON.stringify({ textQuery: query, pageSize: 5, languageCode: 'en',
        locationBias: { circle: { center: { latitude, longitude }, radius: 3000 } } }),
      signal: requestSignal(req, res, 15_000),
    }, 'Nearby search');
    res.json({ source: 'Google Maps', places: (data.places || []).slice(0, 5).map(place => ({
      name: place.displayName?.text || 'Place', address: place.formattedAddress || '',
      mapsUrl: place.googleMapsUri || null, location: place.location || null, attributions: place.attributions || [],
    })), caveat: 'Search results do not verify current menu items, spice levels, or meal prices. Open Google Maps for navigation.' });
  });
  app.use((req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Endpoint not found.' } }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error.type === 'entity.too.large') return res.status(413).json({ error: { code: 'TOO_LARGE', message: 'The image is too large. Please capture a smaller frame.' } });
    if (error.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Invalid request body.' } });
    const expected = error instanceof ApiError;
    if (!expected) console.error('Unexpected request error:', error.name);
    res.status(expected ? error.status : 500).json({ error: {
      code: expected ? error.code : 'INTERNAL_ERROR', message: expected ? error.message : 'Something went wrong. Please try again.',
    } });
  });
  return app;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 3001;
  const server = createApp().listen(port, '0.0.0.0', () => console.log(`VisioAI API listening on port ${port}`));
  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}


//features to add
//realtime directions
//different voices
//
# VisioAI

An eyes-free camera assistant that remembers a goal and helps with the next step. Vanilla JavaScript client on **Vercel**, Express API on **Render**, **ElevenLabs** for conversation, and **Gemini** for visual perception. No database or React.

## Start here

1. Install **Node.js 24 LTS** and open this folder in VS Code. Keep `client/` and `server/` inside the same repository.
2. Run `npm install` from the repository root.
3. Copy `.env.example` to `.env` in the root. Add `GEMINI_API_KEY` and `ELEVENLABS_API_KEY`. Never commit `.env`.
4. Run `npm run agent:create`. This creates the five ElevenLabs client tools, creates a private agent, and writes its ID to your local `.env`. Your ElevenLabs API key needs permission to create tools/agents and initiate conversations. You can set `ELEVENLABS_VOICE_ID` beforehand to choose a voice.
5. Run `npm run dev`. Open **http://127.0.0.1:5173** on this computer. The frontend proxies `/api` to port 3001.
6. Press **Start VisioAI**, grant camera and microphone permission, and state a goal.

The setup script can be inspected without making any API calls:

```bash
npm run agent:create -- --dry-run
```

If tool creation fails partway through, the script checkpoints the newly created IDs in `.agent-setup.json`. Re-run to resume. It does not modify an existing agent. Keep that file local. If a create request times out after being accepted, inspect ElevenLabs before retrying to avoid duplicates.

## Deploy exactly this repository

Upload these files to your GitHub repository, including `package-lock.json`, `render.yaml`, and `vercel.json`. Do not upload `node_modules`, `.env`, `.agent-setup.json`, or `client/dist`.

### 1. Render: API server

Create a Blueprint from the repository using `render.yaml`, or a Web Service with these settings:

| Setting | Value |
| --- | --- |
| Root Directory | Leave blank — repository root |
| Runtime | Node |
| Build Command | `npm ci --omit=dev` |
| Start Command | `npm start` |
| Health Check | `/api/health` |
| Node version | `24.19.0` |

Set these **Render environment variables**:

| Variable | Value |
| --- | --- |
| `GEMINI_API_KEY` | Your Google AI Studio key |
| `GEMINI_MODEL` | `gemini-3.8-flash`, or a vision-capable Gemini model available to your project |
| `ELEVENLABS_API_KEY` | Your ElevenLabs secret key |
| `ELEVENLABS_AGENT_ID` | The agent ID created locally |
| `CLIENT_ORIGINS` | Your exact Vercel origin, such as `https://visioai.vercel.app` |
| `TRUST_PROXY` | `1` for Render |
| `NODE_ENV` | `production` |
| `GOOGLE_PLACES_API_KEY` | Optional; enables nearby search |

The blueprint chooses the free plan. A [sleeping free service](https://render.com/docs/free) can delay the first connection; open its health URL before a demo. The page allows up to 70 seconds for startup configuration to load. Render supplies `PORT`; do not hardcode it.

### 2. Vercel: client

Import the **same GitHub repository**:

| Setting | Value |
| --- | --- |
| Root Directory | Leave blank — repository root, **not `client`** |
| Framework | Vite |
| Install Command | `npm ci` |
| Build Command | `npm run build` |
| Output Directory | `client/dist` |
| Environment Variable | `VITE_API_BASE_URL=https://YOUR-SERVICE.onrender.com` |

`vercel.json` supplies the build settings. The API base is the Render origin with **no `/api` suffix**. Set it for every Vercel environment you use. It is baked into the client at build time; **redeploy Vercel after changing it**.

Copy the resulting Vercel origin into Render's `CLIENT_ORIGINS`. Multiple origins are comma-separated. Preview deployment domains must be added explicitly. Do not use `*` or a wildcard matching every Vercel site.

Open the Vercel HTTPS URL on your phone. Camera/microphone do not work on an ordinary `http://192.168...` LAN address. `/api/health` on Render verifies server liveness, not provider credentials; `/api/config` verifies that required variables exist, and starting a real session verifies credentials.

## What is implemented

- Rear camera with individual JPEG captures, never continuous video uploads. The whole displayed frame is analyzed, with a 1600-pixel maximum edge.
- ElevenLabs WebRTC voice conversation, interruption, captions, and optional typed messages to the same agent.
- Persistent goal, bounded conversation history, and separate visual discoveries in browser RAM. Pause/resume preserves them while this page stays loaded.
- Schema-constrained Gemini results, runtime validation, explicit uncertainty, visible prices and translated names.
- Camera guidance followed by another scan after speech and a repositioning delay. Only one scan can be in flight. Up to five automatic scans per user turn prevent runaway retries.
- Follow-ups through `recall_memory` without another image upload.
- Wake/sleep/scan earcons, optional vibration, optional shake wake/sleep, screen wake lock when supported, and a large pause control.
- On-demand nearby search through Places API (New), attribution, and Google Maps links. The API must be enabled in the Google Cloud project with billing and a correctly restricted key.
- Exact CORS origins, request/body limits, input validation, provider timeouts, cancellation of pending HTTP requests, and sanitized API errors.

There are no fabricated AI answers or hidden demonstration responses. Without real keys, the app reports setup is needed.

## ElevenLabs tools

The setup script contains the complete agent prompt and definitions. To configure an existing agent manually, run the dry-run command and copy its definitions. Register these **client** tools and enable **Wait for response**:

| Tool | Purpose |
| --- | --- |
| `set_goal` | Store the complete current goal and stated constraints |
| `inspect_scene` | Take a fresh frame and return Gemini evidence |
| `recall_memory` | Retrieve prior observations and conversation |
| `find_places` | Request location and search nearby places |
| `pause_assistant` | Stop camera and conversation |

Use the exact tool names. `inspect_scene` uses `post_tool_speech` execution and a 45-second timeout. Enable the `client_tool_call`, `user_transcript`, `agent_response`, `audio`, `interruption`, `conversation_initiation_metadata`, and `ping` client events. Add the `session_context` dynamic variable with `{}` as its default. Keep authentication enabled; the server issues temporary conversation tokens.

## Demo and validation

Open `docs/test-menu.html` on a second screen or print its two pages. This is a **fictional test menu**, not data hardcoded into the assistant.

1. Say “I want very spicy chicken under twenty dollars.” Verify the goal updates.
2. Aim at the cover. The assistant should ask to turn the menu over, without inventing dishes.
3. Show the menu page. It should find **Pollo a la Diabla, $14.99**, and **Enchiladas de Pollo, $12.50**.
4. Ask “Which is cheaper?” The enchiladas should be answered from memory without a scan cue.
5. Ask “Which is spicier?” The menu explicitly labels the pollo very spicy and enchiladas mild.
6. Ask “Does the pollo come with rice?” The visible text says rice and beans.
7. Say “Pause.” Verify the camera/microphone stop. Resume and ask about the earlier menu.
8. Deny camera permission, deny motion permission, turn off the network, and switch apps. Verify readable errors, a working fallback button, and no unexpected restart.

Run `npm test` for API, provider-error, input-validation, CORS, memory, and agent-configuration tests. Run `npm run build` for the production client. Provider responses in automated tests are mocked; these tests cannot prove live model accuracy or latency. A real phone test with your keys is still required, particularly Safari microphone behavior, interruptions, shake thresholds, and noisy-room performance.

## Behavior and limits

- This is a hackathon MVP with no user accounts. The API's CORS allowlist and per-IP rate limits are **not authentication**. Configure provider spend limits before publishing widely; a public token endpoint allows anonymous voice sessions.
- Shake requires optional motion permission and an open, awake page. It cannot launch the app from a locked phone. Backgrounding the page pauses the session. Browser support for motion, haptics, audio cues, and wake locks varies.
- A pending OS permission prompt cannot be programmatically dismissed. Cancellation invalidates the attempt and closes late-arriving camera/voice sessions. The SDK owns microphone cleanup while a voice connection is being established.
- The server stores no media, transcript, goals, or database records. “Forget this session” clears tab memory. Google and ElevenLabs still process supplied data under their terms and configured retention. Agent creation disables voice recording and sets one-day transcript retention/deletion settings; confirm these settings in your account.
- Frame-based camera guidance is for viewing objects and reading information. It is not live mobility guidance, street-crossing assistance, or hazard detection. Allergens and unreadable information must not be guessed.
- Current tab memory is lost on reload. No authentication, background service, native app, or automatic map navigation is included.

## Reference documentation

Integration contracts were checked against [ElevenLabs JavaScript SDK](https://elevenlabs.io/docs/eleven-agents/libraries/java-script), [client tools](https://elevenlabs.io/docs/eleven-agents/customization/tools/client-tools), [agent creation](https://elevenlabs.io/docs/api-reference/agents/create), [tool creation](https://elevenlabs.io/docs/api-reference/tools/create), [Gemini generateContent](https://ai.google.dev/api/generate-content), [Places Text Search](https://developers.google.com/maps/documentation/places/web-service/text-search), [Render Blueprints](https://render.com/docs/blueprint-spec), and [Vercel project configuration](https://vercel.com/docs/project-configuration).

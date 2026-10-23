# Deploying Jax Nova

Jax Nova is a single Node process with zero dependencies, so it runs anywhere a
`node` binary exists. This guide covers **Railway** in detail, then Docker and
plain VPS hosting.

> **Why Railway is a good fit:** it terminates TLS for you. Browsers only allow
> microphone access on `localhost` or an `https://` origin — so once Jax Nova is
> deployed, the wake word works for every visitor, not just the machine running
> the server.

---

## Deploy on Railway

### 1. Push the repo to GitHub

```bash
git init
git add .
git commit -m "Jax Nova: holographic voice assistant"
git branch -M main
git remote add origin https://github.com/CyberFights/jax-nova.git
git push -u origin main
```

### 2. Create the service

1. Go to [railway.com/new](https://railway.com/new).
2. **Deploy from GitHub repo** → pick your repository.
3. Railway detects the `Dockerfile` and builds it. Nothing else is required.

While the first build runs, open **Variables** and add at minimum:

| Variable | Recommended value | Why |
| --- | --- | --- |
| `JAX_ACCESS_CODE` | a long random string | **Required for a public URL.** Without it, anyone who finds your domain can spawn images and burn every API key you configured. |
| `ANTHROPIC_API_KEY` | `sk-ant-…` | Makes the brain reliable (Claude with tool use). Optional. |
| `ELEVENLABS_API_KEY` | `…` | Natural voice + Scribe transcription. Optional. |
| `JAX_LOCATION` | `Toronto, Ontario` | Default city for weather. |

Everything else has a sane default. The full list is in `.env.example`.

### 3. Settings that live in the dashboard

Railway's `railway.json` (Config as Code) is **deprecated with a hard cutoff on
2026-12-01**, and new services can no longer opt into it — so this repo
deliberately does not ship one. The Dockerfile carries the build, and these two
settings are applied in the dashboard:

| Setting | Value |
| --- | --- |
| **Healthcheck path** | `/api/health` |
| **Restart policy** | `On failure` |

The healthcheck is only consulted while a deployment starts, to decide when it
may receive traffic. `/api/health` is always public (even when the access code
is set) and returns:

```json
{ "ok": true, "service": "jax-nova", "uptime": 12, "brain": "claude", "locked": true, "storage": "writable" }
```

### 4. Give the gallery a home (optional but recommended)

Railway containers have an **ephemeral filesystem** — every redeploy wipes
generated images and motion frames. To keep them:

1. Right-click the service → **Attach volume**.
2. Mount it at **`/data`** (the image already sets `JAX_DATA_DIR=/data`).
3. Redeploy. `/generated/*` is now served from the volume.

Without a volume everything still works; the gallery just resets on deploy.

Railway volumes are mounted owned by `root`, while the app runs as `node`. The
image ships a tiny entrypoint (`docker-entrypoint.sh`) that takes ownership of
`$JAX_DATA_DIR` and then drops privileges, so this is handled for you. If a
volume ever is not writable, `/api/health` reports `"storage": "read-only"` and
image generation degrades to inline data URLs instead of failing.

### 5. Open it

**Settings → Networking → Generate Domain.** Open the URL over `https://`, allow
the microphone, and say *“Hey Jax, what’s the weather?”*

### 6. Publish a one-click template (optional)

To offer a **Deploy on Railway** button for your own fork:

1. Create the template from your deployed service (`railway.com/new/template` → create from project).
2. Publish it and copy the template code (e.g. `AbCdEf`).
3. Replace the badge in `README.md`:

```md
[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template/AbCdEf?utm_medium=integration&utm_source=button&utm_campaign=jax-nova)
```

The badge currently points at `https://railway.com/new`, which starts the
GitHub-connected flow — correct for a repo without a published template.

---

## Environment variables

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `8787` | Railway injects its own; the server always honours `$PORT`. |
| `HOST` | `0.0.0.0` | Required for container networking. |
| `JAX_ACCESS_CODE` | *(empty)* | Set this on any public deployment. |
| `JAX_RATE_LIMIT` | `40` | Requests/min/IP on `/api/chat`, `/api/tts`, `/api/stt`. `0` disables. |
| `JAX_DATA_DIR` | `public/generated` | Point at a mounted volume for persistence. |
| `JAX_TRUST_PROXY` | `true` | Trust `X-Forwarded-For` for per-IP limits behind Railway's proxy. |
| `ANTHROPIC_API_KEY` | — | Claude tool-use brain. |
| `ELEVENLABS_API_KEY` | — | Neural voice + transcription. |
| `ELEVENLABS_VOICE_ID` | auto | Pin a specific voice — set to a cloned voice's id to make it the permanent main voice. A clone made in CONFIG is the main voice immediately, but only until the next restart/redeploy without this. |
| `JAX_VOICE_CLONE` | `true` | Allow cloning voices from audio uploads in CONFIG. Set `false` if anyone besides you holds the access code (each clone spends an ElevenLabs voice slot). |
| `JAX_VOICE_PROVIDER` | `auto` | Voice order local → ElevenLabs → browser; force one with `local`/`elevenlabs`/`browser`. |
| `JAX_LOCAL_VOICE_URL` | — | Free local voice app base URL — Voicebox `http://127.0.0.1:17493`, VoiceStudio `http://127.0.0.1:3900`. **Home deployments only:** the Jax server must reach this address, so on Railway `127.0.0.1` is the container, not your PC. Run Jax on the same machine as the voice app (or point this at a LAN/Tailscale host running it) — see README. |
| `JAX_LOCAL_VOICE_ID` | app default | Pin a local voice profile (name or id). A clone made in CONFIG is the main voice immediately, but only until restart without this. |
| `JAX_LOCAL_VOICE_MODEL` / `JAX_LOCAL_VOICE_STT_MODEL` | `tts-1` / `whisper-1` | Local engine ids (`tts-1` = the voice app's active engine). |
| `JAX_LOCAL_VOICE_KEY` | — | Bearer key for a keyed remote VoiceStudio backend; loopback needs none. |
| `OPENAI_API_KEY` | — | OpenAI-compatible brain and image generation. |
| `JAX_BRAIN` | `auto` | Force `claude`, `openai`, `free`, `claude-cli`, or `wrestle`. |
| `WRESTLE_AI_URL` | `https://wrestle-ai-production.up.railway.app` | Wrestle-ai deployment backing `/wrestling_chat`. |
| `WRESTLE_USER_ID` | `jax-nova` | Fallback memory key — the lock screen's operator name overrides it per visitor. |
| `WRESTLE_SEND_PERSONA` | `true` | Send the built-in Jax Nova persona as `system_p`. |
| `WRESTLE_HUMANIZE` | *(unset)* | `true`/`false` to override the endpoint's contraction pass. |
| `WRESTLE_TIMEOUT_MS` | `45000` | Bridge timeout before falling through to the keyless brain. |
| `JAX_LOCATION` / `JAX_UNITS` | Richmond Hill / metric | Weather defaults. |

---

## Health, limits and security

- **`/api/health`** — never gated, never rate limited. Use it for platform probes and uptime monitors.
- **Access code** — `POST /api/unlock` with `{ "code": "…" }` sets an `HttpOnly`, `SameSite=Lax`, `Secure` session cookie (HMAC of the code, 30 days). All `/api/*` routes except `health`, `capabilities` and `unlock` require it.
- **Locked HUD** — when a code is set, the page itself stays public but shows a lock screen; `/api/capabilities` returns only `{ locked, name, wakeWord }` until unlocked.
- **Rate limiting** — fixed-window per IP with `Retry-After`; unlock attempts are limited separately to slow brute force.
- **Secrets never reach the browser** — ElevenLabs is proxied through the server, and the capabilities payload only reports whether a key exists.

> The rate limiter is in-memory and per instance. If you scale to multiple
> replicas, put limits in front of the service (Cloudflare, or Railway's own
> edge controls) instead.

---

## Docker anywhere

```bash
docker build -t jax-nova .
docker run -d --name jax -p 8787:8787 \
  -e JAX_ACCESS_CODE=my-secret \
  -v jax-data:/data \
  jax-nova
```

Open <http://localhost:8787>. For a remote server, put it behind Caddy, nginx or
Cloudflare Tunnel so the origin is `https` — otherwise microphones stay blocked.

### Behind Caddy (automatic TLS, three lines)

```caddyfile
jax.example.com {
  reverse_proxy 127.0.0.1:8787
}
```

---

## Plain VPS / other PaaS

Any host that can run `node server/server.js` with `$PORT` set will work:

- **Render** → new Web Service, runtime Docker or Node, healthcheck `/api/health`.
- **Fly.io** → `fly launch`, internal port 8787, mount a volume at `/data`.
- **systemd** on a VPS:

```ini
[Service]
WorkingDirectory=/opt/jax-nova
Environment=PORT=8787 JAX_ACCESS_CODE=change-me JAX_DATA_DIR=/var/lib/jax-nova
ExecStart=/usr/bin/node server/server.js
Restart=always
User=jax
```

---

## Troubleshooting a deployment

| Symptom | Cause | Fix |
| --- | --- | --- |
| Build succeeds, deploy never goes live | Healthcheck path wrong or app not on `$PORT` | Set healthcheck to `/api/health`; the server reads `PORT` automatically |
| “No speech recognition in this browser” | Not Chrome/Edge, or insecure origin | Use Chrome/Edge on the `https://` domain |
| Wake word does nothing, MIC chip red | Mic permission denied for the origin | Allow the mic in site settings, then press **WAKE** |
| Images are line-art schematics | Free image engines rate-limited per IP | Wait, or set `OPENAI_API_KEY`; cached prompts stay instant |
| Everything 401s | `JAX_ACCESS_CODE` is set | Enter the code on the lock screen, or append `?code=…` once |
| Gallery empties after each deploy | No volume attached | Mount a volume at `/data` |
| `/api/health` shows `"storage": "read-only"` | Volume permissions or a full disk | Check the mount at `/data`; the entrypoint should have chowned it |
| First request after idle is slow | App sleeping is enabled | Disable sleeping, or accept the cold start |

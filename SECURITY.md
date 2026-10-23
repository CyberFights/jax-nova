# Security

## Reporting a vulnerability

Open a private security advisory on GitHub (Security → Report a vulnerability),
or email the maintainer listed on the repo profile. Please don't file a public
issue for anything exploitable. Expect an acknowledgement within a few days.

## The one thing to know

**Jax Nova is an API that spends money on your behalf.** Once a key is
configured, any request that reaches the server can trigger a paid ElevenLabs or
Anthropic call. Two consequences:

1. **Always set `JAX_ACCESS_CODE` when the service is publicly reachable.**
   Without it, `/api/chat`, `/api/tts` and `/api/stt` are open to anyone who
   learns the URL.
2. **Keep keys in environment variables**, never in the repo. `.env` is
   gitignored; `.env.example` contains names only.

## What is built in

| Control | Behaviour |
| --- | --- |
| Access gate | `JAX_ACCESS_CODE` → `POST /api/unlock` issues an `HttpOnly`, `SameSite=Lax`, `Secure` cookie holding an HMAC of the code (not the code). All `/api/*` routes except `health`, `capabilities` and `unlock` require it. |
| Timing-safe compare | Code and cookie values are compared with `crypto.timingSafeEqual`. |
| Rate limiting | Fixed-window per IP on chat/TTS/STT, plus a tighter window on unlock attempts, both with `Retry-After`. |
| Path traversal guard | `/generated/*` and static paths are resolved and confirmed inside their roots. |
| Secret isolation | ElevenLabs is proxied server-side; the capability report only says whether a key exists. |
| Payload caps | JSON bodies are limited to 8 MB, audio uploads to 25 MB. |
| Voice cloning | `/api/tts/voices/clone` sits behind the same access gate, requires an explicit own-voice/permission attestation, charges 10× against the rate-limit budget (each clone spends an ElevenLabs voice slot), and can be switched off with `JAX_VOICE_CLONE=false` — recommended when anyone besides the owner holds the access code. Samples are forwarded to ElevenLabs and never stored on the server. |
| XSS hygiene | HUD cards are built with DOM APIs and `textContent`; external content is never injected as HTML. |

## Known limitations

- The rate limiter is **in-memory and per instance**; multi-replica deployments
  need a shared limiter at the edge (Cloudflare, or platform controls).
- There is no per-user identity: the access code is a shared secret, not an
  account system. Rotate it by changing the variable and redeploying (this
  invalidates existing cookies because the HMAC changes).
- Browser voice features rely on the Web Speech API, which in Chrome streams
  audio to Google's servers. That is a browser behaviour, not a Jax Nova one —
  use ElevenLabs transcription if audio must not leave your infrastructure.

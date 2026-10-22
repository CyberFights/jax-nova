# Contributing

Thanks for taking a look. Jax Nova is deliberately small: plain ES modules, no
framework, no build step, no dependencies.

## Getting set up

```bash
git clone https://github.com/YOUR-USERNAME/jax-nova.git
cd jax-nova
node server/server.js       # http://localhost:8787
npm test                    # must stay green
```

Chrome or Edge is needed for the voice features; everything else works anywhere.

## House rules

- **No dependencies** unless there is no reasonable alternative. Node's built-in
  `fetch`, `http` and `FormData` cover the current feature set.
- **Every capability needs a keyless path.** If a provider needs a key, degrade
  to something that still works and say so out loud — never leave a dead screen.
- **Spoken text is not written text.** Anything passed to `say()` must survive
  `sanitizeForSpeech()`: no markdown, URLs or emoji.
- **Keep the fast paths fast.** Deterministic requests belong in `router.js` or
  `intents.js`, not in a model call.
- **Add a test** for anything in `server/` that can be tested without the network.

## Pull requests

1. Fork, branch, and keep the change focused.
2. Run `npm run check && npm test`.
3. Describe *why*, and include a screenshot for UI changes (the HUD has strong
   opinions about layout).

CI runs the tests on Node 20 and 22, then builds and boots the Docker image to
make sure the deployment path still works.

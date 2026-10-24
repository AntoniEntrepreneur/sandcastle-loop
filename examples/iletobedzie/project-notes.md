## Targeted tests

`uv run pytest tests/path/test_x.py` for the backend, `npx vitest run path` in
`frontend`. There is no `npm run test` or `npm run typecheck` at the repo root.
The formatter the orchestrator runs is `black`.

## Third-party CLIs

The sandbox has `railway` (unauthenticated: `--help` works, nothing else).
Services this repo talks to include Railway, Clerk, Cloudflare, Sentry and
Next.js.

## Screenshots

For a visual change, headless Chromium is at `/usr/bin/chromium`. Start the
app with `uv run uvicorn backend.main:app --port 8000 >/tmp/api.log 2>&1 &` and
`npm run dev --prefix frontend >/tmp/web.log 2>&1 &`, then
`chromium --headless --no-sandbox --screenshot=/tmp/shot.png --window-size=390,844 http://127.0.0.1:3000/login`
(390×844 is a phone).

## Glossary

The glossary hook refuses edits that use these terms. Use the canonical term
from GLOSSARY.md instead: {{AVOID_TERMS}}

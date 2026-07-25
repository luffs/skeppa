# Skeppa — self-hosted deploy panel

Deploys private GitHub repos onto this server via webhooks, manages encrypted ENV vars, runs apps with pm2. Single user, no Docker.

## Technology choices (decided — do not change without discussion)

- **Runtime:** Bun. **Plain ES6 JavaScript — no TypeScript.**
- **Backend:** Hono on `Bun.serve` (WebSocket via `createBunWebSocket`).
- **Database:** SQLite via `bun:sqlite`, file `data/skeppa.db`. Migrations are numbered `.sql` files in `server/src/db/migrations/` run by the homemade runner in `migrate.js`.
- **Frontend:** Vue 3 SFCs with the **Options API — not Composition API, no `<script setup>`**. Vite for tooling, vue-router. No state library.
- **Real-time:** one WebSocket at `/ws`. State sync uses **`lazy-watch` diffs**: the server keeps a LiveState proxy (`server/src/live/state.js`); the Hub broadcasts batched diffs; the client mirrors them with `LazyWatch.patch` into a Vue-reactive object (`web/src/store.js`). Deploy log lines are NOT in LiveState — they use per-deployment `logs:subscribe`/`logs:line` pub/sub.
- **Process management:** pm2 CLI (spawned, never a shell string).
- **GitHub:** GitHub App (JWT → installation token, cached). Not OAuth, not a PAT.
- **Auth:** username/password users (managed under Rigging → Crew; all have full access — no roles), bcrypt password hash (`Bun.password`), session cookie.
- **Secrets:** AES-256-GCM with `MASTER_KEY` (32-byte hex) from the panel's `.env`; unique IV per value.

## Commands

- `bun install` — install everything (workspaces)
- `bun run dev:server` / `bun run dev:web` — dev servers (Vite proxies `/api` and `/ws` to :3000)
- `bun test` — server unit tests (in `server/test/`)
- `bun run build` — build the frontend to `web/dist` (served by Hono in prod)
- `bun scripts/seed.js <user> <password>` — create/reset the admin user
- `bun start` — run the server (serves `web/dist` if present)

## Directory layout

- `server/src/` — Hono app: `routes/`, `deploy/` (runner, git, pm2), `live/` (LiveState, Hub, poller), `github/`, `auth/`, `db/`, `lib/`
- `web/src/` — Vue app: `views/`, `components/`, `store.js`, `ws.js`, `api.js`
- Deployed apps live in `APPS_DIR/<slug>/{source,shared}` (default `/srv/apps`)

## Security requirements (non-negotiable)

1. Webhook signatures (`x-hub-signature-256`) are verified with a timing-safe comparison against the **raw** body before any processing.
2. ENV values are encrypted at rest; the API returns them masked unless `?reveal=1` with a valid session.
3. Installation tokens and `MASTER_KEY` are never logged; git URLs containing tokens are redacted (`deploy/git.js`) and never persisted to `.git/config`.
4. Session cookies: `httpOnly`, `sameSite=lax`, `secure` in prod. WS upgrades validate the same session before upgrading.
5. The panel runs as its own non-root user; pm2 under the same user.
6. Any input that reaches shell commands or paths and is *not* the intentional deploy script (slugs, branch names, pm2 names, cwd, env keys) is whitelist-validated in `lib/validate.js`. Processes are spawned with args arrays — no shell interpolation of user data. The deploy script itself intentionally runs as shell; the UI says so.
7. WS client messages are schema-validated in `live/hub.js`; unknown types are ignored and logged.

# Skeppa — self-hosted deploy panel

Deploys private GitHub repos onto this server via webhooks, manages encrypted ENV vars, runs apps with pm2. Single user. No Docker for the apps; deploy scripts can optionally run in a rootless-podman build sandbox.

## Technology choices (decided — do not change without discussion)

- **Runtime:** Bun. **Plain ES6 JavaScript — no TypeScript.**
- **Backend:** Hono on `Bun.serve` (WebSocket via `createBunWebSocket`).
- **Database:** SQLite via `bun:sqlite`, file `data/skeppa.db`. Migrations are numbered `.sql` files in `server/src/db/migrations/` run by the homemade runner in `migrate.js`.
- **Frontend:** Vue 3 SFCs with the **Options API — not Composition API, no `<script setup>`**. Vite for tooling, vue-router. No state library.
- **Real-time:** one WebSocket at `/ws`. State sync uses **`lazy-watch` diffs**: the server keeps a LiveState proxy (`server/src/live/state.js`); the Hub broadcasts batched diffs; the client mirrors them with `LazyWatch.patch` into a Vue-reactive object (`web/src/store.js`). Deploy log lines are NOT in LiveState — they use per-deployment `logs:subscribe`/`logs:line` pub/sub.
- **Process management:** pm2 CLI (spawned, never a shell string) for the panel, the proxy and pm2-runtime apps. Per-project `projects.runtime` can be `container`: the app then runs in a rootless-podman container (`server/src/containers/runtime.js`) — source read-only at `/app`, `shared/` at `/data`, port published on localhost, crash restarts via engine restart policy, boot/env-refresh via panel recreation. The panel itself must always be pm2 (enforced in routes).
- **GitHub:** GitHub App (JWT → installation token, cached). Not OAuth, not a PAT.
- **Auth:** username/password users (managed under Rigging → Crew; all have full access — no roles), bcrypt password hash (`Bun.password`), session cookie. Optional Google sign-in via a Firebase web config (Rigging → Google sign-in): the frontend loads Firebase from the gstatic CDN (never the npm package), the backend validates ID tokens with the Identity Toolkit REST `accounts:lookup` and matches the verified Google email against `users.username`.
- **Secrets:** AES-256-GCM with a 32-byte-hex master key, read from `MASTER_KEY_FILE` (chmod-600 file outside repo/DATA_DIR/APPS_DIR; loose perms warned at boot) with `MASTER_KEY` env as dev fallback; unique IV per value. Decrypted ENV lives only in memory: injected into the deploy script env and via the pm2 CLI's process env (`pm2EnvBase` in `lib/shell.js` + `appEnv` in `deploy/pm2.js`), never written into ecosystem files. On-disk `.env` is a per-project opt-in (`projects.write_env_file`). At boot the panel resurrects app processes itself (`deploy/resurrect.js`, honoring `projects.auto_start`: pm2 stop via the panel clears it, start/restart/deploy set it) — apps must never be `pm2 save`d (the dump stores env in plaintext).
- **Build sandbox:** with `SKEPPA_SANDBOX=podman`, deploy scripts run in throwaway rootless-podman containers (only `source/` mounted at `/work`) via the Docker-compatible REST API on the user unix socket (`server/src/containers/client.js`) — never by spawning a CLI, so ENV travels in request bodies in memory. Rootless Docker's socket is wire-compatible (`CONTAINER_SOCKET`). No fallback to host on engine errors — that would silently drop the sandbox. Default is `host` (legacy behavior).
- **Shipyard (managed images):** Containerfiles stored in the `images` table, built via the engine's `/build` with an in-memory tar context (`lib/tar.js`, homemade ustar — no deps) into the reserved namespace `localhost/skeppa/<name>:latest`. Missing managed images are rebuilt from the DB instead of pulled (`containers/images.js` `materializeImage`) — the engine store is cache, the DB is truth. Manual Shipyard builds pass `pull: true` (refresh FROM bases); self-heal rebuilds use cached bases. Registry images refresh via the Shipyard Pull button (`POST /api/images/pull`). Empty build context: no `COPY` of local files; no registry auth on pulls.
- **Subdomain routing ("harbor gate"):** a panel-owned Caddy instance (pm2 process `skeppa-proxy`, plain HTTP) routes `subdomain.<base_domain>` → `localhost:<project port>`; the admin's system Caddy forwards the wildcard to it with one static block and owns TLS. Config is generated as JSON (`server/src/proxy/`), hot-reloaded via the local admin API (never `:2019` — that's the system instance), cold-started via pm2. The routed port is injected into the app's env as `PORT`.

## Commands

- `bun install` — install everything (workspaces)
- `bun run dev:server` / `bun run dev:web` — dev servers (Vite proxies `/api` and `/ws` to :3000)
- `bun test` — server unit tests (in `server/test/`)
- `bun run build` — build the frontend to `web/dist` (served by Hono in prod)
- `bun scripts/install.js` — interactive server install (key file, dirs, .env, admin user, pm2 + safe `pm2 save`)
- `bun scripts/seed.js <user> <password>` — create/reset the admin user
- `bun start` — run the server (serves `web/dist` if present)

## Directory layout

- `server/src/` — Hono app: `routes/`, `deploy/` (runner, git, pm2), `live/` (LiveState, Hub, poller), `github/`, `auth/`, `db/`, `lib/`, `proxy/` (harbor gate Caddy config + lifecycle)
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
8. Anything the panel spawns (deploy scripts, pm2, git) gets a minimal sanitized environment — the panel's own `process.env` (MASTER_KEY!) must never be inherited by child processes; pm2 injects its CLI env into the apps it starts, so this applies doubly there.

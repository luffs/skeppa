# ⛵ Skeppa

A self-hosted deploy panel in the spirit of a simplified buddy.works. Runs on your own Linux server, deploys private GitHub repos via webhooks, manages encrypted ENV variables, and runs apps with pm2.

- Add a project by picking a private GitHub repo + branch
- Automatic deploy on push (GitHub App webhook, HMAC-verified) or manually from the UI
- Per-project deploy script and ENV vars (AES-256-GCM encrypted at rest)
- Start/stop/restart apps via pm2
- Live deploy logs and live status over a single WebSocket ([lazy-watch](https://www.npmjs.com/package/lazy-watch) diff sync)

Stack: Bun, Hono, SQLite (`bun:sqlite`), Vue 3 (Options API) + Vite, pm2. Plain ES6 JavaScript, no TypeScript.

## Requirements

- Linux server, [Bun](https://bun.sh) ≥ 1.1, `git`, [pm2](https://pm2.keymetrics.io) (`bun install -g pm2` or via npm)
- A reverse proxy with HTTPS (Caddy/nginx). **Never expose the panel over plain HTTP** — it uses cookie sessions and carries deploy secrets.

## Install

```bash
# as a dedicated non-root user (e.g. `skeppa`)
git clone <this repo> /srv/skeppa && cd /srv/skeppa
bun install
bun run build                      # build the frontend to web/dist

cp .env.example .env
openssl rand -hex 32               # -> MASTER_KEY in .env
sudo mkdir -p /srv/apps && sudo chown $USER /srv/apps

bun scripts/seed.js admin <your-password>
pm2 start ecosystem.config.cjs && pm2 save
```

The panel listens on `http://localhost:3000`.

### Reverse proxy (Caddy example)

```caddy
deploy.example.com {
    reverse_proxy localhost:3000    # Caddy proxies WebSocket upgrades automatically
}
```

For nginx, remember to proxy WS upgrades on `/ws`:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
}
```

## GitHub App setup

Skeppa uses a GitHub App (not OAuth, not a PAT) for repo listing, clone tokens and webhooks.

1. GitHub → Settings → Developer settings → GitHub Apps → **New GitHub App**
   - Webhook URL: `https://deploy.example.com/api/webhooks/github`
   - Webhook secret: a long random string (`openssl rand -hex 24`)
   - Repository permissions: **Contents: Read-only**, **Metadata: Read-only**
   - Subscribe to events: **Push**
2. Generate a **private key** (downloads a `.pem`)
3. **Install the app** on your account/org, selecting the repos you want to deploy
4. In Skeppa → Settings, paste the App ID, the PEM private key, and the webhook secret

## Usage

1. **Settings** — paste GitHub App credentials, test the connection
2. **New project** — pick a repo and branch, set a deploy script (e.g. `bun install && bun run build`) and a start command (e.g. `bun run start`; leave empty for build-only projects)
3. **Environment tab** — add ENV vars; they're written to `shared/.env` and passed to the deploy script and pm2 app on each deploy
4. Push to the branch — the deploy runs automatically; watch the live log in the project view

Apps live in `APPS_DIR/<slug>/source` (git working copy) with `shared/.env` generated from the DB on every deploy. While a deploy runs, a second trigger queues (max 1; a newer one replaces it). Deploys are sequential per project, parallel across projects.

## Deploying Skeppa with Skeppa (dogfooding)

Add the panel's own repo as a project with pm2 name `skeppa` (must match `SKEPPA_PM2_NAME` in `.env`). The panel detects the self-deploy and runs the pm2 reload detached after the deploy finalizes, so it doesn't kill its own in-flight deploy process.

## Development

```bash
bun install
bun run dev:server        # Hono on :3000
bun run dev:web           # Vite on :5173, proxies /api and /ws
bun test                  # unit tests
```

On Windows, deploy execution (`sh`, pm2) is not supported — develop the UI/API and run real deploys on Linux.

## Security notes

- ENV values and GitHub App secrets are AES-256-GCM encrypted with `MASTER_KEY`; without that key the DB leaks nothing. Don't lose it — there is no recovery.
- Webhook payloads are verified with a timing-safe HMAC comparison before processing.
- Clone tokens are short-lived installation tokens, passed per git invocation and never written to `.git/config` or logs.
- The deploy script deliberately runs as shell **as your panel user** — that's the product. Everything else that reaches a shell or path is whitelist-validated.
- Run the panel as its own non-root user; pm2 runs under the same user.

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
bun scripts/install.js
```

The installer asks a few questions and does the rest: creates the master-key file (chmod 600 —
an existing key is never overwritten) and the data/apps directories, writes `.env`, builds the
frontend, creates the admin user and starts the panel under pm2. It runs `pm2 save` at the one
moment that is safe — while the panel is the sole pm2 process — and ends by printing the
`pm2 startup` command that makes pm2 itself start at boot. Re-running the installer is safe.

<details>
<summary>Manual install (what the script does)</summary>

```bash
bun install && bun run build
cp .env.example .env
mkdir -p ~/.skeppa && openssl rand -hex 32 > ~/.skeppa/master.key && chmod 600 ~/.skeppa/master.key
# point MASTER_KEY_FILE at that file in .env
sudo mkdir -p /srv/apps && sudo chown $USER /srv/apps
bun scripts/seed.js admin <your-password>
pm2 start ecosystem.config.cjs && pm2 save && pm2 startup
```

</details>

Run `pm2 save` only while the panel is the sole pm2 process. Deployed apps are deliberately
kept out of the pm2 dump — `pm2 save` writes every process's environment in plaintext to
`~/.pm2/dump.pm2`, which would defeat the ENV encryption. After a server reboot the panel
starts its apps again by itself (with freshly decrypted ENV), so the dump never needs them.
Stopping an app through the panel also turns off its start-at-boot flag, so it stays stopped
across reboots; starting or deploying it turns the flag back on.

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

Log in to the panel, open **Settings → GitHub App** and press **Create GitHub App**. GitHub
shows the app pre-filled ([manifest flow](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest):
webhook URL, read-only Contents/Metadata permissions and the push event are already set — only
the name is yours to tweak). Confirm it, and the App ID, private key and webhook secret land in
Skeppa automatically. GitHub then offers to **install** the app: pick the repos you want to
deploy and you are sent back to the panel, which verifies the connection. To create the app
under an organization, put the org name in the field next to the button.

Do this from the panel's real HTTPS address — the webhook URL is derived from the address in
your browser, so a panel browsed via `localhost` would register an unreachable webhook.

<details>
<summary>Manual setup (what the button automates)</summary>

1. GitHub → Settings → Developer settings → GitHub Apps → **New GitHub App**
   - Webhook URL: `https://deploy.example.com/api/webhooks/github`
   - Webhook secret: a long random string (`openssl rand -hex 24`)
   - Repository permissions: **Contents: Read-only**, **Metadata: Read-only**
   - Subscribe to events: **Push**
2. Generate a **private key** (downloads a `.pem`)
3. **Install the app** on your account/org, selecting the repos you want to deploy
4. In Skeppa → Settings, paste the App ID, the PEM private key, and the webhook secret

</details>

## Usage

An empty harbor shows a first-run checklist that tracks these steps live (GitHub App
configured? installed? first project moored?) with a button for whichever step is next.

1. **Settings** — press Create GitHub App (or paste credentials manually), test the connection
2. **New project** — pick a repo and branch, set a deploy script (e.g. `bun install && bun run build`) and a start command (e.g. `bun run start`; leave empty for build-only projects)
3. **Environment tab** — add ENV vars; on each deploy they're decrypted in memory and injected into the deploy script and the pm2 process. Nothing is written to disk unless the project opts into a `.env` file (see below)
4. Push to the branch — the deploy runs automatically; watch the live log in the project view

If a push doesn't start a deploy, open **Settings → GitHub App**: the panel lists GitHub's
recent webhook deliveries (event, response code, age) straight from GitHub's log, with a
Redeliver button to resend one once you've fixed the cause — usually a webhook URL that isn't
reachable over HTTPS from the internet.

Apps live in `APPS_DIR/<slug>/source` (git working copy). If something in the app reads `.env` from disk itself (e.g. Vite at build time), enable **"Write a plaintext .env file into the app"** in the project settings — the panel then maintains `shared/.env` (0600) plus a copy in the working dir, and deletes both when the toggle is turned off. While a deploy runs, a second trigger queues (max 1; a newer one replaces it). Deploys are sequential per project, parallel across projects.

## Build sandbox (podman)

By default the deploy script runs as a shell **on the host, as the panel user** — simple, but it
means a malicious or compromised repo's deploy script can read anything the panel can. With
rootless podman installed you can run every deploy script in a throwaway container instead:

```bash
sudo apt install podman uidmap        # or your distro's equivalent
sudo loginctl enable-linger $(whoami) # keep user services alive without a login session
systemctl --user enable --now podman.socket
# then in the panel .env:
# SKEPPA_SANDBOX=podman
```

Each deploy creates an ephemeral container from the project's **Build image** (panel default:
`docker.io/oven/bun:1`, override per project or via `BUILD_IMAGE`), mounts only
`APPS_DIR/<slug>/source` at `/work`, injects the project ENV via the engine API (in memory —
never argv or env files) and streams the output into the deploy log. The script cannot see the
master key, the database, other apps or the panel user's home. Rootless podman maps
container-root to the panel user, so files the build writes (e.g. `node_modules`) have the right
owner on the host. There is no silent fallback: if the engine is unreachable the deploy fails
with instructions rather than running unsandboxed. The image needs `/bin/sh`; network is
available for registry access. Rootless Docker's socket is wire-compatible — point
`CONTAINER_SOCKET` at it if you prefer Docker.

### Running apps in containers

With the same podman setup, each project can also *run* in a container: switch **Runtime** from
pm2 to container in the project settings. On the next deploy (or restart) the app is recreated
as `skeppa-app-<slug>`: source mounted **read-only** at `/app`, the durable `shared/` dir
writable at `/data`, the start command run via `/bin/sh`, the routed port published on
`127.0.0.1` only, and ENV injected through the engine API. The app cannot read the panel, the
master key or other apps — this is the isolation pm2 cannot give you. **Run image** overrides
the container image (default: the build image, then the panel default).

Semantics match the pm2 runtime: crash restarts are handled by the engine (`on-failure`, max
10 retries), start/restart from the panel recreates the container with freshly decrypted ENV,
stop keeps it stopped (also across reboots — same start-at-boot flag), and after a server
reboot the panel recreates running apps itself. The panel and the harbor gate proxy always run
under pm2; the panel refuses `runtime: container` for its own project.

One trade-off to know: the engine stores a created container's spec — ENV included — under
`~/.local/share/containers` (panel-user-only permissions). Exclude that directory from backups,
like the master key.

### Shipyard — managed images

Need a custom image (say bun **and** node in one)? Open **Shipyard** in the masthead: give it a
name and a Containerfile, press Build. The image lands in the engine store as
`localhost/skeppa/<name>:latest` and shows up as a suggestion in the projects' Build/Run image
fields. The Containerfile lives in the panel database, which makes these images reproducible
state: if one is missing when a container is created — pruned store, fresh server — the panel
rebuilds it from the stored Containerfile automatically instead of trying to pull. The local
image store (sizes, dangling layers, which project uses what) is listed alongside, with
per-image pull/remove and a safe dangling-only prune (dangling = untagged layers left behind
when a tag moves; removing a tagged-but-unused image is the ✕ button's job). v1 builds have an empty context: `FROM`/`RUN`/`ENV`… work, `COPY` of
local files does not. Private registries are not supported by the panel's auto-pull —
`podman pull` once manually as the panel user instead.

Updating when a new upstream version lands (say a bun release): pressing **Build** always
refreshes the `FROM` bases from their registries, so a moving tag like `oven/bun:1` picks the
new version up; automatic self-heal rebuilds keep using cached bases so a pruned store restores
fast and offline. Registry images used directly by projects have a **Pull** button in the local
store — the panel's `podman pull`. Either way the update reaches apps on their next restart or
deploy, and the replaced layers show up as dangling for pruning. Pin an exact version
(`FROM docker.io/oven/bun:1.2.19`) in the Containerfile if you want updates to be an explicit,
visible edit instead.

## Deploying Skeppa with Skeppa (dogfooding)

Add the panel's own repo as a project with pm2 name `skeppa` (must match `SKEPPA_PM2_NAME` in `.env`). The panel detects the self-deploy and runs the pm2 reload detached after the deploy finalizes, so it doesn't kill its own in-flight deploy process.

Give the project's Environment tab the panel's config and leave the `.env`-file toggle off: the panel then runs from `APPS_DIR/skeppa/source` with the key read from the file and nothing secret written into the app directory. Required: `MASTER_KEY_FILE` (a path, not a secret) and an **absolute** `DATA_DIR` — its default follows the running checkout, so after a self-deploy an unset `DATA_DIR` would point at an empty database inside `APPS_DIR/skeppa/source`. Add `APPS_DIR` only if you changed it from `/srv/apps`. None of these are secrets, so the panel's process environment stays clean.

## Development

```bash
bun install
bun run dev:server        # Hono on :3000
bun run dev:web           # Vite on :5173, proxies /api and /ws to VITE_SKEPPA_API (web/.env)
bun test                  # unit tests
```

On Windows, deploy execution (`sh`, pm2) is not supported — develop the UI/API and run real deploys on Linux.

## Security notes

- ENV values and GitHub App secrets are AES-256-GCM encrypted with the master key; without it the DB leaks nothing. Don't lose it — there is no recovery (it's 64 hex chars: keep a copy in your password manager).
- Keep the master key in a `MASTER_KEY_FILE` (chmod 600, e.g. `~/.skeppa/master.key`) rather than the `MASTER_KEY` env var: the file lives outside the repo, `DATA_DIR` and `APPS_DIR`, never enters the process environment (`pm2 env`, `/proc`, pm2 dumps), and the panel warns at boot if its permissions are loose. **Back it up separately from `data/`** — a backup containing both the DB and the key decrypts everything.
- Decrypted ENV exists only in memory: it is injected through the pm2 CLI's process environment at start/reload and into the deploy script's environment. It is never written into ecosystem files, and `.env` files on disk are a per-project opt-in (written with mode 0600).
- pm2 spawns for apps use a minimal, sanitized environment — the panel's own env (`MASTER_KEY`, tokens) is never inherited by deployed apps.
- Know the boundary: pm2 keeps each process's environment in daemon memory, so anyone with shell access as the panel user can read secrets via `pm2 env`/`pm2 show` — and deployed apps run as that same user. The encryption protects the DB, its backups and the file system at rest; it does not isolate apps from each other or from the panel. If you need that, use per-app users or containers.
- Never run `pm2 save` while apps are running (see Install) — the dump file would contain their env in plaintext.
- Webhook payloads are verified with a timing-safe HMAC comparison before processing.
- Clone tokens are short-lived installation tokens, passed per git invocation and never written to `.git/config` or logs.
- The deploy script deliberately runs as shell — that's the product. On the host it runs **as your panel user**; enable the podman build sandbox (`SKEPPA_SANDBOX=podman`) to confine it to a throwaway container that only sees the project's source. Everything else that reaches a shell or path is whitelist-validated.
- Run the panel as its own non-root user; pm2 runs under the same user.

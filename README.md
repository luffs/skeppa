# ⛵ Skeppa

A self-hosted deploy panel that turns a git push into a running app on your own Linux server. Deploys private GitHub repos via webhooks, manages encrypted ENV variables, and runs each app as a pm2 process or in its own rootless-podman container — with per-project network isolation for code you don't fully trust.

- Add a project by picking a private GitHub repo + branch
- Automatic deploy on push (GitHub App webhook, HMAC-verified) or manually from the UI
- Per-project deploy script and ENV vars (AES-256-GCM encrypted at rest)
- Run each app under pm2 or in a rootless-podman container — with per-project network profiles, memory caps and crash-loop alerts
- Live deploy logs and live status over a single WebSocket ([lazy-watch](https://www.npmjs.com/package/lazy-watch) diff sync)
- Optional extras once you're running: a throwaway-container build sandbox, managed images (Shipyard), wildcard subdomain routing (harbor gate), webhook notifications (ntfy/Discord/Slack)

Stack: Bun, Hono, SQLite (`bun:sqlite`), Vue 3 (Options API) + Vite, pm2 + rootless podman. Plain ES6 JavaScript, no TypeScript.

## Quickstart — zero to first deploy

You need a Linux server and a domain; the rest takes about ten minutes.

**1. On the server** — as a dedicated non-root user (e.g. `skeppa`):

```bash
curl -fsSL https://bun.sh/install | bash    # Bun ≥ 1.1 — skip if installed
bun install -g pm2                          # pm2 — skip if installed
git clone <this repo> ~/skeppa && cd ~/skeppa
bun scripts/install.js
```

No sudo needed — everything (checkout, config, data, apps) defaults to the panel user's home.

The interactive installer does the rest: creates the master-key file (chmod 600 — an existing
key is never overwritten) and the data/apps directories, writes the panel config to
`~/.skeppa/config`, builds the frontend, creates the admin user and starts the panel under
pm2, ending with the `pm2 startup` command that makes pm2 itself start at boot. Re-running
the installer is safe.

<details>
<summary>Manual install (what the script does), and why it runs pm2 save when it does</summary>

```bash
bun install && bun run build
mkdir -p ~/.skeppa && openssl rand -hex 32 > ~/.skeppa/master.key && chmod 600 ~/.skeppa/master.key
cp .env.example ~/.skeppa/config   # then check DATA_DIR — everything else defaults sensibly
mkdir -p ~/apps ~/.local/share/skeppa
bun scripts/seed.js admin <your-password>
pm2 start ecosystem.config.cjs && pm2 save && pm2 startup
```

The config lives at `~/.skeppa/config` (KEY=VALUE, same keys as `.env.example`) — one fixed
home regardless of which checkout the panel runs from; the process environment overrides it
per key, so a repo `.env` still works as a dev-time override.

Run `pm2 save` only while the panel is the sole pm2 process — the installer does it at exactly
that moment. Deployed apps are deliberately kept out of the pm2 dump: `pm2 save` writes every
process's environment in plaintext to `~/.pm2/dump.pm2`, which would defeat the ENV encryption.
After a server reboot the panel starts its apps again by itself (with freshly decrypted ENV),
so the dump never needs them.

</details>

**2. HTTPS in front** — the panel listens on `http://localhost:3000` and must only be exposed
through an HTTPS reverse proxy (it uses cookie sessions and carries deploy secrets — never
plain HTTP). It binds loopback only by default, so the reverse proxy is also the only way
in; set `HOST=0.0.0.0` in the panel config if you really need direct LAN access. Caddy:

```caddy
deploy.example.com {
    reverse_proxy localhost:3000    # Caddy proxies WebSocket upgrades automatically
}
```

<details>
<summary>nginx instead</summary>

Remember to proxy WS upgrades on `/ws`:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
}
```

</details>

**3. In the browser** — open `https://deploy.example.com` (the real domain, not `localhost`:
the GitHub webhook URL is derived from the address you're browsing), log in, and follow the
first-run checklist waiting on the dashboard:

1. **Create GitHub App** — one button under Settings; GitHub shows the app pre-filled and the
   credentials land in Skeppa automatically (details: [GitHub App setup](#github-app-setup))
2. **Install the app** on the repos you want to deploy, when GitHub offers it
3. **Moor a project** — pick repo + branch, give it a deploy script (e.g.
   `bun install && bun run build`) and a start command (e.g. `bun run start`; leave empty for
   build-only projects), and add ENV vars under the project's Environment tab
4. **Push to the branch** — the deploy starts by itself; watch the live log in the project view

If a push doesn't start a deploy, open **Settings → GitHub App**: the panel lists GitHub's
recent webhook deliveries (event, response code, age) straight from GitHub's log, with a
Redeliver button to resend one once you've fixed the cause — usually a webhook URL that isn't
reachable over HTTPS from the internet.

Everything below is reference for once you're sailing.

## Day-to-day

- ENV vars are decrypted in memory on each deploy and injected into the deploy script and the
  pm2 process — nothing is written to disk. If something in the app reads `.env` from disk
  itself (e.g. Vite at build time), enable **"Write a plaintext .env file into the app"** in
  the project settings: the panel then maintains `shared/.env` (0600) plus a copy in the
  working dir, and deletes both when the toggle is turned off.
- Apps live in `APPS_DIR/<slug>/source` (git working copy); durable files go in
  `APPS_DIR/<slug>/shared`.
- While a deploy runs, a second trigger queues (max 1; a newer one replaces it). Deploys are
  sequential per project, parallel across projects.
- Stopping an app through the panel also turns off its start-at-boot flag, so it stays stopped
  across reboots; starting or deploying it turns the flag back on. After a reboot the panel
  restarts its apps itself.

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

## Containers (rootless podman)

Everything in this section needs rootless podman once:

```bash
sudo apt install podman uidmap        # or your distro's equivalent
sudo loginctl enable-linger $(whoami) # keep user services alive without a login session
systemctl --user enable --now podman.socket
```

Rootless Docker works too — its socket is wire-compatible; point `CONTAINER_SOCKET` at it.

### Running apps in containers

Switch **Runtime** from pm2 to container in the project settings. On the next deploy (or
restart) the app is recreated as `skeppa-app-<slug>`: source mounted **read-only** at `/app`,
the durable `shared/` dir writable at `/data`, the start command run via `/bin/sh`, the routed
port published on `127.0.0.1` only, and ENV injected through the engine API. The app cannot
read the panel, the master key or other apps — this is the isolation pm2 cannot give you.
**Run image** overrides the container image (default: the build image, then the panel default).

Semantics match the pm2 runtime: crash restarts are handled by the engine (`on-failure`, max
10 retries), start/restart from the panel recreates the container with freshly decrypted ENV,
stop keeps it stopped (also across reboots — same start-at-boot flag), and after a server
reboot the panel recreates running apps itself. The panel and the harbor gate proxy always run
under pm2; the panel refuses `runtime: container` for its own project. A per-project **memory
limit** becomes a hard engine cap — past it the app is OOM-killed and restarted, so a leak
crashes one project instead of starving the server. The log view keeps a **Previous** tab with
the tail of the container the last deploy replaced — the post-mortem for "it crashed and then
I deployed".

One trade-off to know: the engine stores a created container's spec — ENV included — under
`~/.local/share/containers` (panel-user-only permissions). Exclude that directory from backups,
like the master key.

### Network profiles

A container project is **open** (internet and LAN, as before) or **restricted**: no internet,
no LAN, no host — enforced by having no route out at all — while its published port stays
routable, so a restricted app still serves traffic through the harbor gate. **Shared networks**
connect the containers that list the same name (they reach each other by container name, e.g.
`skeppa-app-postgres`) and never grant internet, so the typical pairing is an open app and a
restricted database sharing one network. A separate **host access** toggle lets an open project
reach services on the server's own `127.0.0.1`, which rootless podman otherwise denies.

### Build sandbox

By default the deploy script runs as a shell **on the host, as the panel user** — simple, but
it means a malicious or compromised repo's deploy script can read anything the panel can. With
`SKEPPA_SANDBOX=podman` in the panel config, every deploy script runs in a throwaway container
from the project's **Build image** instead: only `APPS_DIR/<slug>/source` is mounted (at
`/work`), ENV travels in memory via the engine API, and the script cannot see the master key,
the database, other apps or the panel user's home. There is no silent fallback: if the engine
is unreachable the deploy fails with instructions rather than running unsandboxed.

<details>
<summary>Build sandbox mechanics</summary>

- Build image default: `docker.io/oven/bun:1` — override per project or via `BUILD_IMAGE`.
  The image needs `/bin/sh`; network is available for registry access.
- Rootless podman maps container-root to the panel user, so files the build writes
  (e.g. `node_modules`) have the right owner on the host.
- Script output streams into the deploy log exactly as in host mode.

</details>

### Shipyard — managed images

Need a custom image (say bun **and** node in one)? Open **Shipyard** in the masthead: give it a
name and a Containerfile, press Build. The image lands in the engine store as
`localhost/skeppa/<name>:latest` and shows up as a suggestion in the projects' Build/Run image
fields. The Containerfile lives in the panel database, so these images are reproducible state:
a missing image — pruned store, fresh server — is rebuilt from the stored Containerfile
automatically instead of pulled. Pressing **Build** refreshes the `FROM` bases, so a moving tag
like `oven/bun:1` picks up new upstream releases; pin an exact version in the Containerfile if
you want updates to be an explicit, visible edit instead.

<details>
<summary>Image store, updates and self-heal in detail</summary>

- The local image store (sizes, dangling layers, which project uses what) is listed alongside,
  with per-image pull/remove and a safe dangling-only prune (dangling = untagged layers left
  behind when a tag moves; removing a tagged-but-unused image is the ✕ button's job).
- Manual **Build** pulls fresh `FROM` bases; automatic self-heal rebuilds use cached bases so a
  pruned store restores fast and offline.
- Registry images used directly by projects have a **Pull** button in the local store — the
  panel's `podman pull`. Either way an update reaches apps on their next restart or deploy,
  and the replaced layers show up as dangling for pruning.
- Builds have an empty context: `FROM`/`RUN`/`ENV`… work, `COPY` of local files does not.
- Private registries are not supported by the panel's auto-pull — `podman pull` once manually
  as the panel user instead.

</details>

## Subdomain routing (harbor gate)

Give each app a subdomain instead of a port number: set a **base domain** under Settings →
Harbor gate, then a **subdomain** on each project's settings (every project gets an
auto-assigned port at creation — override it if you care which one). A panel-owned Caddy
instance (pm2 process `skeppa-proxy`, plain HTTP, requires the `caddy` binary on the panel
user's PATH) routes `subdomain.<base domain>` → `localhost:<port>`, and the routed port is
injected into the app's environment as `PORT`. Your system Caddy forwards the wildcard to it
with the one static block the panel shows you, and keeps owning TLS — give the wildcard a
DNS-01 certificate or add `tls { on_demand }` to the block.

## Notifications

Point **Settings → Notifications** at any webhook that accepts a POST — an [ntfy](https://ntfy.sh)
topic gets plain text, Discord and Slack webhook URLs are recognized and get their JSON shape.
The panel notifies on failed deploys and on crash loops (repeated restarts within a few
minutes — one alert per burst, then a cooldown). Restarts the panel itself causes — deploys,
your own start/stop clicks — never alert, so a message always means something actually broke.

## Backups

`bun scripts/backup.js [dir] [--keep N]` snapshots the database via `VACUUM INTO` — safe while
the panel is running (default destination `DATA_DIR/backups`, keeping the 14 newest); wire it
to cron for a daily snapshot. The snapshots hold every setting and encrypted ENV value but are
useless without the master key, which is deliberately never part of a backup — back the key
file up separately (see Security notes).

## Deploying Skeppa with Skeppa (dogfooding)

Add the panel's own repo as a project with pm2 name `skeppa` (must match `SKEPPA_PM2_NAME`,
default `skeppa`). The panel detects the self-deploy and runs the pm2 reload detached after
the deploy finalizes, so it doesn't kill its own in-flight deploy process.

No project ENV is needed and the `.env`-file toggle stays off: whichever checkout the panel
runs from — the original install or `APPS_DIR/skeppa/source` — it reads the same
`~/.skeppa/config` and master-key file. Nothing secret, and no config, lives in the app
directory or the panel's process environment.

## Development

```bash
bun install
bun run dev:server        # Hono on :3000
bun run dev:web           # Vite on :5173, proxies /api and /ws to VITE_SKEPPA_API (web/.env)
bun test                  # unit tests
```

A `.env` in the repo root is the dev-time config (Bun loads it into the process env, which
overrides `~/.skeppa/config` per key). On Windows, deploy execution (`sh`, pm2) is not
supported — develop the UI/API and run real deploys on Linux.

## Security notes

- ENV values and GitHub App secrets are AES-256-GCM encrypted with the master key; without it the DB leaks nothing. Don't lose it — there is no recovery (it's 64 hex chars: keep a copy in your password manager).
- Keep the master key in a `MASTER_KEY_FILE` (chmod 600, e.g. `~/.skeppa/master.key`) rather than the `MASTER_KEY` env var: the file lives outside the repo, `DATA_DIR` and `APPS_DIR`, never enters the process environment (`pm2 env`, `/proc`, pm2 dumps), and the panel warns at boot if its permissions are loose. **Back it up separately from `data/`** — a backup containing both the DB and the key decrypts everything.
- Decrypted ENV exists only in memory: it is injected through the pm2 CLI's process environment at start/reload and into the deploy script's environment. It is never written into ecosystem files, and `.env` files on disk are a per-project opt-in (written with mode 0600).
- pm2 spawns for apps use a minimal, sanitized environment — the panel's own env (`MASTER_KEY`, tokens) is never inherited by deployed apps.
- Know the boundary: pm2 keeps each process's environment in daemon memory, so anyone with shell access as the panel user can read secrets via `pm2 env`/`pm2 show` — and deployed apps run as that same user. The encryption protects the DB, its backups and the file system at rest; it does not isolate apps from each other or from the panel. If you need that, switch the project's runtime to container — and give code you don't fully trust the restricted network profile.
- Never run `pm2 save` while apps are running (see Quickstart) — the dump file would contain their env in plaintext.
- Webhook payloads are verified with a timing-safe HMAC comparison before processing.
- Clone tokens are short-lived installation tokens, passed per git invocation and never written to `.git/config` or logs.
- The deploy script deliberately runs as shell — that's the product. On the host it runs **as your panel user**; enable the podman build sandbox (`SKEPPA_SANDBOX=podman`) to confine it to a throwaway container that only sees the project's source. Everything else that reaches a shell or path is whitelist-validated.
- The panel binds `127.0.0.1` by default: unreachable from the LAN and from app containers (those you grant host access excepted) — the ways in are the reverse proxy and the machine itself.
- Run the panel as its own non-root user; pm2 runs under the same user.

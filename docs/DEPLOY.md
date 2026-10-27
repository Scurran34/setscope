# Deploying setscope (manual)

Nothing here has been run for you: setscope is not deployed anywhere, and these are the steps for
when you choose to. **Before any public launch, ask 1001Tracklists for permission**: the shared catalog
republishes their tracklist data, and the server fetches tracklist pages from wherever it runs.

## What runs, and where

| Piece | What it is | Where it should live |
|---|---|---|
| Web page | `web/index.html` plus `/app.js` and `/player.ts`, served by the Node server itself (types stripped on the fly) | the same Node process |
| API | `src/server.ts` (plain `node:http`, no framework) | one long-running Node 22.18+ process |
| Database | PostgreSQL 15+ (developed on 17); schema in `db/migrations`, applied automatically at startup | managed Postgres, or Postgres on the same machine |
| Collection worker | the job queue (`src/collect/jobs.ts`): fetches tracklists one at a time, 8 s apart, with retries and pauses | **inside the API process** (in-process timers) |
| Scheduled refreshes | `BackgroundCollector` (`src/source/background.ts`): front-page collecting and re-reading sets with IDs every 6 h, max 100 fetches/day | **inside the API process** (a 15 s interval) |
| Small files | `data/` (or `SETSCOPE_DATA`): GetSongBPM key and cache, SoundCloud credentials and token, last-request time, background settings | a persistent disk next to the app |

**Why not serverless:** the queue worker and background collector are in-process timers that must keep
running between requests, and the polite fetcher keeps an 8-second gap between requests. Serverless
functions (Vercel, Netlify, Cloudflare Workers, Lambda) freeze or stop between requests, so collecting
would silently stop. Use one always-on process. The existing GitHub Pages site (`docs/index.html`) is only
the project page and stays as it is.

**Recommended:** one small Linux VM (1 vCPU / 1–2 GB RAM is plenty) running Node and Postgres, with Caddy in
front for HTTPS. Run exactly **one** app process: two would each run a queue worker and double the request
rate to 1001Tracklists.

## Environment variables

| Variable | Needed | What it does |
|---|---|---|
| `DATABASE_URL` | yes | e.g. `postgres://setscope:PASSWORD@127.0.0.1:5432/setscope` |
| `SETSCOPE_PORT` | no (7331) | port the app listens on; it always binds to 127.0.0.1, so put a reverse proxy in front |
| `SETSCOPE_SECURE_COOKIES` | yes behind HTTPS | `1` marks the session cookie `Secure` |
| `SETSCOPE_INVITE_CODE` | yes | after the first (owner) account, new accounts need this code |
| `SETSCOPE_DATA` | no (`./data`) | where the small files above live; must be persistent and private (`chmod 700`) |
| `SOUNDCLOUD_CLIENT_ID`, `SOUNDCLOUD_CLIENT_SECRET` | no | instead of entering them on the Account page |
| `SETSCOPE_GETSONGBPM_KEY` | no | instead of the Account page / `data/getsongbpm-key` |
| `SETSCOPE_GETSONGBPM_URL` | no | only if GetSongBPM's API address changes |

Secrets (database password, invite code, SoundCloud secret, GetSongBPM key) go in an environment file
readable only by the service user (below), never in git. `data/` and `.env` are already git-ignored.

## Step by step (Ubuntu 24.04 example)

1. **Machine and DNS.** Create the VM, point a domain (say `setscope.example.com`) at it, and open ports 80
   and 443 only.

2. **Install Node 24, Postgres and Caddy.**
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
   sudo apt-get install -y nodejs postgresql caddy git
   ```

3. **Database.**
   ```bash
   sudo -u postgres createuser --pwprompt setscope
   sudo -u postgres createdb --owner setscope setscope
   ```

4. **App user and code.**
   ```bash
   sudo useradd --system --create-home --home-dir /srv/setscope setscope
   sudo -u setscope git clone https://github.com/Scurran34/setscope.git /srv/setscope/app
   cd /srv/setscope/app && sudo -u setscope npm ci --omit=dev
   sudo -u setscope mkdir -p /srv/setscope/data && sudo chmod 700 /srv/setscope/data
   ```

5. **Bring your existing data (optional).** On your Mac:
   ```bash
   cd ~/Documents/setscope && npm run db:start
   "$(brew --prefix postgresql@17)/bin/pg_dump" -h 127.0.0.1 -p 54329 -U setscope --no-owner setscope > setscope-backup.sql
   ```
   Copy `setscope-backup.sql` to the server and load it into the empty database:
   ```bash
   psql "postgres://setscope:PASSWORD@127.0.0.1:5432/setscope" < setscope-backup.sql
   ```
   This keeps accounts, likes, playlists, Vault entries and every cached set. Skip it to start empty.

6. **Environment file** `/srv/setscope/setscope.env` (owner `setscope`, `chmod 600`):
   ```ini
   DATABASE_URL=postgres://setscope:PASSWORD@127.0.0.1:5432/setscope
   SETSCOPE_PORT=7331
   SETSCOPE_SECURE_COOKIES=1
   SETSCOPE_INVITE_CODE=choose-a-long-random-code
   SETSCOPE_DATA=/srv/setscope/data
   ```

7. **Service** `/etc/systemd/system/setscope.service`:
   ```ini
   [Unit]
   Description=setscope
   After=network-online.target postgresql.service

   [Service]
   User=setscope
   WorkingDirectory=/srv/setscope/app
   EnvironmentFile=/srv/setscope/setscope.env
   ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning src/server.ts
   Restart=on-failure
   RestartSec=5

   [Install]
   WantedBy=multi-user.target
   ```
   ```bash
   sudo systemctl daemon-reload && sudo systemctl enable --now setscope
   ```
   Migrations run automatically at startup (each once, in a transaction), and credits are re-derived once when
   the rules change. Watch the first start: `journalctl -u setscope -f`.

8. **HTTPS** with Caddy, `/etc/caddy/Caddyfile`:
   ```
   setscope.example.com {
     reverse_proxy 127.0.0.1:7331
   }
   ```
   ```bash
   sudo systemctl reload caddy
   ```

9. **First account.** Open `https://setscope.example.com/#/account` and create the owner account straight
   away (the first account becomes the owner; after that the invite code is required).

10. **Chrome extension for a hosted site.** The extension only talks to `127.0.0.1:7331` and `localhost:7331`.
    For the hosted site, add your domain to `extension/manifest.json` under `host_permissions` and the second
    `content_scripts` entry's `matches` (e.g. `https://setscope.example.com/*`), bump `version`, and reload the
    extension in `chrome://extensions`.

## Updating

```bash
cd /srv/setscope/app
sudo -u setscope git pull
sudo -u setscope npm ci --omit=dev
sudo systemctl restart setscope
```
Back up first (`pg_dump`, below): migrations only add, but a backup makes rollback trivial.

## Backups and rollback

```bash
pg_dump "postgres://setscope:PASSWORD@127.0.0.1:5432/setscope" | gzip > /srv/setscope/backup-$(date +%F).sql.gz
```
Run it daily from cron and keep a week. To roll back: stop the service, check out the previous commit,
restore the matching backup into an empty database, start the service.

## Logs and monitoring

- `journalctl -u setscope` has every API request (`GET /api/... -> 200`), collection progress, pauses
  ("1001Tracklists asked to slow down"), and errors with stack traces.
- Health check: `curl -fsS http://127.0.0.1:7331/api/status` returns sets indexed and queue state; point an
  uptime monitor at `https://setscope.example.com/api/status`.
- If collecting is paused by the site (HTTP 403 with Retry-After), it waits; the Queue panel shows why. Don't
  work around it (no proxies or IP rotation).

# Deploy Trivattle on Render

This guide deploys one Node service with the existing React build, API, Better Auth,
Socket.IO, and SQLite. Use a **2 GB / 1 CPU service (Standard / 1c-2g)** and a **1 GB
persistent disk**. Budget roughly **US$25.25/month**, plus the domain, taxes, and any
usage overages; confirm Render's displayed price before creating the service.
[Pricing](https://render.com/pricing).

The inspected catalogue has 834 playable cards and used about 475 MB in a local
loading/validation probe. A 512 MB instance leaves too little headroom. This is not
a concurrency capacity guarantee: check Render's memory metrics during a two-player
match. Keep **one instance and one Node process**. Do not add PM2 cluster mode,
Redis, a separate frontend host, or Postgres for this deployment.

## Before you start

1. Commit and push the deployment changes to your GitHub repository's `main` branch.
   Review the changes first. The staged removal of `data/cards-server.json` removes
   it from Git; the local file is retained and ignored. Never force-add it back.
2. Run these checks locally from the repository root:

   ```sh
   npm ci --include=dev
   npm run check
   npm run build
   npm test
   npm run test:browser
   npm run catalogue:verify -- data/catalogue/catalogue.json
   ```

3. Keep your existing `.env`, `data/player/`, and `data/catalogue/` untouched.
   Production starts with **new accounts**, using a separate SQLite database.

   After the checks pass, review and publish the prepared code changes:

   ```sh
   git status --short
   git diff
   git diff --cached --stat
   git add .env.example .gitignore .node-version DEPLOYMENT.md README.md package.json package-lock.json scripts src test/deployment.test.ts web/vite.config.ts
   git diff --cached --stat
   git commit -m "Prepare single-service Render deployment"
   git push origin main
   ```

   Review the staged filenames before committing. Your ignored `.env`, catalogue,
   player database, backups, and local answer export must not be added. The answer
   export's staged deletion is intentional. Do not use `git add -f`.

4. Generate a new production secret with `openssl rand -base64 32`. Save it in a
   password manager and enter it only in Render. Keep it stable across redeploys.
5. The repository remains public. An older answer-bearing export is still in Git
   history. Removing the current export does not revoke previously published copies.
   The full production catalogue must be transferred privately, never committed or
   placed in `web/`, `dist/web/`, or another public static directory.

## Create the Render service

1. Sign up at [Render](https://render.com/) with GitHub. Choose the Hobby workspace;
   you need paid service compute, not a paid team workspace.
2. Select **New → Web Service**, connect GitHub, and choose
   `izaakdonaldson/Trivattle`.
3. Enter the following settings:

   | Setting            | Value                                   |
   | ------------------ | --------------------------------------- |
   | Name               | `trivattle`, or an available variation  |
   | Branch             | `main`                                  |
   | Region             | Oregon                                  |
   | Runtime            | Node                                    |
   | Root directory     | Leave blank (repository root)           |
   | Instance           | 2 GB RAM, 1 CPU: Standard / `1c-2g`     |
   | Build command      | `npm ci --include=dev && npm run build` |
   | Start command      | `npm start`                             |
   | Pre-deploy command | Leave blank                             |
   | Health-check path  | `/health`                               |
   | Instances          | One                                     |
   | Auto-deploy        | On commit                               |

4. In **Advanced**, add a **1 GB persistent disk**, mounted at `/var/data`.
5. Add the environment variables in the next section. Initially **omit**
   `BETTER_AUTH_URL`: the server uses Render's assigned HTTPS origin.
6. Leave all other settings at their defaults. Click **Create Web Service**.
7. Watch the deployment output; open the service's **Logs** page for runtime logs.
8. Copy the assigned `https://...onrender.com` address. Visit `/health` there;
   expect HTTP 200 and `{"status":"ok"}`.

The app initially logs that the catalogue is missing. This is intentional so the
service can start and you can upload through its shell. **Health is a process
check, not proof that cards are installed. Do not invite players yet.**

Node is pinned by `.node-version` to 24.18.0; explicitly setting `NODE_VERSION` to
that value makes the dashboard configuration clear. The build includes TypeScript
and Vite development dependencies. Production uses compiled Node code, not Vite dev.
The sprite warnings during Vite build are expected: Node serves the two tracked
`images/*.png` sprite sheets through its explicit `/images` routes.

## Environment variables

Enter service variables in **Environment → Add Environment Variable**. Do not
upload your development `.env`. `.env.example` contains blank assignments only:
fill required entries and leave optional ones blank or omit them. Platform-managed
variables below should not be copied from your own machine.

| Variable              | Production value / where to obtain it                          | Purpose                                                  |
| --------------------- | -------------------------------------------------------------- | -------------------------------------------------------- |
| `NODE_VERSION`        | `24.18.0`                                                      | Tested Node runtime                                      |
| `NODE_ENV`            | `production`                                                   | Production validation, secure behavior, disables lab     |
| `HOST`                | `0.0.0.0`                                                      | Listen on Render's network interface                     |
| `PORT`                | Leave unset; Render supplies it (normally 10000)               | HTTP and Socket.IO port                                  |
| `BETTER_AUTH_SECRET`  | Output of `openssl rand -base64 32`                            | Required authentication secret; at least 32 characters   |
| `BETTER_AUTH_URL`     | Initially omit; set `https://trivattle.tech` at domain cutover | Canonical browser origin and exact trusted origin        |
| `RENDER_EXTERNAL_URL` | Render supplies it; do not edit                                | Temporary HTTPS origin fallback                          |
| `RENDER`              | Render supplies it; do not edit                                | Confirms Render proxy configuration is intentional       |
| `PLAYER_DB`           | `/var/data/player/player.sqlite`                               | Persistent accounts, sessions, inventory and social data |
| `CARD_DATA_DIR`       | `/var/data/catalogue`                                          | Existing server-only catalogue directory                 |
| `IMAGE_CACHE_DIR`     | `/var/data/art-cache`                                          | Persistent downloaded artwork                            |
| `TRUST_RENDER_PROXY`  | `true` on Render only                                          | Use a validated edge client IP for auth rate limits      |
| `LOCAL_BATTLE_LAB`    | `false`                                                        | Explicitly disable sandbox                               |

The server rejects non-HTTPS production origins, URL credentials, paths, query
strings, invalid ports, and short secrets before opening the player database.
URLs should be origins only, with no `/#/collection` suffix. There are no OAuth
redirects to register. HTTPS origins cause Better Auth to use secure cookies.
Email verification and password-reset email delivery remain unconfigured.

### Optional runtime settings — leave unset to preserve gameplay

| Variables                         | Default / purpose                                        |
| --------------------------------- | -------------------------------------------------------- |
| `STARTER_PACKS`, `PACK_CAPACITY`  | Both `3`; onboarding grant and regeneration cap          |
| `PACK_REGEN_MS`                   | `300000`; five-minute regeneration interval              |
| `TRADE_EXPIRY_MS`                 | `1800000`; thirty-minute unfinished-trade expiry         |
| `PACK_WEIGHTS`                    | `[55,28,12,4,1]`; Common through Legendary               |
| `PACK_EMPTY_POOL`                 | `reject`; reject packs when a required rarity is missing |
| `RECONNECT_MS`                    | `120000`; two-minute disconnected-player grace period    |
| `LOBBY_IDLE_MS`, `BATTLE_IDLE_MS` | `1800000`, `7200000`; idle cleanup                       |
| `CARD_CONFIG`, `TYPE_CONFIG`      | Bundled gameplay/effectiveness JSON; no override needed  |

### Local tools only — do not add these to Render

| Variables                                                           | Purpose / source                                                          |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `WIKIMEDIA_USER_AGENT`                                              | Generator contact identity, e.g. your app name and real contact address   |
| `DEEPSEEK_API_KEY`                                                  | Obtain from DeepSeek only if generating cards locally                     |
| `DEEPSEEK_MODEL`, `DEEPSEEK_BASE_URL`, `DEEPSEEK_THINKING`          | Generator provider settings; defaults in code                             |
| `JEV_API_KEY`, `JEV_MODEL`                                          | Optional generation provider credentials/model; obtain from that provider |
| `CARD_CATALOGUE`                                                    | Local generator output directory, default `data/catalogue`                |
| `SIM_GAMES`, `SIM_CORRECT_PROBABILITY`, `SIM_MAX_TURNS`, `SIM_SEED` | Local simulation settings; use existing defaults                          |

Runtime gameplay never calls AI generation providers. Never prefix a secret with
`VITE_`; Vite-prefixed values may be shipped to browsers.

## Upload the catalogue without regenerating it

1. In the live service's **Shell** (not an ephemeral shell or one-off job), run:

   ```sh
   mkdir -p /var/data/catalogue /var/data/backups
   ```

2. Reuse an existing SSH public key, or generate a dedicated key locally:

   ```sh
   ssh-keygen -t ed25519 -f ~/.ssh/trivattle_render
   cat ~/.ssh/trivattle_render.pub
   ```

   If that filename already exists, reuse it instead of overwriting it. Add the
   **public `.pub` contents only** in **Render Account Settings → SSH Public Keys**.

3. In the service's **Connect → SSH** tab, copy its destination `USER@HOST`.
   Test the supplied SSH command. Check the host-key fingerprint against
   [Render's SSH documentation](https://render.com/docs/ssh).
4. From your local repository root, upload to a temporary name:

   ```sh
   scp -i ~/.ssh/trivattle_render data/catalogue/catalogue.json USER@HOST:/var/data/catalogue/catalogue.upload.json
   sha256sum data/catalogue/catalogue.json
   ```

   Replace `USER@HOST` with Render's actual destination. If reusing a different key,
   change `-i` accordingly. Modern OpenSSH `scp` uses SFTP by default.

5. In Render's live service Shell, run:

   ```sh
   sha256sum /var/data/catalogue/catalogue.upload.json
   npm run catalogue:verify -- /var/data/catalogue/catalogue.upload.json
   ```

   The local and remote checksums must match. Verification must exit successfully.
   The inspected snapshot has 834 playable cards: 22 Common, 373 Uncommon, 245 Rare,
   128 Epic, 66 Legendary. A newer intentionally generated local snapshot may differ.
   The verifier accepts the upload filename and never changes the file.

6. On this **first installation only**, publish it without replacing existing data:

   ```sh
   test ! -e /var/data/catalogue/catalogue.json &&
     mv /var/data/catalogue/catalogue.upload.json /var/data/catalogue/catalogue.json
   ```

   If the destination already exists, stop and inspect it; do not delete it to make
   the command work. Future catalogue updates must retain versions referenced by
   existing inventories and must be backed up first.

7. Restart the service from its dashboard and inspect Logs for `catalogue_loaded`
   with a nonzero published count. Open **All cards** and verify the catalogue.
8. Register two **new** accounts on the temporary URL and test the game.

No player database is transferred. Artwork downloads into `/var/data/art-cache`
on demand; missing images fall back to tracked type artwork. Do not run `cards`,
`fixtures`, `cards:images`, or any generation job as part of deployment.

## Connect trivattle.tech

1. Purchase `trivattle.tech` from your chosen registrar. Keep its normal DNS service;
   you do not need a second hosting provider or to change nameservers.
2. In Render, open **Settings → Custom Domains → Add Custom Domain** and enter
   **`trivattle.tech` first**. Render also adds `www` and redirects it to the root.
3. In the registrar's DNS management page, use these records for a typical provider:

   | Type    | Name / Host | Value                                                                  |
   | ------- | ----------- | ---------------------------------------------------------------------- |
   | `A`     | `@`         | Render's displayed IPv4 address (currently `216.24.57.1`)              |
   | `CNAME` | `www`       | Your assigned `...onrender.com` hostname, without `https://` or a path |

   `@` means the root domain. Leave TTL at automatic/default. Remove conflicting
   parking/forwarding records and `AAAA` records **for these two hostnames**. Preserve
   unrelated email/MX records. If the dashboard supplies updated values, use those.
   With Cloudflare DNS, use Render's documented flattened root CNAME setup instead
   and keep your own Cloudflare proxy disabled (DNS only).

4. Return to Render and click **Verify** for both domains. Propagation often takes
   minutes, but caches can take 24–48 hours. Render automatically issues and renews
   HTTPS certificates and redirects HTTP to HTTPS; do not purchase a certificate.
5. Once verification and certificates succeed, set
   `BETTER_AUTH_URL=https://trivattle.tech` under **Environment**, then redeploy.
6. Open `https://trivattle.tech` and log in again. Cookies from `onrender.com` do not
   move between domains; the accounts remain in the same production database.
7. Verify `www` redirects to the root, HTTP redirects to HTTPS, and
   `https://trivattle.tech/health` returns `{"status":"ok"}`. You can inspect DNS with:

   ```sh
   dig +short trivattle.tech A
   dig +short www.trivattle.tech CNAME
   curl -I https://www.trivattle.tech
   curl https://trivattle.tech/health
   ```

8. Repeat the two-account tests below on the custom domain. Then disable the
   **Render Subdomain** in service settings so players use the canonical origin.

References: [custom domains](https://render.com/docs/custom-domains),
[DNS records](https://render.com/docs/configure-other-dns),
[Cloudflare DNS](https://render.com/docs/configure-cloudflare-dns).

## Persistence, updates, and backups

The disk holds the database and its WAL files under `/var/data/player/`, the
catalogue under `/var/data/catalogue/`, and downloaded images under
`/var/data/art-cache/`. Keep the disk attached to this service. Monitor disk usage in Render, especially as
artwork accumulates; expand the disk before it fills. Other filesystem
changes are ephemeral. Startup applies missing migrations automatically; do not
run them during build/pre-deploy, when Render's disk is unavailable.

Pushes to `main` trigger builds and deployment. Check locally before pushing. A
redeployment briefly interrupts service and **ends active lobbies/battles**, which
live in memory. Accounts, inventories, pack timers, friends, trades, sessions, and
catalogue persist. Unfinished trades require fresh confirmations. Pause automatic
deploys during a live hackathon demonstration.

Before an update that changes the database, open the live service Shell and run:

```sh
npm run db:backup -- /var/data/backups/player-before-update.sqlite
```

Choose a new filename each time: backups never overwrite existing files. This
uses SQLite's online backup API, including committed WAL changes; it does not run
migrations or copy an inconsistent live `.sqlite` file. Download it locally:

```sh
mkdir -p data/backups
scp -i ~/.ssh/trivattle_render USER@HOST:/var/data/backups/player-before-update.sqlite data/backups/
scp -i ~/.ssh/trivattle_render USER@HOST:/var/data/catalogue/catalogue.json data/backups/catalogue-before-update.json
```

Save downloaded backups somewhere safe outside the hosting account. Keep each
backup with its matching catalogue and record the deployed Git commit. Do not
rely solely on disk snapshots for database recovery. A restore must stop all
writers before replacing the database and removing obsolete WAL/SHM files; test
restores in isolation first. Reverting application code does not revert database
migrations. Do not delete the service or disk to troubleshoot a bad deploy.
[Disk limitations and backups](https://render.com/docs/disks).

## Launch acceptance checklist

- [ ] Website loads on the temporary URL, then on `trivattle.tech`; HTTPS and `www`
      redirect work. Refresh `/#/collection` and `/#/packs` without a 404.
- [ ] Card artwork, type sprites, and backgrounds load; browser console has no
      serious errors. External font/image failures retain usable fallbacks.
- [ ] Register, log in, log out, refresh while logged in, and log in again. Inspect
      cookies in browser developer tools: production session cookies are Secure
      and HttpOnly. No OAuth callback setup is needed.
- [ ] Pack count and free-pack countdown work; opening gives five cards and survives
      refresh. A retried opening cannot give duplicate rewards.
- [ ] Collection persists after logout/login; foreign inventory IDs are rejected.
- [ ] Two separate browser profiles add each other as friends, review offers,
      complete a trade, and see both collections update.
- [ ] Player A creates a lobby, B joins, both privately choose five owned copies,
      both ready, teams reveal, A attacks, B answers trivia, damage/turns synchronize,
      and the battle finishes. Brief disconnect/reconnect restores private state.
- [ ] Browser Network shows a successful Socket.IO WebSocket upgrade over WSS;
      no localhost requests or mixed-content errors occur.
- [ ] Pending trivia payloads contain no answer index. `/data/catalogue/catalogue.json`,
      `/data/cards-server.json`, `/.env`, and `/data/player/player.sqlite` return 404.
      `/__test/clock` and local battle creation endpoints are unavailable in production.
- [ ] Restart and then redeploy: accounts, inventories, pack timers, friends, trades,
      and all catalogue versions remain. Ending active battles is expected.
- [ ] Logs and memory metrics look healthy during multiplayer. Download a consistent
      database backup and verify it opens using SQLite `PRAGMA integrity_check`.

### Verify the proxy trust boundary on the actual host

The app trusts a single valid `CF-Connecting-IP` only when `TRUST_RENDER_PROXY=true`
and Render's `RENDER=true` is present. It ignores arbitrary `X-Forwarded-For` and
replaces the internal `x-trivattle-client-ip`. Unit tests cannot prove that the
hosting edge overwrites forged headers, so this is a **live launch gate**.

Using a disposable test account, reach the auth sign-in rate limit from one IP
with repeated incorrect-password requests (stop as soon as HTTP 429 appears).
Repeat the same request with forged `CF-Connecting-IP: 192.0.2.10`,
`X-Forwarded-For: 192.0.2.11`, and `x-trivattle-client-ip: 192.0.2.12` headers.
It must remain rate-limited; changing headers must not evade it. Try a second real
network to check clients are not all collapsed into the proxy's IP. Wait for the
rate window to expire before normal testing. Do not log passwords or cookies.
If spoofing bypasses the limit, set `TRUST_RENDER_PROXY=false` and investigate with
Render before opening registration widely; this safe fallback groups traffic by
proxy and can rate-limit legitimate visitors together.

## Troubleshooting

| Symptom                                   | Check                                                                         |
| ----------------------------------------- | ----------------------------------------------------------------------------- |
| Startup configuration error               | HTTPS origin only, secret >=32 characters, valid port, Render-only proxy flag |
| Build cannot find Vite/TypeScript         | Use `npm ci --include=dev && npm run build`                                   |
| Service unreachable                       | `HOST=0.0.0.0`, assigned `PORT`, service Logs                                 |
| Empty catalogue / unavailable packs       | Correct mounted path, completed upload, verifier, nonempty rarity pools       |
| Accounts disappear after redeploy         | `PLAYER_DB` must be under the attached `/var/data` disk                       |
| Login or sockets fail after domain change | Exact `BETTER_AUTH_URL`, correct browser origin, fresh login                  |
| API says generic failure                  | Look for fixed event codes in Logs; do not enable secret/request-body logging |
| DNS verification pending                  | Conflicting A/AAAA/CNAME records, registrar forwarding, propagation           |
| Memory exhausted                          | Metrics, correct 2 GB service size, one process; do not regenerate catalogue  |

Operational logs deliberately omit raw exception messages and request bodies.
The health endpoint reveals no database paths, counts, credentials, or host details.

# Deploying Budgee

Budgee is one server, the API plus the PWA, with a SQLite database. It runs in Docker with
`docker compose`, the same way on a laptop (Docker Desktop) or on a VM. It runs the migrations on
start, serves the app and the API, and runs the daily backup with its own timer (an hourly check,
03:00 UTC).

Every device keeps a full copy of the data and works offline. The server only stores encrypted
rows, so nobody with access to the server can read your entries.

HTTPS is required, because service workers and the camera need it. It comes from an optional front
end, picked with a compose profile:

| Profile | Address | Who can reach it |
| --- | --- | --- |
| none | `http://127.0.0.1:8787` | This machine only |
| `tailscale` with `TS_MODE=funnel` | `https://<TS_HOSTNAME>.<tailnet>.ts.net` | Anyone; devices don't need Tailscale |
| `tailscale` with `TS_MODE=private` | `https://<TS_HOSTNAME>.<tailnet>.ts.net` | Devices on your tailnet only |
| `caddy` | `https://<DOMAIN>` | Anyone |

**Choose the address first.** The app's origin must never change once devices are paired. Each
device's offline data, installed app and service worker belong to that origin, and the Google
redirect URI is registered for it. Moving to another address means pairing every device again.

## 1. What you need

- [Docker](https://docs.docker.com/get-docker/) with Compose v2: Docker Desktop on Windows or
  macOS, or Docker Engine on Linux.
- This repository: `git clone`, then work from its root.
- For Tailscale: a free [Tailscale](https://tailscale.com) account.
- For Caddy: a domain, and a machine whose ports 80 and 443 are reachable from the internet.

Nothing else is installed on the machine: the image builds the web app and runs the server with
Bun.

On Windows, run `docker compose` from PowerShell or cmd. From Git Bash, the build can stop with
`additional privileges requested: pass "--allow=fs.read=Dockerfile"`, because the working
directory there is spelled `c:\…` instead of `C:\…`. `cd "C:/path/to/repo"` first avoids it.

## 2. The settings file `.env`

Copy `.env.example` to `.env`, next to `compose.yaml`, and fill it in. It is git-ignored and never
copied into the image; never commit it. Compose passes it to the server, and reads its Docker
settings itself. Without a `.env`, the app still starts, with setup disabled.

| Variable | What it is |
| --- | --- |
| `PUBLIC_ORIGIN` | The app's address, `https://` plus the hostname, no trailing slash, e.g. `https://budgee.tail1234.ts.net` or `https://budgee.example.com`. Never changes. |
| `SETUP_SECRET` | What the first device types to claim the server. Until a device has done that, whoever knows it owns the server, so use at least 32 random characters: `docker run --rm oven/bun:1.4.4-slim bun -e "console.log(crypto.randomUUID()+crypto.randomUUID())"`. The server logs a warning at start when it is shorter. After the first device is set up, `/setup` refuses everyone. |
| `CONFIG_KEY` | 32 random bytes in base64; encrypts the stored Google Drive token. Keep it forever: a new one loses the Drive connection. `docker run --rm oven/bun:1.4.4-slim bun -e "console.log(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'))"` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | From "Google Drive backups" below. Without them the app works, without backups. |
| `CRON_SECRET` | Only for an external scheduler; see "Without the built-in timer". |
| `COMPOSE_PROFILES` | The front end: empty, `tailscale` or `caddy`. |
| `TRUST_PROXY` | Leave empty. It turns on by itself when `COMPOSE_PROFILES` names a front end. Set it to `1` only when you pick the front end with `--profile` on the command line instead. |
| `TS_AUTHKEY`, `TS_HOSTNAME`, `TS_MODE` | Tailscale only; see below. |
| `DOMAIN` | Caddy only; see below. |

`HOST`, `PORT`, `DATABASE_PATH` and `WEB_DIST` are for running without Docker. Inside the
container, `compose.yaml` fixes them (`0.0.0.0`, `8787`, `/data/budgee.sqlite`, the built app).

After changing `.env`, run `docker compose up -d` again. It recreates the containers whose
settings changed.

## 3. Run locally

```sh
docker compose up -d
docker compose ps          # app: "Up … (healthy)" after a few seconds
docker compose logs app    # "API listening on http://0.0.0.0:8787/", and any SETUP_SECRET warning
```

The app is at `http://127.0.0.1:8787`. The port is published on this machine only
(`127.0.0.1`), never to the network. A browser treats `127.0.0.1` and `localhost` as secure, so
the app installs and works there. Other devices need one of the front ends below.

`docker compose down` stops it. The data stays in the `budgee-data` volume, and the next `up`
continues from it.

**Set up the first device:** open the app, **Settings → Sync and devices → Connect to a server**,
type the setup secret, and save the recovery key it shows. Pair the other devices from **Add
device with QR code**.

## 4. Public HTTPS with Tailscale Funnel

Funnel gives the app a public `https://<TS_HOSTNAME>.<tailnet>.ts.net` address with a valid
certificate. No domain or open port is needed, and phones and laptops don't need Tailscale: the
Tailscale container is the only Tailscale node.

1. **Allow HTTPS and Funnel in your tailnet** (admin console, [login.tailscale.com](https://login.tailscale.com/admin)):
   - **DNS:** enable **MagicDNS** and **HTTPS Certificates**. The DNS page also shows your tailnet
     name, the `<tailnet>.ts.net` part of the address.
   - **Access controls:** let the node use Funnel. Add the `funnel` attribute to the tailnet
     policy, for example for every member:

     ```json
     "nodeAttrs": [
       { "target": ["autogroup:member"], "attr": ["funnel"] }
     ]
     ```

     The first time you use Funnel, the admin console may offer to add this for you.
2. **Create an auth key:** **Settings → Keys → Generate auth key**. Make it **not** ephemeral, so
   the node and its address survive restarts. Reusable is not needed. Copy it into `TS_AUTHKEY`.
   The key is used once, to log in; afterwards the node's state lives in the `ts-state` volume.
3. **Fill in `.env`:**

   ```sh
   COMPOSE_PROFILES=tailscale
   TS_AUTHKEY=tskey-auth-…
   TS_HOSTNAME=budgee
   TS_MODE=funnel
   PUBLIC_ORIGIN=https://budgee.<tailnet>.ts.net
   ```

4. `docker compose up -d`, then `docker compose logs tailscale`. Once it has logged in, the
   machine appears in the admin console, and `https://budgee.<tailnet>.ts.net/api/v1/health`
   answers from anywhere. The first request can take a few seconds while the certificate is
   issued.

That address is your `PUBLIC_ORIGIN`, and the base of the Google redirect URI. If the name is
taken in your tailnet, Tailscale adds a suffix (`budgee-1`); use the name the admin console shows.
Under **Machines**, you can turn off key expiry for this machine, so it never needs a new key.

How it is wired: `deploy/tailscale/funnel.json` is the serve configuration that the container
loads (`TS_SERVE_CONFIG`). It serves HTTPS on port 443 and proxies `/` to `http://app:8787` on
the compose network, with Funnel on. Tailscale sets `X-Forwarded-For` to the client's address,
replacing any value the client sent, plus `X-Forwarded-Host` and `X-Forwarded-Proto`. With
`TRUST_PROXY` on, the rate limit counts per client by that address.

## 5. Private with Tailscale serve

The same, without Funnel: the address works only on devices signed in to your tailnet. Phones then
need the Tailscale app running to sync, but work fully offline without it.

Do steps 1 to 4 above with `TS_MODE=private`; the policy's `funnel` attribute is not needed. The
container then loads `deploy/tailscale/private.json`, which is the same configuration without
`AllowFunnel`.

Switching between `funnel` and `private` keeps the address: change `TS_MODE` and run
`docker compose up -d` again.

## 6. Caddy with your own domain

[Caddy](https://caddyserver.com) gets and renews a certificate for your domain by itself.

1. Point the domain's DNS (an `A` or `AAAA` record, e.g. `budgee.example.com`) at the machine.
   Open ports 80 and 443 to the internet. Port 8787 stays closed: compose publishes it on
   `127.0.0.1` only.
2. In `.env`:

   ```sh
   COMPOSE_PROFILES=caddy
   DOMAIN=budgee.example.com
   PUBLIC_ORIGIN=https://budgee.example.com
   ```

3. `docker compose up -d`, then `docker compose logs caddy` until the certificate is obtained.

`deploy/caddy/Caddyfile` is `{$DOMAIN} { reverse_proxy app:8787 }`. Caddy sets `X-Forwarded-For`
to the address that connected to it, ignoring any value the client sent. The certificates are kept
in the `caddy-data` volume.

## Rate limit on setup and pairing

`/api/v1/setup` (until the first device) and `/api/v1/devices/pair` (one-time codes, valid 10
minutes) are the only endpoints that take a guessable secret without a device token. The server
allows 10 POSTs a minute per client IP to the two together, every spelling of their paths
included. After that it answers `429` with `{"error":{"code":"rate_limited"}}` and
`Retry-After: 60`, which the app shows as "Too many attempts". The count is kept in memory, so a
restart clears it.

Without a front end, the client IP is the connection's address. Behind Tailscale or Caddy
(`TRUST_PROXY` on), it is the first `X-Forwarded-For` entry, which the front end sets. Never turn
`TRUST_PROXY` on when clients can reach the app without going through the front end: anyone could
then send a new `X-Forwarded-For` with every attempt.

The secrets themselves are hard to guess: a setup secret of 32 or more random characters, and
pairing codes of 8 characters from 32, valid 10 minutes and once.

## 7. Google Drive backups

Backups are encrypted files in your own Google Drive. The server only gets access to the files it
creates (the `drive.file` scope).

1. Open [Google Cloud Console](https://console.cloud.google.com/) and create a project (for
   example "Budgee").
2. **APIs & Services → Library**: enable **Google Drive API**.
3. **APIs & Services → OAuth consent screen** (Google Auth Platform):
   - User type **External**; app name "Budgee"; your email as support and developer contact.
   - **Data access / Scopes**: add `https://www.googleapis.com/auth/drive.file` (non-sensitive, so
     it needs no Google review).
   - **Audience**: click **Publish app** to move it from *Testing* to *In production*. While it is
     in Testing, Google expires the refresh token after 7 days and backups stop with "reconnect
     needed". With only the `drive.file` scope, publishing needs no verification; Google may show
     an "unverified app" screen once when you connect, which you can continue past for your own
     app.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type **Web application**.
   - **Authorised redirect URI**: `PUBLIC_ORIGIN` followed by `/api/v1/backups/google/callback`,
     e.g. `https://budgee.<tailnet>.ts.net/api/v1/backups/google/callback`.
   - Copy the client ID and secret into `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, and set
     `CONFIG_KEY`.
5. `docker compose up -d` again, then in the app: **Settings → Backups → Connect Google Drive**.

The sign-in happens in your browser, so it works even when the server is only reachable on your
tailnet (`TS_MODE=private`). The server only needs outbound internet to reach Drive.

### Without the built-in timer

The timer runs inside the server. To drive the daily run from elsewhere (a cron job, GitHub
Actions), set `CRON_SECRET` and call:

```sh
curl -X POST -H "X-Cron-Secret: $CRON_SECRET" https://budgee.example.com/api/v1/admin/run-daily
```

It is safe to call twice a day. Without `CRON_SECRET` the endpoint does not exist.

## 8. Updates

```sh
git pull
docker compose up -d --build
```

This builds the new image and replaces the running container. The data volume stays, and the new
server applies any new migrations on start. To update the front-end images (`tailscale`, `caddy`)
too, run `docker compose pull` first.

Clients pick up the new app through the service worker on their next visit, or within the hour
when the app stays open (it checks hourly while online). An "A new version of Budgee is ready"
prompt offers **Reload**; **Later** keeps the running version until the app is next opened. Data
is never lost by updating: it lives in each device and on the server.

The page and the service worker are always revalidated (`Cache-Control: no-cache`); hashed files
under `/assets/` are cached for good, since each build gives them new names. Every file is sent
with the security headers of `apps/server/entry/web.ts`: a Content Security Policy that allows only
the app's own scripts, connections and fonts and no framing, `X-Content-Type-Options: nosniff` and
`Referrer-Policy: no-referrer`.

## 9. Where the data lives

The database is `/data/budgee.sqlite` in the container, on the named volume `budgee-data`
(`budgee_budgee-data` in `docker volume ls`). It survives `docker compose down`, rebuilds and
updates. **`docker compose down -v` deletes it**, together with the Tailscale state (`ts-state`,
which holds the node and its address) and Caddy's certificates.

The Drive backups are the everyday backup. For a copy of the database file itself, stop the app
for a moment so no write is under way:

```sh
docker compose stop app
docker compose cp app:/data/budgee.sqlite ./budgee-copy.sqlite
docker compose start app
```

To restore such a copy, or to move to another machine, copy the file back into the volume while
the app is stopped. The copy runs inside the container, so the file belongs to its `bun` user:

```sh
docker compose stop app
docker compose run --rm --no-deps -v "$PWD:/restore:ro" app cp /restore/budgee-copy.sqlite /data/budgee.sqlite
docker compose up -d
```

(In PowerShell, write `${PWD}` instead of `$PWD`.) Device tokens, sync positions and the Drive
connection come along as long as `CONFIG_KEY` stays the same. With a domain, point it at the new
machine and devices notice nothing. A `ts.net` address belongs to the Tailscale node: to keep it,
move the `ts-state` volume too (or remove the old machine in the admin console and reuse the same
`TS_HOSTNAME`).

## 10. Lost devices

**Revoke a lost or retired device** from another one: **Settings → Sync and devices**, the
device, **Revoke**. Besides shutting it out, this matters for cleanup: deleted entries are kept on
the server (as small markers) until every device that is not revoked has synced past them, so a
lost device that is never revoked keeps every deletion on the server for good. Revoking also
cancels any pairing code not used yet.

The server never revokes the last device that is not revoked: setup only works on a server
without devices, so nobody could get back in. Pair another device first.

**Lost every device?** The old server can't be set up again, but your data comes back from a
Drive backup with the recovery key:

1. Give the server a fresh, empty database. Stop it and move the old file aside, keeping it until
   the restore below has worked:

   ```sh
   docker compose stop app
   docker compose run --rm --no-deps app mv /data/budgee.sqlite /data/budgee-old.sqlite
   docker compose up -d
   ```

   The server creates a new database on start.
2. On a new device, open the app: **Settings → Sync and devices → Restore with recovery key**.
   Let it in with **Setup secret**, and type the setup secret and your recovery key. The device
   sets up the fresh server with your old key, so your backups stay readable.
3. Download the latest backup from the `budgee-backups` folder in Google Drive, then **Settings →
   Backups → Restore…**, choose the file, check the preview and restore. The device then syncs
   it to the server.
4. **Settings → Backups → Connect Google Drive** again (the Drive connection lived in the old
   database), and pair your other devices from **Add device with QR code**.

Without the recovery key, nobody can read the backups.

## 11. Without the app

A backup file from Drive turns into a plain CSV of your entries with the recovery key. From a
checkout with [Bun](https://bun.sh) installed and `bun install` done:

```sh
bun run decrypt-backup budgee-2026-11-23.jsonl.gz --key-stdin --out entries.csv
```

Then type or paste the recovery key, press Enter, and press Ctrl+D (on Windows, Ctrl+Z then
Enter). The key can also come from the `BUDGEE_RECOVERY_KEY` environment variable, or from
`--key <key>`, which is shortest but leaves the key in your shell history.

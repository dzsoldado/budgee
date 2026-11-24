# Budgee

A personal budgee tracker: an offline-first PWA for expenses and income, synced end-to-end
encrypted between your devices through a small server you own (Bun and SQLite), with daily
encrypted backups to your Google Drive. The server only ever stores encrypted rows.

- What it does and how: [`Budgee Tracker Technical Spec.md`](Budgee%20Tracker%20Technical%20Spec.md)
- Deploying it: [`DEPLOY.md`](DEPLOY.md)

## Run it with Docker

Prerequisite: Docker with Compose (Docker Desktop on Windows or macOS).

```sh
cp .env.example .env            # set SETUP_SECRET at least; see the comments in the file
docker compose up -d            # the app at http://127.0.0.1:8787, data in the budgee-data volume
```

For HTTPS from your other devices, add a front end: Tailscale Funnel (a public `*.ts.net` address,
no domain needed), Tailscale serve (your tailnet only) or Caddy with your own domain. Set
`COMPOSE_PROFILES=tailscale` or `caddy` in `.env`; the steps are in [`DEPLOY.md`](DEPLOY.md).
Update with `git pull`, then `docker compose up -d --build`.

## Develop

Prerequisite: [Bun](https://bun.sh) 1.4 or later.

```sh
bun install
cp .env.example .env.local      # fill in SETUP_SECRET at least; see the comments in the file
bun run dev --port 5174         # API on :8787 (PORT) and Vite with /api proxied to it
```

| Command | What it does |
| --- | --- |
| `bun test` | All unit and integration tests |
| `bun run lint` | Biome check (lint and format) |
| `bun run typecheck` | TypeScript for every package |
| `bun run build` | The PWA into `apps/web/dist` |

Env files: copy `.env.example` to `.env.local` for development and to `.env` for a deploy. Both
are git-ignored; never commit them.

## Devices

- **Lost a device?** Revoke it from another one (Settings → Sync and devices). A device that is
  never revoked keeps every deleted entry's marker on the server for good. The last device can't
  be revoked: pair another one first.
- **Lost every device?** Your data comes back from a Drive backup with the recovery key, on a
  fresh server database: see "Lost devices" in [`DEPLOY.md`](DEPLOY.md#10-lost-devices).

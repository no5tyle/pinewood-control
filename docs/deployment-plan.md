# Deployment plan: one server, automatic deploys, a new domain

This plans how Pinewood Control moves from a hand-run setup to:

- one `docker compose` stack on the VPS (web server, backend and database together, on one address);
- GitHub Actions that check every change and deploy `main` automatically, with a health check and an easy rollback;
- a new domain, with the old one redirecting so printed QR codes and bookmarks keep working.

Nothing here is built yet. `NEW_DOMAIN` stands for the domain you choose (for example `pinewood.<your-domain>`); `OLD_DOMAIN` is `pinewood.nostyle.app`.

## 1. Where it stands

From the repository:

| Part | Now |
| --- | --- |
| Backend | `backend/Dockerfile` (Node 20, runs TypeScript with `tsx`), Express + Socket.IO on port 8787, Postgres through `DATABASE_URL`. Started by hand with `docker run`. |
| Database changes | `npm run db:push` (`prisma db push`), run by hand. No migration history, so a change that drops or renames a column can lose data without warning. |
| Frontend | A static Vite build. `public/_redirects` is Netlify's format, so it's likely on Netlify or similar, talking to the API on another address through `VITE_API_ORIGIN` and `CORS_ORIGIN`. |
| Domain | `frontend/src/shared/qr.ts` hard-codes `pinewood.nostyle.app` (and `nostyle.app`) as the address QR codes point to. |
| Checks | No CI. `npm run lint` and `npm run build` pass after the redesign. There are no tests. |
| Clutter | `backend/prisma/dev.db` (a SQLite file) is committed, although the app uses Postgres. `frontend/src/appConfig.json` has a LAN address and a personal support email. |

## 2. Where it ends up

```
                 NEW_DOMAIN (and OLD_DOMAIN → 301 to NEW_DOMAIN)
                                   │ 443
                    ┌──────────────▼──────────────┐
                    │ web: Caddy                   │  HTTPS certificates, automatic
                    │  /            → built frontend (SPA fallback to index.html)
                    │  /api/*       → backend:8787 │
                    │  /socket.io/* → backend:8787 │  (WebSockets pass straight through)
                    └──────────────┬──────────────┘
                    ┌──────────────▼──────────────┐
                    │ backend: Node                │  runs migrations, then starts
                    └──────────────┬──────────────┘
                    ┌──────────────▼──────────────┐
                    │ db: Postgres 16 (volume)     │  nightly backup
                    └─────────────────────────────┘
```

The frontend and API share one address, so:

- `CORS_ORIGIN` and `VITE_API_ORIGIN` are no longer needed (leave them supported for local development);
- the QR address is just the page's own address;
- one server holds everything, and Netlify (if used) can be retired.

## 3. Changes in the repository

Each step is a small, separate commit. Steps 3.1 to 3.5 change nothing in production until the stack is switched over in section 5.

### 3.1 Tidy up

- Remove `backend/prisma/dev.db` and ignore `*.db`.
- Move the support link out of `appConfig.json` into a build setting (`VITE_SUPPORT_URL`, `VITE_SUPPORT_LABEL`), so no personal address sits in the public repo.
- `qr.ts`: use `VITE_QR_PREFIX` if set, otherwise `window.location.origin`. Drop the hard-coded `nostyle.app` names. Keep the LAN address from `appConfig.json` for phones testing against a laptop.

### 3.2 Migrations instead of `db push`

1. Create the first migration from the current schema: `npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script > prisma/migrations/0_init/migration.sql`.
2. On the live database, mark it as already applied, once: `npx prisma migrate resolve --applied 0_init`.
3. From then on, schema changes are made with `prisma migrate dev`, committed, and applied on deploy with `prisma migrate deploy`. It never drops data unless a migration says so, and that shows up in review.

### 3.3 Backend image

- Node 22. Node 20's support ended in April 2026, so the current image gets no security fixes.
- Build stage: `npm ci`, `prisma generate`, `tsc` to `dist/`. Run stage: production dependencies and `dist/` only, started with `node dist/server.js` rather than `tsx`.
- Start command: `npx prisma migrate deploy && node dist/server.js`.
- `HEALTHCHECK` on `/api/health`.
- Run as the `node` user, not root.

### 3.4 Web image (frontend + Caddy)

`frontend/Dockerfile`, two stages: build the Vite app, then copy `dist/` into `caddy:2-alpine` with this `Caddyfile`:

```caddyfile
{$DOMAIN} {
	encode zstd gzip
	handle /api/* {
		reverse_proxy backend:8787
	}
	handle /socket.io/* {
		reverse_proxy backend:8787
	}
	handle {
		root * /srv
		try_files {path} /index.html
		file_server
	}
	header /assets/* Cache-Control "public, max-age=31536000, immutable"
}

# The old address keeps working: every path redirects to the same path on the new one
{$OLD_DOMAIN} {
	redir https://{$DOMAIN}{uri} permanent
}
```

Caddy refuses an empty site address, so the `{$OLD_DOMAIN}` block goes in at the switch (5.2), not before. Until then it stays commented out. `public/_redirects` can go once Netlify is retired.

### 3.5 `deploy/docker-compose.yml`

```yaml
services:
  web:
    image: ghcr.io/no5tyle/pinewood-web:${TAG:-latest}
    ports: ["80:80", "443:443", "443:443/udp"]
    environment: { DOMAIN: "${DOMAIN}", OLD_DOMAIN: "${OLD_DOMAIN}" }
    volumes: [caddy-data:/data, caddy-config:/config]
    depends_on: [backend]
    restart: unless-stopped
  backend:
    image: ghcr.io/no5tyle/pinewood-backend:${TAG:-latest}
    environment:
      DATABASE_URL: postgresql://pinewood:${POSTGRES_PASSWORD}@db:5432/pinewood?schema=public
      JWT_SECRET: ${JWT_SECRET}
      NODE_ENV: production
    depends_on: { db: { condition: service_healthy } }
    restart: unless-stopped
  db:
    image: postgres:16-alpine
    environment: { POSTGRES_USER: pinewood, POSTGRES_PASSWORD: "${POSTGRES_PASSWORD}", POSTGRES_DB: pinewood }
    volumes: [db-data:/var/lib/postgresql/data]
    healthcheck: { test: ["CMD", "pg_isready", "-U", "pinewood"], interval: 5s, retries: 10 }
    restart: unless-stopped
volumes: { caddy-data: {}, caddy-config: {}, db-data: {} }
```

The secrets go in `/opt/pinewood/.env` on the server, never in the repo: `DOMAIN`, `OLD_DOMAIN`, `POSTGRES_PASSWORD`, `JWT_SECRET` (keep today's value, or everyone is signed out) and `TAG`. Only the web container is reachable from outside.

## 4. GitHub Actions

### 4.1 `ci.yml`: every push and pull request

- **Frontend:** `npm ci`, `npm run lint`, `npm run build`.
- **Backend:** `npm ci`, `tsc --noEmit`, `prisma validate`, and `prisma migrate deploy` against a throwaway Postgres service container, to prove the migrations apply cleanly.
- **Images:** build both Docker images (no push), so a broken Dockerfile is caught before `main`.
- **Later:** a few Playwright page tests that walk through one race night (sign up, pair, add racers, run heats, see results), like the walkthrough used to check the redesign.

### 4.2 `deploy.yml`: on every push to `main`, after CI passes

1. **Build and push** both images to GitHub's container registry: `ghcr.io/no5tyle/pinewood-web` and `pinewood-backend`, tagged with the commit SHA and `latest`. `GITHUB_TOKEN` with `packages: write` is all it needs. Making the packages public means the server needs no registry login.
2. **Back up, then deploy.** Over SSH, as a `deploy` user that may only run Docker:
   ```sh
   cd /opt/pinewood
   docker compose exec -T db pg_dump -U pinewood pinewood | gzip > backups/pre-$TAG.sql.gz
   TAG=$TAG docker compose pull
   TAG=$TAG docker compose up -d
   ```
3. **Check it worked:** `curl --fail --retry 10 https://NEW_DOMAIN/api/health`. If that fails, the workflow goes red and you get GitHub's failure email.
4. **Rollback:** the workflow also runs by hand (`workflow_dispatch`) with a `tag` input. Running it with an earlier commit's SHA puts that version back. A migration can't be undone this way, so keep migrations additive (add columns and tables, remove them in a later release).

The workflow uses a GitHub **environment** called `production`, which holds the secrets: `SSH_HOST`, `SSH_USER`, `SSH_KEY` (a key made only for this) and `SSH_KNOWN_HOSTS`. You can also require a click to approve each deploy there if you'd rather not deploy every merge.

**Why SSH rather than the server pulling updates itself (Watchtower):** I suggested Watchtower earlier, but for this app the push model is better. The deploy and its health check show up in GitHub, failures email you, there's a backup before each deploy, and rolling back is one click. Watchtower needs no SSH key, but it updates silently, runs migrations at whatever minute it notices a new image (possibly mid-race), and as far as I know the original containrrr project has been archived (check before relying on it, or use a maintained fork). If you'd still rather not have an SSH key in GitHub, a self-hosted GitHub Actions runner on the VPS is the middle ground. It connects out to GitHub, so nothing new is opened on the server.

**Race nights:** a deploy restarts the backend for a few seconds, and kiosks and operators reconnect through Socket.IO. To be safe, the workflow can check an "event in progress" flag (or you can pause the environment) so nothing deploys during a race.

### 4.3 Backups

- **Nightly:** a host cron job (or a small `prodrigestivill/postgres-backup-local` container) dumps the database to `/opt/pinewood/backups`, keeping 14 days, and copies it off the server (to object storage or another machine).
- **Before each deploy:** the dump in 4.2.
- **Test a restore** once, so the backups are known to work.

## 5. Moving to the new domain

### 5.1 Before the switch (a few days ahead)

1. **Pick the domain** and add DNS `A` (and `AAAA` if the VPS has IPv6) records for `NEW_DOMAIN` pointing at the VPS, with a short TTL (300 seconds). Lower `OLD_DOMAIN`'s TTL too.
2. **Prepare the VPS:**
   - install Docker;
   - create the `deploy` user and key;
   - open only ports 22, 80 and 443;
   - put `docker-compose.yml` and `.env` in `/opt/pinewood`.
3. **Database:**
   - If Postgres already runs on the VPS: `pg_dump` it and restore it into the new `db` container, or leave it where it is and point `DATABASE_URL` at it.
   - Either way, run the one-off `prisma migrate resolve --applied 0_init` from 3.2.
4. **Bring the stack up on `NEW_DOMAIN` only** and test it end to end with a real kiosk and phone. `OLD_DOMAIN` still points at the current setup.

### 5.2 The switch (between events)

1. Take a final `pg_dump` of the current database, and restore it if the database is moving.
2. Point `OLD_DOMAIN`'s DNS at the VPS, add it to `.env`, uncomment its block in the Caddyfile and redeploy. Caddy gets its certificate and starts redirecting.
3. Check:
   - `https://OLD_DOMAIN/kiosk/…` redirects to the same path on `NEW_DOMAIN`;
   - pairing by QR code works;
   - Socket.IO connects;
   - guest kiosk links work.
4. Update the links: the homepage card (no5tyle.github.io), the README's "Live app", and anywhere else the old address is shared.

### 5.3 What people will notice

- **Signed out once:** logins are saved in the browser per address, so everyone signs in again on `NEW_DOMAIN`. Their events and patrols are safe on the server.
- **Guest events** on a device were kept in that browser for the old address. They're temporary (24 hours) anyway, but finish any running guest event before the switch.
- **Kiosk sessions** pair again once.
- **Printed QR codes and shared links** keep working through the redirect. Keep `OLD_DOMAIN` redirecting for at least a year.

### 5.4 After

- Retire the Netlify site (if used) and the old hand-run containers.
- Once it's been stable for a few weeks, add HSTS in the Caddyfile.

## 6. Order of work

| # | Step | Size |
| --- | --- | --- |
| 1 | Tidy up (3.1) | small |
| 2 | Migrations (3.2), with the one-off command on the live database | small, careful |
| 3 | Backend and web images, Caddyfile, compose file (3.3–3.5) | medium |
| 4 | `ci.yml` (4.1) | small |
| 5 | VPS prepared, stack running on `NEW_DOMAIN` alongside the old setup (5.1) | medium |
| 6 | `deploy.yml` with backup, health check and rollback (4.2), plus nightly backups (4.3) | medium |
| 7 | Switch (5.2), then tidy up (5.4) | small, between events |

Steps 1 to 4 can be done in the repo without touching the server.

## 7. What's needed from you

- The new domain name, and access to its DNS.
- How it runs today:
  - Is the frontend on Netlify?
  - Is Postgres on the VPS (in Docker or installed directly), or hosted elsewhere?
  - What reverse proxy, if any, is in front?
- The VPS's operating system, and whether something else on it already uses ports 80 and 443 (if so, Caddy goes behind it, or replaces it).
- The current `JWT_SECRET`, kept on the server. Keeping it means the switch signs nobody out, apart from the change of address.
- Whether to deploy every merge automatically, or approve each deploy in GitHub.

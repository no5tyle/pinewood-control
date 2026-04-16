# Pinewood Control

Pinewood Control is a web app for running a Pinewood Derby style race with a **Kiosk display** and an **Operator/Controller** device. It uses **ladderless elimination** (1st=0 points, 2nd=1 point, etc.) and supports:

- Live updating results via Socket.IO
- Mid-event late entrants (with a points penalty) and racer drop-outs (recorded in history)
- Anonymous “Popular Vote” with a controller-triggered reveal + kiosk countdown
- Signed-in accounts with reusable **Race Patrols** (racer groups) for faster event setup

Live app: https://pinewood.nostyle.app

## How it’s used

- **Kiosk device** (big screen): open the Kiosk page for the event and display standings/results.
- **Operator device** (phone/tablet/laptop): pair to the kiosk using QR + code, then run heats and submit full finish order each race.
- **Guests** can run events locally (guest mode). Signed-in accounts support multi-device access and Race Patrols.

## Tech stack

**Frontend**
- React 19 + TypeScript
- React Router 7
- Vite 8
- Socket.IO client
- QR tools: `qrcode`, `html5-qrcode`

**Backend**
- Node.js (run via `tsx`)
- Express 5
- Prisma ORM
- Socket.IO
- Postgres (via `DATABASE_URL`)
- Zod validation
- `bcrypt` + `jsonwebtoken` for auth

## Local development

### 1) Backend

Prereqs:
- Node.js 20+
- Postgres

Environment variables:
- `DATABASE_URL` (required): Postgres connection string
- `JWT_SECRET` (recommended): signing key for auth JWTs
- `CORS_ORIGIN` (optional): comma-separated list of allowed origins (trailing slashes are stripped). If empty, all origins are allowed.
- `PORT` (optional): defaults to `8787`

Run:

```bash
cd backend
npm install
npm run db:push
npm run dev
```

The API will be available on `http://localhost:8787`.

### 2) Frontend

Environment variables (Vite):
- `VITE_API_ORIGIN` (recommended for local dev): e.g. `http://localhost:8787`
- `VITE_QR_PREFIX` (optional): force QR links to use a specific public base URL
  - See `frontend/.env.example`

Run:

```bash
cd frontend
npm install
# for local dev, create .env with:
# VITE_API_ORIGIN=http://localhost:8787
npm run dev
```

## Deployment

This repo is split into two deployable apps:

- `backend/`: API + Socket.IO server
- `frontend/`: static web app (Vite build output)

### Backend deployment (Docker)

The backend includes a Dockerfile at `backend/Dockerfile`.

Build and run:

```bash
cd backend
docker build -t pinewood-backend .
docker run --rm -p 8787:8787 \
  -e DATABASE_URL='postgresql://USER:PASSWORD@HOST:5432/DB?schema=public' \
  -e JWT_SECRET='change-me' \
  -e CORS_ORIGIN='https://your-frontend-domain.example' \
  pinewood-backend
```

Database schema:

```bash
cd backend
npm install
npm run db:push
```

Notes:
- Run `npm run db:push` any time the Prisma schema changes (it uses `prisma db push`).
- `CORS_ORIGIN` should match your frontend origin(s). It can be a comma-separated list.

### Frontend deployment (static hosting)

The frontend is a static build output (`dist/`). For Netlify or similar:

- Build command: `npm run build`
- Publish directory: `dist`

Environment variables:
- `VITE_API_ORIGIN`: set to your backend origin (e.g. `https://api.yourdomain.example`)
- `VITE_QR_PREFIX` (optional): if you want QR codes to always use a specific public domain

### Reverse proxy / SSL

Put the backend behind your reverse proxy of choice (Caddy/Nginx/Traefik) and serve the frontend from static hosting. Ensure:

- HTTPS end-to-end
- WebSocket support for Socket.IO
- `CORS_ORIGIN` on the backend matches the frontend domain(s)

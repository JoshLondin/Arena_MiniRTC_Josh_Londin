# MiniRTC

MiniRTC is a 1:1 WebRTC calling product built for the Arena home assignment. Users create or join a room by URL, then start or join an audio-required call with optional video, mute/camera controls, presence, reconnect windows, and WebSocket signaling.

## What Was Built

- FastAPI backend with Postgres-backed room and participant state.
- WebSocket signaling for room-state broadcasts, presence, call lifecycle, SDP,
  and ICE candidates.
- Peer-to-peer WebRTC media in the browser.
- Two reserved participant slots per room, including disconnected participants inside reconnect windows.
- Distinct signaling connection status and WebRTC media status in the UI.
- Start Call / Join Call behavior based on live room state.
- Mute and camera controls.
- Distinct leave-call and leave-room behavior, including a final-participant
  room-close confirmation.
- Opaque participant and host tokens stored hashed in Postgres.
- STUN/TURN config fetched from an authenticated backend endpoint.
- React/Vite frontend with room creation, URL joining, call controls, media status, and reconnect-aware UI.
- Alembic migration and focused backend unit tests.

## What Was Skipped

- Full account creation/login/JWT auth.
- Waitlists.
- Persistent call history.
- Screen sharing.
- Multi-party calls, SFU, or MCU media routing.
- Redis and multi-instance WebSocket fanout.
- Production deployment is not yet completed in this repo.

## Implementation Blueprint

[`minirtc_implementation_blueprint_codex.md`](https://github.com/JoshLondin/Arena_MiniRTC_Josh_Londin/blob/main/minirtc_implementation_blueprint_codex.md) is the markdown implementation plan
created before the build. It was written to give Codex the necessary product
requirements, component breakdown, technologies, API schemas, WebSocket message
contracts, WebRTC flow, backend data model, testing expectations, and delivery
notes needed to implement MiniRTC.

## Run Locally With Docker

Prerequisites: Docker with Docker Compose.

```bash
docker compose up --build
```

Then open:

- Frontend: http://localhost:5173
- Backend health: http://localhost:8000/health

The backend container runs Alembic migrations before starting Uvicorn.

## Run Locally Without Docker

Prerequisites: Python 3.12, Node 22 or another modern Node version compatible
with Vite 7, and Postgres.

Start Postgres locally and create a `minirtc` database. The checked-in defaults expect:

- Host: `localhost`
- Port: `5432`
- User: `postgres`
- Password: `postgres`
- Database: `minirtc`

Then start the backend:

```bash
cd backend
PYTHON_BIN=$(command -v python3.12 || command -v python3.13 || command -v python3.14 || command -v python3)
$PYTHON_BIN -c 'import sys; assert sys.version_info >= (3, 12), "Python 3.12+ required"'
$PYTHON_BIN -m venv .venv
source .venv/bin/activate
python -m pip install -e ".[dev]"
python -m alembic upgrade head
python -m uvicorn app.main:app --reload --reload-dir app --host 0.0.0.0 --port 8000
```

In another terminal, start the frontend:

```bash
cd frontend
npm ci
npm run dev
```

The backend reads environment variables from `backend/.env` when present, but
the values shown below match the local defaults.

## Environment

Backend:

```env
DATABASE_URL=postgresql+asyncpg://postgres:postgres@localhost:5432/minirtc
STUN_SERVER_URL=stun:stun.l.google.com:19302
TURN_SERVER_URL=
TURN_USERNAME=
TURN_PASSWORD=
CORS_ALLOWED_ORIGINS=http://localhost:5173
ROOM_CODE_LENGTH=12
TOKEN_HASH_SECRET=change-me-for-local-development
```

Frontend:

```env
VITE_API_BASE_URL=http://localhost:8000
VITE_WS_BASE_URL=ws://localhost:8000
```

Do not put TURN credentials in frontend environment variables. The frontend fetches ICE servers from the backend after participant-token validation.

## Test And Quality Commands

Backend:

```bash
cd backend
ruff check .
python3 -m pytest
```

Frontend:

```bash
cd frontend
npm run typecheck
npm run build
```

`npm run build` already runs `tsc --noEmit` before the Vite build, so
`npm run typecheck` is useful as a faster standalone check.

## Manual Verification

1. Open browser tab A and create a room as Alice.
2. Confirm the room connection status becomes connected and the participants list shows Alice.
3. Copy the room URL.
4. Open browser tab B, an incognito window, or another browser and join as Bob.
5. Confirm both browsers show Alice and Bob without refresh.
6. Confirm Start Call is hidden with one participant and visible once two active participants are present.
7. Start a call from Alice and confirm Bob sees Join Call.
8. Join the call from Bob.
9. Verify each user sees their own local video and the other user's remote video.
10. Toggle mute and camera. Camera-off should stop camera capture until it is turned back on.
11. Refresh one tab and verify reconnect behavior.
12. Try a third joiner and verify `ROOM_FULL`.
13. Leave only the call and verify both users remain in the room.
14. Leave the room as the final participant and verify the close-room prompt.

## Browser And Network Notes

- Microphone access requires `localhost` or HTTPS.
- Deployed WebRTC requires HTTPS for the frontend and WSS for signaling.
- Browser WebSocket auth is sent through query parameters in this assignment
  build because browser WebSockets cannot set arbitrary auth headers.
- Calls can fail across restrictive networks if TURN is not configured.
- Local STUN-only testing usually works on friendly networks, but production needs TURN with short-lived credentials.

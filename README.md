# MiniRTC

MiniRTC is a 1:1 WebRTC calling product built for the Arena home assignment. Users create or join a room by URL, then start or join an audio-required call with optional video, mute/camera controls, presence, reconnect windows, and WebSocket signaling.

## What Was Built

- FastAPI backend with Postgres-backed room and participant state.
- WebSocket signaling for presence, call lifecycle, SDP, and ICE candidates.
- Peer-to-peer WebRTC media in the browser.
- Two reserved participant slots per room, including disconnected participants inside reconnect windows.
- Distinct leave-call and leave-room behavior.
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

## Run Locally With Docker

```bash
docker compose up --build
```

Then open:

- Frontend: http://localhost:5173
- Backend health: http://localhost:8000/health

The backend container runs Alembic migrations before starting Uvicorn.

## Run Locally Without Docker

Start Postgres locally and create a `minirtc` database, then:

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
alembic upgrade head
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

In another terminal:

```bash
cd frontend
npm install
npm run dev
```

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
pytest
```

Frontend:

```bash
cd frontend
npm run typecheck
npm run build
```

## Manual Verification

1. Open browser tab A and create a room as Alice.
2. Copy the room URL.
3. Open browser tab B or another browser and join as Bob.
4. Start a call from Alice.
5. Join the call from Bob.
6. Verify audio/video connection.
7. Toggle mute and camera.
8. Refresh one tab and verify reconnect behavior.
9. Try a third joiner and verify `ROOM_FULL`.
10. Leave only the call and verify both users remain in the room.
11. Leave the room as the final participant and verify the close-room prompt.

## Browser And Network Notes

- Microphone access requires `localhost` or HTTPS.
- Deployed WebRTC requires HTTPS for the frontend and WSS for signaling.
- Calls can fail across restrictive networks if TURN is not configured.
- Local STUN-only testing usually works on friendly networks, but production needs TURN.


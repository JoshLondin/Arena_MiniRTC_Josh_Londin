# MiniRTC Decisions

This document explains the main architecture decisions behind MiniRTC, the
technologies used to build it, and how the design would need to evolve beyond
the take-home assignment scale.

## Decisions and Tradeoffs

### Frontend

#### <u>React SPA With Hook-Owned Realtime Boundaries</u>

**Decision:** MiniRTC is a Vite-powered React single-page app. The main room
flow is coordinated in `App.tsx`, while side effects are split into hooks:
`useRoom` for REST room actions, `useWebSocket` for signaling transport,
`useMediaDevices` for browser media permissions, and `useWebRTC` for peer
connection lifecycle.

**Why:** The product is small, user-driven, and very stateful. Keeping the UI in
one browser app avoids routing complexity and makes it easy to coordinate room
state, socket state, media state, and call controls in one place.

**Tradeoff:** This keeps the implementation lean, but it also means the app is
careful hand-rolled state management rather than a formal state machine. A
larger product could move the room/call lifecycle into XState, Redux Toolkit, or
another explicit state model to make every transition easier to test and audit.

#### <u>Room State Is Authoritative, UI Deltas Are Optimistic</u>

**Decision:** The frontend treats `room-state` messages as the canonical source
for participants, call status, reserved participant count, and call host. Smaller
events such as `participant-joined`, `participant-left`, and
`participant-disconnected` update the UI immediately, then the next `room-state`
reconciles the client with the backend.

**Why:** The original bugs came from the browser relying on stale local state.
The room UI needs to update without refresh, especially for participant lists,
room-full behavior, leave confirmation, and Start Call / Join Call visibility.

**Tradeoff:** This gives the user responsive UI while preserving a backend
source of truth. The tradeoff is more reducer complexity and more discipline
around WebSocket lifecycle. If the socket reconnects or misses an event, the app
must always be able to repair itself from the next full room snapshot.

#### <u>Signaling Status And Media Status Are Separate</u>

**Decision:** The top room status represents WebSocket/signaling connectivity
only: connecting, connected, reconnecting, or failed. WebRTC/media state is
tracked separately as idle, preparing, connecting, connected, or failed.

**Why:** A room can be connected even if a peer connection is not active yet.
Separating these states prevents media cleanup, ICE failures, or call end events
from incorrectly making the whole room look disconnected.

**Tradeoff:** The UI has two related state machines instead of one combined
status. That is slightly more state to reason about, but it prevents misleading
states such as a connected room showing as idle or reconnecting because the call
media changed.

#### <u>Peer-To-Peer WebRTC For 1:1 Calls</u>

**Decision:** Browser WebRTC carries audio and video directly between the two
participants. The backend only coordinates room membership, presence, SDP offer
/ answer exchange, and ICE candidate forwarding.

**Why:** The assignment is explicitly a 1:1 MiniRTC product. For a two-person
call, peer-to-peer media is the simplest and lowest-cost design because backend
servers do not relay media bytes.

**Tradeoff:** Peer-to-peer WebRTC depends on the network path between browsers.
Some NATs, firewalls, and corporate networks require TURN relay, and a future
multi-party product would likely need an SFU. A peer-to-peer architecture also
puts browser negotiation details, device permissions, and track replacement
behavior directly into the client.

#### <u>Deterministic Call Host Creates Offers</u>

**Decision:** The participant who starts the call becomes the call host, and the
call host is the only peer that creates the SDP offer after the other participant
joins. The joining participant prepares media, creates a peer connection, and
waits for the offer.

**Why:** This removes offer glare for the current 1:1 flow. The previous approach
could leave both peers waiting or negotiating inconsistently, especially when
state updates arrived in different orders.

**Tradeoff:** This works well for the assignment flow, but it is less flexible
than the full WebRTC perfect negotiation pattern. A production app with screen
sharing, mid-call track changes, reconnect negotiation, or either peer adding
media at any time should adopt polite/impolite peer negotiation.

#### <u>Session-Scoped Room Credentials</u>

**Decision:** The frontend stores room credentials in `sessionStorage`. That
allows a browser refresh to reconnect to the same room without persisting tokens
after the tab session ends.

**Why:** The app has no account system, so a refresh-safe room session needs a
small local credential store. `sessionStorage` is a narrower persistence choice
than `localStorage`.

**Tradeoff:** This is convenient for the take-home build but not a complete
security model. Production should use short-lived signed room sessions,
one-time WebSocket tokens, explicit logout/revocation, and account-backed
membership if rooms need stronger identity.

#### <u>Camera Off Stops Capture</u>

**Decision:** Turning the camera off calls `replaceTrack(null)`, removes the
video track from the local stream, and stops the original camera track. Turning
the camera back on requests a fresh video track and replaces or adds it on the
peer connection.

**Why:** Users expect "camera off" to stop camera capture, not just hide the
local preview. This also turns off the physical camera indicator on supported
devices.

**Tradeoff:** Restarting the camera requires a new `getUserMedia` call and can
fail if permissions or devices change. Keeping a disabled track would be simpler
and faster, but it would keep the camera active.

#### <u>Participant Media Indicators Over Signaling</u>

**Decision:** The video panel shows speaker and muted speaker icons for the
current participant and broadcasts ephemeral mute/camera state over WebSocket so
the remote tile can show the other participant's current media state after the
local user has joined the call.

**Why:** Users need clear feedback about their own mute and camera state,
especially when camera-off stops the video track and leaves the tile otherwise
empty. Broadcasting this lightweight state also makes the remote participant's
tile feel more truthful once both users are in the call, without adding database
schema or REST response changes.

**Tradeoff:** The broadcast is intentionally live and ephemeral. It repairs on
toggle, media start/join, reconnect, and room-state changes, but it is not
stored as durable room state. A production experience could persist media state,
include it in room-state snapshots, or add richer device/presence events so
refreshes and late joins always receive an authoritative value immediately.

### Backend

#### <u>REST For Room Lifecycle, WebSocket For Signaling</u>

**Decision:** Room creation, join, reconnect, leave, delete, and ICE server
lookup use REST. Presence, call transitions, SDP messages, and ICE candidates
use WebSockets.

**Why:** REST gives clean request/response semantics and HTTP error codes for
transactional actions such as `ROOM_NOT_FOUND` or `ROOM_FULL`. WebSockets are a
better fit once participants are in the room because signaling needs low-latency
bidirectional messaging.

**Tradeoff:** The product has two transport paths and two auth entry points.
Browser WebSockets also cannot attach arbitrary headers, so the local build
passes participant credentials in the query string. In production, the REST API
should mint short-lived one-time WebSocket tokens to reduce token exposure.

#### <u>Postgres Is The Durable Source Of Truth</u>

**Decision:** Postgres stores rooms, participants, host token hashes,
participant token hashes, room status, call status, reconnect deadlines, and
media-connected markers. Backend services use row locks for room capacity and
call transition races.

**Why:** The app needs consistent answers for "is the room full?", "who is still
reserved?", and "who is allowed to start or join the call?" Postgres gives a
durable, transactional source of truth that is easy to inspect locally.

**Tradeoff:** This is robust for the assignment, but Postgres is currently in
the hot path for heartbeats and presence. At larger scale, high-frequency
presence writes should move to Redis or another ephemeral store while Postgres
keeps durable room and audit data.

#### <u>In-Memory Connection Manager For Live Sockets</u>

**Decision:** Active WebSocket objects are stored in an in-memory connection
manager keyed by room and participant. Durable room state remains in Postgres.

**Why:** The local build runs as a single backend process. In-memory fanout keeps
the implementation small and avoids adding Redis before it is needed.

**Tradeoff:** This does not scale across multiple backend workers by itself. A
production deployment needs a shared pub/sub layer, such as Redis Pub/Sub, Redis
Streams, NATS, or a managed realtime bus, so any worker can publish room events
to sockets connected to any other worker.

#### <u>Opaque Room Tokens Instead Of Accounts</u>

**Decision:** MiniRTC does not implement user accounts. It uses cryptographically
random room codes, opaque participant tokens, hashed token storage, and a
separate host token for room deletion.

**Why:** The assignment focuses on realtime communication rather than account
management. Opaque room credentials provide enough minimal access control to
keep room joins, reconnects, and host deletion scoped.

**Tradeoff:** There is no global identity, audit history, abuse prevention,
token rotation UI, or user-level room ownership. Production would need accounts
or signed sessions, rate limits, audit logs, and stronger revocation semantics.

#### <u>Reserved Slots And Reconnect Windows</u>

**Decision:** Disconnected participants keep their room slot for a reconnect
window. Room-only disconnects get a longer timeout than active-call disconnects.
A third participant receives `ROOM_FULL` while a disconnected participant's slot
is still reserved.

**Why:** Refreshes and temporary network drops should not let a third user steal
a two-person room. This is especially important during an active call.

**Tradeoff:** The room can appear full even when one visible participant is
temporarily disconnected. The product needs clear UI copy, cleanup jobs, and
accurate room-state broadcasts so this behavior feels intentional rather than
stale.

#### <u>Explicit Call State In The Backend</u>

**Decision:** The backend tracks call status as `IDLE`, `CALL_PENDING`,
`NEGOTIATING`, and `IN_CALL`, plus the participant who is the call host.

**Why:** The room needs consistent behavior across both browsers. The backend
can enforce that only an active participant starts a call, the second active
participant joins it, and both peers report media connected before the room moves
to `IN_CALL`.

**Tradeoff:** The backend knows about call lifecycle but not about actual media
quality. A peer can report WebRTC connection success, but production would need
client telemetry, ICE failure reporting, and probably server-side analytics for
diagnostics.

#### <u>STUN By Default, TURN Optional By Configuration</u>

**Decision:** The backend exposes an authenticated ICE server endpoint. It
always returns STUN configuration and includes TURN only when TURN settings are
configured. TURN support is implemented in the application, but the take-home
deployment intentionally leaves TURN unconfigured.

**Why:** This keeps the frontend free of hard-coded TURN credentials and makes
local development cheap. The same endpoint can later issue short-lived TURN
credentials. For the take-home, provisioning a real TURN service is not required
to demonstrate the core room, signaling, and 1:1 WebRTC flow; it is an
operational production concern with direct bandwidth cost.

**Tradeoff:** STUN-only WebRTC will fail on restrictive networks. Static TURN
credentials are also not production-grade because they are hard to rotate and
hard to limit per user or room. A production deployment should configure managed
TURN or coturn, preferably with short-lived credentials and usage monitoring.

### Deployment

#### <u>Render Blueprint Plus Manual Verification</u>

**Decision:** MiniRTC uses `render.yaml` as the intended Render Blueprint while
also verifying the actual Render-created services, URLs, and environment values
in the dashboard.

**Why:** The Blueprint makes the deployment reproducible from the repository:
one managed database, one Docker backend web service, and one static frontend
site. Manual verification was still necessary because generated service names,
hostnames, and dashboard-created resources can differ from the intended names.

**Tradeoff:** Infrastructure-as-code is clearer and easier to review, but the
take-home deployment still needed hands-on verification to catch real production
configuration issues, including the backend initially using a localhost
Postgres URL instead of Render's internal database URL.

#### <u>Dockerized Backend, Static Frontend</u>

**Decision:** The FastAPI backend deploys as a Docker web service, while the
Vite frontend deploys as a static site built from production assets.

**Why:** The backend needs Python dependencies, Alembic migrations, Uvicorn,
WebSocket support, runtime environment variables, and Render's dynamic `PORT`.
The frontend only needs an HTML/CSS/JavaScript bundle after `npm run build`, so
serving it as static files is simpler and cheaper than running a Node server.

**Tradeoff:** This cleanly separates API and UI hosting, but it creates two
public origins. The frontend build must know the backend HTTPS and WSS URLs, and
the backend must allow the frontend origin through CORS.

#### <u>Managed Render PostgreSQL</u>

**Decision:** The deployed app uses Render PostgreSQL for room, participant,
call, reconnect, heartbeat, and cleanup state.

**Why:** Production should not store durable room state inside the backend
container. Render PostgreSQL matches the local Postgres architecture and gives
the backend a managed database connection through `DATABASE_URL`.

**Tradeoff:** Managed Postgres reduces operational setup for the take-home, but
the free instance has lifecycle limits and is not a full production database
plan. A production deployment would need paid sizing, backups, retention,
monitoring, and explicit database maintenance policies.

#### <u>Production HTTPS And WSS URLs</u>

**Decision:** The deployed frontend talks to the backend over HTTPS for REST and
WSS for WebSocket signaling.

**Why:** Browser media APIs require secure origins outside localhost, and
production WebSocket signaling should use TLS. Using explicit frontend build
variables keeps local `http://` / `ws://` development separate from deployed
`https://` / `wss://` URLs.

**Tradeoff:** URL configuration becomes part of deployment. If Render generates
different service hostnames, `VITE_API_BASE_URL`, `VITE_WS_BASE_URL`, and
`CORS_ALLOWED_ORIGINS` must be updated and the affected service redeployed.

#### <u>SPA Rewrite For Room Links</u>

**Decision:** The Render static site rewrites `/*` to `/index.html`.

**Why:** Room links such as `/room/{roomCode}` are client-side React routes.
Without the rewrite, opening or refreshing a room link would ask Render for a
physical file at that path and return a 404.

**Tradeoff:** The rewrite is correct for the frontend because the backend lives
on a separate API origin. If the app were deployed behind one shared domain, the
rewrite rules would need to avoid intercepting API and WebSocket paths.

## Technologies

### Frontend

#### <u>React</u>

**What it is:** [React](https://react.dev/) is a UI library for building
interfaces from components and hooks.

**How MiniRTC uses it:** React renders the create/join forms, room page,
participant list, call controls, connection status, warning/error messages, and
video panels. `App.tsx` coordinates the product flow, while components such as
`RoomPage`, `VideoPanel`, `CallControls`, and `JoinRoomForm` stay focused on UI
rendering.

Hooks isolate the parts of the app that talk to the outside world:
`useRoom` wraps REST calls, `useWebSocket` owns the signaling socket,
`useMediaDevices` requests camera/microphone permissions, and `useWebRTC` owns
peer-connection lifecycle. `useReducer` keeps room state transitions in one
place so call events, participant events, socket state, and media state update
predictably.

The room reducer also stores a per-participant media-state map for live
mute/camera indicators. `RoomPage` derives tile display modes from that state:
idle rooms show centered participant names, started calls show waiting copy such
as "Bob has not joined the call" until both users join, and active calls show
video with local and remote media indicators.

#### <u>TypeScript</u>

**What it is:** [TypeScript](https://www.typescriptlang.org/docs/) adds static
types to JavaScript.

**How MiniRTC uses it:** TypeScript defines room credentials, signaling
messages, participant payloads, reducer actions, and browser media/WebRTC
interfaces. This helps keep backend message shapes and frontend UI assumptions
aligned.

The signaling types are especially important because the browser receives many
message kinds over one WebSocket: room snapshots, presence deltas, call state
changes, SDP offers/answers, ICE candidates, and errors. TypeScript makes those
payloads explicit at the frontend boundary, while DOM lib types provide native
types for `MediaStream`, `MediaStreamTrack`, `RTCPeerConnection`,
`RTCIceServer`, and related WebRTC objects.

#### <u>Vite</u>

**What it is:** [Vite](https://vite.dev/guide/) is a frontend development server
and build tool.

**How MiniRTC uses it:** Vite serves the local React app on port 5173, injects
`VITE_API_BASE_URL` and `VITE_WS_BASE_URL`, and builds the production frontend
bundle.

This is useful for the take-home workflow because the frontend can run quickly
against the local FastAPI backend without a full production web server. Vite
also keeps the app's environment-specific URLs outside source code, so Docker
Compose and local development can point the same React code at different HTTP
and WebSocket origins.

#### <u>Browser Fetch API</u>

**What it is:** The browser `fetch` API sends HTTP requests and reads responses.
MDN documents the wider browser Web API surface at
[MDN Web APIs](https://developer.mozilla.org/en-US/docs/Web/API).

**How MiniRTC uses it:** The frontend calls REST endpoints to create, join,
reconnect, leave, and fetch ICE servers. Errors are normalized into user-facing
messages from the backend error envelope.

The small `requestJson` helper centralizes JSON encoding, response parsing, and
error extraction. That keeps room actions simple: `createRoom`, `joinRoom`,
`reconnectRoom`, `leaveRoom`, and `fetchIceServers` each describe one backend
operation and return typed client data. The frontend does not use cookies or
server sessions; participant credentials are sent explicitly in request bodies
for authenticated room operations.

#### <u>Browser WebSocket API</u>

**What it is:** The [WebSocket API](https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API)
opens a persistent two-way connection between the browser and server.

**How MiniRTC uses it:** MiniRTC uses one WebSocket per room participant for
heartbeats, presence events, call events, SDP offers/answers, ICE candidate
forwarding, and ephemeral participant media-state updates. The hook stores
callbacks in refs so normal React re-renders do not tear down a live socket.

The socket URL includes the room code, participant ID, and participant token.
Once open, the client sends heartbeat messages every 10 seconds so the backend
can detect stale tabs. The hook treats close codes for invalid credentials,
missing rooms, and duplicate connections as fatal, while unexpected closes move
the UI into reconnecting state. This separation is what keeps the room status
accurate while participant and media updates continue to flow through React.

For mute and camera indicators, the current participant sends `media-state`
messages whenever local media starts, reconnects, or changes. The backend
validates that the sender can only report their own participant ID and forwards
`participant-media-state` to the other socket. This keeps the remote video tile
accurate during the live session without adding database persistence.

#### <u>WebRTC APIs</u>

**What it is:** The [WebRTC API](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API)
lets browsers create peer-to-peer audio/video connections. The core object here
is `RTCPeerConnection`.

**How MiniRTC uses it:** The app creates one peer connection per call, adds
local audio/video tracks, exchanges SDP offer/answer payloads over the
WebSocket, queues ICE candidates until a remote description exists, and renders
remote tracks into a `MediaStream`.

MiniRTC uses a deterministic offer flow: the participant who started the call is
the call host, and only that host creates the offer after the other participant
joins. The joining participant creates a peer connection and waits for the
offer. `onicecandidate` forwards ICE candidates through the signaling socket,
`ontrack` builds the remote stream for the video panel, and connection-state
callbacks update media status and report `media-connected` to the backend.

#### <u>MediaDevices And getUserMedia</u>

**What it is:** [`getUserMedia`](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)
asks the browser for access to camera and microphone devices.

**How MiniRTC uses it:** Starting or joining a call requests audio and video.
If camera access fails, the app falls back to audio-only. When the user turns
camera back on, the app requests a fresh video track.

The product requires microphone access for a call, but camera access is treated
as optional so a user can still join when the camera is unavailable or denied.
The local media stream is stored in React state for preview rendering and in
refs inside `useWebRTC` for peer connection operations. Media tracks are stopped
on leave, call end, room deletion, reconnect restart, or camera-off behavior so
browser device capture does not continue unnecessarily.

#### <u>RTCRtpSender.replaceTrack</u>

**What it is:** [`RTCRtpSender.replaceTrack`](https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpSender/replaceTrack)
replaces the media track sent by an existing WebRTC sender.

**How MiniRTC uses it:** Camera off replaces the outgoing video track with
`null` and stops the original track. Camera on replaces the sender with a new
camera track without rebuilding the entire peer connection.

This matters because toggling camera should feel like a local control, not a
full call restart. The app stores the current video sender in a ref, removes the
old video track from the local stream, stops it so the camera light turns off,
and later attaches a newly requested video track to the same sender. If there is
no sender yet, the app adds the new track to the existing peer connection.

#### <u>Session Storage</u>

**What it is:** `sessionStorage` is browser storage scoped to the page session.

**How MiniRTC uses it:** The app stores room code, participant ID, participant
token, host token when present, and username so refresh/reconnect works inside
the current browser session.

On page load, the app checks whether stored credentials match the current
`/room/{roomCode}` path. If they do, it calls the reconnect endpoint before
opening the WebSocket. Credentials are cleared on leave, room deletion, invalid
auth, or stale reconnect failure. This keeps the local UX refresh-safe without
persisting room access across browser restarts.

#### <u>CSS</u>

**What it is:** CSS styles the browser UI.

**How MiniRTC uses it:** The app uses plain CSS for layout, responsive room
panels, participant rows, call controls, and video containers. This keeps the
frontend dependency surface small for the assignment.

The styles are tuned around the actual room workflow: a sidebar for share URL,
participants, and notices; a call surface for local and remote video; and stable
controls that appear only when the user can take the action. The video grid can
render as a single local tile before a remote participant joins, then expand to
the two-person layout once the room state includes another participant.

### Backend

#### <u>FastAPI</u>

**What it is:** [FastAPI](https://fastapi.tiangolo.com/) is a Python web
framework for APIs. It also supports
[WebSocket routes](https://fastapi.tiangolo.com/advanced/websockets/).

**How MiniRTC uses it:** FastAPI exposes room REST endpoints under `/rooms` and
WebSocket signaling under `/ws/rooms/{room_code}`. It wires dependencies,
request validation, CORS, error responses, and application startup/shutdown.

The app uses `APIRouter` modules to separate room lifecycle routes from
signaling routes, dependency injection to provide async database sessions, and a
lifespan hook to start/stop cleanup tasks. Custom error handlers turn domain
errors such as `ROOM_FULL`, `ROOM_NOT_FOUND`, and `INVALID_PARTICIPANT` into a
consistent JSON envelope that the frontend can display.

#### <u>Pydantic</u>

**What it is:** [Pydantic](https://pydantic.dev/docs/) validates and serializes
Python data models.

**How MiniRTC uses it:** Backend request and response schemas validate room
creation, join, reconnect, leave, delete, ICE server requests, and WebSocket
message payloads.

Pydantic keeps the API contracts close to the code. REST responses are built
from service result objects with `model_validate(..., from_attributes=True)`,
and WebSocket payloads are validated before dispatching business logic. That
prevents malformed signaling messages from reaching call-state transitions or
being forwarded to the other participant.

#### <u>pydantic-settings</u>

**What it is:** `pydantic-settings` loads typed settings from environment
variables and `.env` files.

**How MiniRTC uses it:** The backend reads database URLs, CORS origins, timeout
values, STUN URLs, optional TURN config, and cleanup intervals from typed
settings.

This keeps deploy-time configuration outside code while still giving the app
typed defaults. Local development can use default values and Docker Compose
environment variables, while production could provide different origins,
database credentials, reconnect windows, heartbeat thresholds, and TURN server
settings.

#### <u>SQLAlchemy Async ORM</u>

**What it is:** [SQLAlchemy asyncio](https://docs.sqlalchemy.org/en/20/orm/extensions/asyncio.html)
provides async database engines, sessions, and ORM access.

**How MiniRTC uses it:** Repository methods read and mutate rooms and
participants using async sessions. Service methods wrap important transitions in
transactions and use `with_for_update()` where race conditions matter.

The repository layer owns the database queries, while `RoomService` owns
business rules. That split keeps data access reusable across REST routes,
WebSocket authentication, signaling dispatch, and cleanup tasks. Async SQLAlchemy
also matches FastAPI's async request model, so room operations and signaling
handlers can await database work without blocking the event loop.

#### <u>PostgreSQL</u>

**What it is:** [PostgreSQL](https://www.postgresql.org/docs/) is a relational
database. Its [explicit locking docs](https://www.postgresql.org/docs/current/explicit-locking.html)
cover row-level locking behavior.

**How MiniRTC uses it:** Postgres stores rooms and participants. Row locks guard
room join capacity, call start, call join, leave, reconnect, and stale
participant cleanup.

The data model intentionally keeps durable room truth in two tables: `rooms` and
`participants`. Room rows track room code, status, call status, host token hash,
and call host participant. Participant rows track username, token hash, active
or disconnected status, heartbeat time, reconnect deadline, disconnect context,
and media-connected time. That schema lets the backend answer capacity and
reconnect questions transactionally.

#### <u>Alembic</u>

**What it is:** [Alembic](https://alembic.sqlalchemy.org/en/latest/) is a
database migration tool built for SQLAlchemy.

**How MiniRTC uses it:** Alembic owns the schema migration that creates the
rooms and participants tables used by the backend.

The migration is part of the reproducible local setup: Docker Compose starts
Postgres, then the backend can run migrations before serving traffic. In a
larger deployment, Alembic would also be where we add indexes for scaling,
schema changes for call history, and future tables for accounts or analytics.

#### <u>Uvicorn</u>

**What it is:** Uvicorn is an ASGI server for Python web applications.

**How MiniRTC uses it:** Docker Compose runs the FastAPI app through Uvicorn so
the backend can serve both HTTP endpoints and WebSocket connections.

ASGI matters here because MiniRTC needs long-lived WebSocket connections and
normal HTTP requests in the same backend. Uvicorn runs the async FastAPI app,
handles the HTTP/WebSocket protocol layer, and lets the service code use async
database sessions and async socket sends.

#### <u>WebSocket Connection Manager</u>

**What it is:** This is a small application-level in-memory registry for active
WebSocket connections.

**How MiniRTC uses it:** The manager maps room codes and participant IDs to
connected sockets, sends events to a single participant, broadcasts room-state
snapshots, and forwards signaling messages to the other participant.

It also closes an older socket when the same participant opens a duplicate
connection, which avoids two tabs with the same credentials receiving conflicting
events. The manager is intentionally not durable: if the backend process exits,
the browser reconnect path and Postgres room state are responsible for recovery.
That is simple locally, but it is also the reason a production version needs
shared pub/sub across workers.

#### <u>STUN, TURN, And ICE Servers</u>

**What it is:** ICE uses STUN and TURN servers to help WebRTC peers find a
working network path. TURN relays media when direct connectivity fails.

**How MiniRTC uses it:** The backend returns ICE server config from
`/rooms/{room_code}/ice-servers`. STUN is always available by config, and TURN
can be added by environment variables. This means the TURN path is implemented
and tested in the app, while the current take-home deployment runs with STUN
only.

The endpoint is authenticated with participant credentials, which keeps ICE
configuration tied to valid room membership. In the local build, static config
is enough. In production, this same endpoint is the natural place to mint
short-lived TURN credentials, choose regional ICE servers, and enforce usage
limits. Leaving TURN blank for the take-home avoids provisioning a paid or
self-hosted relay service while still documenting exactly where it plugs in.

#### <u>Docker Compose</u>

**What it is:** [Docker Compose](https://docs.docker.com/compose/) runs
multi-container applications locally.

**How MiniRTC uses it:** The local stack runs Postgres, the FastAPI backend, and
the Vite frontend with one compose file.

Compose gives reviewers a repeatable end-to-end environment instead of asking
them to install and wire services manually. It also documents the ports and
service boundaries clearly: database on 5432, backend on 8000, and frontend on
5173.

#### <u>pytest</u>

**What it is:** [pytest](https://docs.pytest.org/en/stable/) is a Python test
framework.

**How MiniRTC uses it:** Backend unit tests cover room service behavior,
capacity, reconnect logic, call transitions, and signaling service behavior.

The tests exercise the rules most likely to regress: two-person capacity,
`ROOM_FULL`, reconnect windows, room deletion, participant leave, call start,
join-call behavior, and signaling event handling. That gives confidence in the
backend state machine even when manual browser testing is still needed for real
camera/WebRTC behavior.

#### <u>Ruff</u>

**What it is:** [Ruff](https://docs.astral.sh/ruff/) is a Python linter and
formatter.

**How MiniRTC uses it:** Ruff checks backend style and catches common Python
issues before tests run.

For this project, Ruff is the quick static-quality gate before running the
backend test suite. It helps keep the take-home codebase consistent without
introducing a larger formatting/tooling setup.

### Deployment

#### <u>Render</u>

**What it is:** [Render](https://render.com/docs) is a cloud application
platform for deploying web services, static sites, databases, and background
workers.

**How MiniRTC uses it:** Render hosts the deployed MiniRTC backend, frontend,
and PostgreSQL database. The backend runs as a Docker web service, the frontend
runs as a static site, and Render provides managed HTTPS endpoints for both
services.

Render also stores production environment variables, provides the managed
Postgres connection string, exposes WSS-capable service URLs for WebSocket
signaling, and gives a dashboard for deployment logs and manual verification.

#### <u>Render Blueprint</u>

**What it is:** A [Render Blueprint](https://render.com/docs/blueprint-spec) is
a `render.yaml` file that describes Render infrastructure and service settings
from source control.

**How MiniRTC uses it:** The root `render.yaml` documents the intended
deployment: one Render PostgreSQL database, one Docker backend service, and one
static frontend service. It also declares production environment variables for
database access, token hashing, CORS, STUN/TURN configuration, and frontend API
and WebSocket URLs.

The Blueprint includes the frontend rewrite rule from `/*` to `/index.html` so
shared room links load the React app. In practice, the deployed Render services
still need their actual generated URLs verified before final testing.

#### <u>Render PostgreSQL</u>

**What it is:** [Render PostgreSQL](https://render.com/docs/postgresql-creating-connecting)
is Render's managed PostgreSQL database service.

**How MiniRTC uses it:** The deployed backend stores rooms, participants, call
state, reconnect metadata, heartbeat timestamps, and cleanup state in Render
PostgreSQL. Render provides the database connection through `DATABASE_URL`.

The backend normalizes Render-provided Postgres URLs to
`postgresql+asyncpg://` before SQLAlchemy and Alembic use them. That lets local
development and production share the same async database driver while accepting
Render's generated connection string format.

#### <u>Dockerfile Backend Deployment</u>

**What it is:** A [Dockerfile](https://docs.docker.com/reference/dockerfile/)
defines the container image used to run an application.

**How MiniRTC uses it:** The backend Dockerfile starts from `python:3.12-slim`,
copies the backend package, app code, Alembic migration config, and migration
files into `/app`, then installs the backend with `pip install --no-cache-dir
-e .`.

At runtime, the container runs `alembic upgrade head` before starting Uvicorn.
Uvicorn binds to `0.0.0.0` and uses `${PORT:-8000}` so the same image works
locally and on Render's dynamic web service port.

#### <u>Render Static Site</u>

**What it is:** [Render Static Sites](https://render.com/docs/static-sites)
serve prebuilt frontend assets from a build output directory.

**How MiniRTC uses it:** Render builds the frontend with `cd frontend && npm ci
&& npm run build` and publishes `frontend/dist`. Vite reads
`VITE_API_BASE_URL` and `VITE_WS_BASE_URL` at build time so the deployed React
app calls the correct backend HTTPS and WSS origins.

The static site also owns the SPA rewrite rule. Requests for `/room/{roomCode}`
return `index.html`, allowing the browser app to parse the room code from the
path and reconnect or show the join flow.

#### <u>Production Environment Variables</u>

**What it is:** [Render environment variables](https://render.com/docs/configure-environment-variables)
are service-specific configuration values and secrets provided at build time or
runtime.

**How MiniRTC uses it:** The backend uses `DATABASE_URL`,
`TOKEN_HASH_SECRET`, `CORS_ALLOWED_ORIGINS`, `STUN_SERVER_URL`, and optional
`TURN_SERVER_URL`, `TURN_USERNAME`, and `TURN_PASSWORD`. `DATABASE_URL` points
to Render PostgreSQL, `TOKEN_HASH_SECRET` protects token hashes, CORS allows the
frontend origin, and STUN/TURN settings control the ICE server response.

The frontend uses `VITE_API_BASE_URL` and `VITE_WS_BASE_URL` during the Vite
build. These values are intentionally separate from backend runtime settings
because static assets cannot read new environment values after they are built;
changing them requires a frontend rebuild and redeploy.

## Scaling and Cost

### Scaling

#### <u>What Breaks If You Had 10k Rooms/Day?</u>

The first issue is not room creation itself; it is live connection fanout. The
current in-memory connection manager only works inside one backend process. If
multiple workers are running, Alice could connect to worker A while Bob connects
to worker B, and room broadcasts would not reach both sockets without shared
pub/sub.

Postgres would also become too busy if every participant heartbeat writes to the
database every few seconds. At 10k rooms/day, especially with many active rooms
at once, heartbeat writes, stale participant scans, reconnect updates, and room
cleanup queries would become a major source of load.

TURN bandwidth is another pressure point. Peer-to-peer media is cheap for the
backend, but TURN-relayed media is paid bandwidth. If a meaningful percentage of
calls need relay, TURN can dominate infrastructure cost.

Operationally, the current app also lacks production-grade observability,
rate-limiting, abuse controls, WSS/HTTPS deployment details, message
backpressure handling, and multi-region routing. Those are acceptable omissions
for the take-home build but would be the next things to harden.

The current Render deployment is intentionally sized for review rather than
scale. Free web services can cold start, the free Postgres instance has
lifecycle limits, and the single deployed backend instance still has the same
in-memory WebSocket fanout constraint as local development.

#### <u>How We Would Scale The Product</u>

Run REST and WebSocket workers as stateless services behind a load balancer, but
move live room fanout into a shared messaging layer such as Redis Pub/Sub, Redis
Streams, NATS, or a managed realtime bus. WebSocket workers would subscribe to
room channels for the sockets they currently hold.

Move hot presence data to Redis with TTLs: active socket state, last heartbeat,
short reconnect windows, and pending cleanup markers. Keep Postgres for durable
room records, participant records, token hashes, call state, and audit-friendly
events. The backend can periodically compact Redis presence back into Postgres
where durable history is useful.

Add indexes around room code, participant room ID, participant status, last seen
time, and reconnect deadlines. Replace broad cleanup scans with bounded,
indexed cleanup jobs. Scale WebSocket workers based on connected sockets,
messages per second, CPU, memory, and event loop lag.

Add metrics for room create/join failures, `ROOM_FULL`, reconnect success rate,
WebSocket close codes, call-start-to-IN_CALL time, ICE failure rate, TURN relay
ratio, TURN bandwidth, and cleanup lag. Those metrics would tell us whether the
system is failing because of app logic, network traversal, or infrastructure.
Render logs are useful for the take-home deployment, but production would need
structured logs, metrics, alerting, and dashboards outside the basic deploy log
view.

### Cost

#### <u>How You'd Keep Costs Sane</u>

Keep media peer-to-peer by default. The backend should never carry audio/video
unless the product intentionally moves to an [SFU](https://medium.com/@jamesbordane57/webrtc-sfu-the-complete-guide-3589be4daa54). Signaling messages are tiny,
so the main app servers should scale mostly with connections and small JSON
events rather than media bandwidth.

Use TURN only when needed. Issue short-lived TURN credentials, monitor relay
ratio, set bandwidth quotas, choose regions carefully, and alert on unusual
relay usage. TURN should be treated as a metered fallback path, not the default
media route.

Reduce database write volume by moving heartbeat/presence to Redis TTLs and
writing durable state only on meaningful transitions: create, join, leave,
disconnect, reconnect, call start, call join, call end, and room cleanup.

Expire unused rooms aggressively. Keep room TTLs short, clean stale disconnected
participants, delete empty rooms, and avoid storing media. Autoscale WebSocket
workers up and down based on concurrent connections instead of over-provisioning
for peak daily room count.

The static frontend is the cheapest part of the deployed architecture. The main
cost drivers are long-lived backend WebSocket capacity, Postgres write volume
from presence and cleanup, paid database sizing, and any TURN-relayed media.
The take-home Render deployment keeps those costs low by using one small backend
service, a free database, static hosting, and no provisioned TURN relay.

#### <u>What You'd Do About NAT Traversal (TURN) In Real Life</u>

Run a real TURN layer from day one for production. That could be managed TURN or
a monitored coturn deployment in multiple regions. The backend should issue
time-limited credentials from the ICE server endpoint rather than shipping static
TURN usernames/passwords to the browser.

Support UDP TURN for best performance and TCP/TLS TURN for restrictive networks.
Collect client-side ICE diagnostics so we can see how often calls connect
directly, through STUN-assisted peer-to-peer paths, or through TURN relay.

Monitor relay bandwidth, allocation failures, region latency, ICE failure rate,
and cost per connected minute. If relay usage is consistently high, or if the
product expands to group calls, recording, moderation, or server-side media
features, introduce an SFU and make TURN plus SFU placement part of the media
architecture rather than a browser-only fallback.

# MiniRTC — CODEX Implementation Blueprint

## Purpose

Build MiniRTC, a simple 1:1 WebRTC calling product.

This document is written as an execution spec for CODEX. It intentionally favors deterministic flows, explicit contracts, and implementation boundaries over broad architecture prose.

---

## Product Scope

### Required

- Create a room by URL.
- Join an existing room by URL.
- Room capacity is exactly 2 reserved participant slots.
- A reserved slot is occupied by an `ACTIVE` participant or a `DISCONNECTED` participant whose reconnect deadline has not expired.
- A third joiner must be rejected with `ROOM_FULL`.
- Either participant may start a call.
- Leaving a room and leaving a call are distinct operations.
- If both participants start a call simultaneously, one start attempt wins and the other receives: `Call already started, please join the existing call.`
- A call requires audio.
- Video is supported but optional and toggleable.
- Mute/unmute audio.
- Toggle camera on/off.
- Show connection status.
- Handle common media, signaling, and connection errors.
- Use WebSocket signaling.
- Use peer-to-peer WebRTC media.
- Configure STUN/TURN through backend-provided ICE server configuration.
- Support reconnect behavior.
- Track room membership and presence in realtime.
- Keep the core backend simple: Postgres is required; Redis is not required for the core build and is discussed as a scaling improvement in `DECISIONS.md`.
- Implement a minimal frontend.
- Discuss scalability, cost, TURN, account authorization, waitlists, and future improvements in `DECISIONS.md`.

### Explicitly Not Implemented

- Full account creation/login/JWT auth.
- Persistent call history.
- Waitlist.
- Screen sharing.
- Multi-party calls.
- SFU/MCU media routing.
- Advanced request correlation IDs.
- Call duration tracking.
- Room archival/history after both users leave.

---

# Key Product Decisions

## Room vs Call

A room is a lobby/waiting area.

A call is an active WebRTC media session inside a room.

A room may exist without an active call.

A call may be started by one participant and remain open until:

- the second participant joins the call and media negotiation succeeds;
- the call host ends the call;
- the non-host participant leaves the call;
- any participant leaves the room;
- a participant disconnects and fails to reconnect within the active call reconnect window;
- the room is deleted because it is empty.

Leaving a call and leaving a room are distinct operations.

- Leaving a call ends the active call for both participants but keeps both participants in the room.
- Leaving a room removes the participant from room membership and also ends any active/pending/negotiating call.

---

## Room Capacity

A room supports exactly 2 reserved participant slots.

If a third user tries to join:

```json
{
  "error": {
    "code": "ROOM_FULL",
    "message": "This room already has two participants."
  }
}
```

Waitlists are not implemented. They should be discussed as a future improvement in `DECISIONS.md`.

## Reserved Participant Count

Use `reserved_participant_count` anywhere the API or UI reports room occupancy.

`reserved_participant_count` means:

- ACTIVE participants; plus
- DISCONNECTED participants whose reconnect deadline has not expired.

A disconnected participant inside their reconnect window still reserves one of the two room slots.

If `reserved_participant_count == 2` but one participant has status `DISCONNECTED`, the frontend should explain:

```text
The other participant is reconnecting. This room slot is reserved temporarily.
```

Do not use an ambiguous `participant_count` field in API responses, WebSocket events, or frontend state.

---

## Room Deletion

Rooms do not persist after both users leave.

There is no `CLOSED` room state.

There is no `closed_at` column.

When the final reserved participant intentionally leaves, the frontend must prompt:

```text
You're the last person in the room. Leaving it will close the room.

Leave and close? [Leave & close] [Stay]
```

If the user confirms:

- remove final participant;
- end any active call;
- delete the room;
- clear any in-memory room bookkeeping for the room;
- if Redis is added in a future scaling iteration, delete all Redis keys for the room;
- notify remaining sockets, if any.

---

## Host Behavior

There are two host concepts:

### Room Host

The participant who created the room.

The room host may delete the room even if they are not currently in the room, as long as they still possess a valid room host token.

If the room host deletes the room:

- any active call ends immediately;
- all participants are removed;
- all clients receive `room-deleted`;
- any in-memory room bookkeeping is cleared;
- if Redis is added in a future scaling iteration, all room Redis state is deleted;
- the room row is deleted from Postgres.

### Call Host

The participant who successfully started the current call.

If the call host disconnects during an active call:

- mark them `DISCONNECTED`;
- start a 45-second active call reconnect window;
- if they reconnect within 45 seconds, restart negotiation with a new `RTCPeerConnection`;
- if they do not reconnect within 45 seconds, remove them from the room and end the active call.

Room host ownership does not transfer in the core implementation.

- The original room creator remains the room host for the lifetime of the room.
- The original host token remains the only token that can delete the room through the host-delete endpoint.
- If the room host expires or leaves, the remaining participant can continue using the room but cannot perform host-token deletion.
- If all participants leave or expire, the room is deleted normally.

If a room participant explicitly leaves the room at any time, any active/pending/negotiating call ends immediately.

If a participant leaves only the call, the active call ends for both participants, but both participants remain in the room.

---

# State Machines

## RoomStatus Enum

Use this exact enum.

```python
class RoomStatus(str, Enum):
    EMPTY = "EMPTY"
    WAITING_FOR_PARTICIPANT = "WAITING_FOR_PARTICIPANT"
    READY_FOR_CALL = "READY_FOR_CALL"
    CALL_PENDING = "CALL_PENDING"
    NEGOTIATING = "NEGOTIATING"
    IN_CALL = "IN_CALL"
```

Do not add `CLOSED`. Empty rooms are deleted.

---

## ParticipantStatus Enum

```python
class ParticipantStatus(str, Enum):
    ACTIVE = "ACTIVE"
    DISCONNECTED = "DISCONNECTED"
```

Do not add `WAITLISTED`.

---

## DisconnectContext Enum

```python
class DisconnectContext(str, Enum):
    ACTIVE_CALL = "ACTIVE_CALL"
    ROOM_ONLY = "ROOM_ONLY"
```

`disconnect_context` determines whether a disconnected participant receives the 45-second active-call reconnect timeout or the 5-minute room-only reconnect timeout.

---

## Room State Transitions

```text
EMPTY
  -> WAITING_FOR_PARTICIPANT

WAITING_FOR_PARTICIPANT
  -> READY_FOR_CALL
  -> CALL_PENDING
  -> deleted

READY_FOR_CALL
  -> CALL_PENDING
  -> deleted

CALL_PENDING
  -> NEGOTIATING
  -> WAITING_FOR_PARTICIPANT
  -> READY_FOR_CALL
  -> deleted

NEGOTIATING
  -> IN_CALL
  -> CALL_PENDING
  -> READY_FOR_CALL
  -> WAITING_FOR_PARTICIPANT
  -> deleted

IN_CALL
  -> NEGOTIATING
  -> CALL_PENDING
  -> READY_FOR_CALL
  -> WAITING_FOR_PARTICIPANT
  -> deleted
```

### Notes

- `EMPTY` is used as an initial internal state only.
- On room creation with a creator username, transition immediately from `EMPTY` to `WAITING_FOR_PARTICIPANT`.
- If the second participant joins, transition to `READY_FOR_CALL`, unless there is already a pending call, in which case remain `CALL_PENDING`.
- If a participant starts a call alone, transition to `CALL_PENDING`.
- If another participant joins while the room is `CALL_PENDING`, show them a “Join Call” action.
- If a participant leaves the room during any active/pending/negotiating call, end the call immediately and remove that participant from the room.
- If a participant leaves the call without leaving the room, end the call for both participants and transition the room back to `READY_FOR_CALL` if both participants remain active.
- `IN_CALL` means the peer-to-peer ICE connection has actually connected, not merely that SDP offer/answer was exchanged.
- `IN_CALL -> NEGOTIATING` happens when reconnect/session restore requires both peers to recreate `RTCPeerConnection` and renegotiate.
- `NEGOTIATING -> CALL_PENDING` or `IN_CALL -> CALL_PENDING` happens when reconnect/session restore leaves only one active call participant available.
- Empty room means delete the room, not mark it closed.

---

# Timeout Constants

Use these exact constants.

```python
ACTIVE_CALL_RECONNECT_TIMEOUT_SECONDS = 45
ROOM_OFFLINE_TIMEOUT_SECONDS = 300
HEARTBEAT_INTERVAL_SECONDS = 10
HEARTBEAT_STALE_AFTER_SECONDS = 30
CLEANUP_INTERVAL_SECONDS = 10
```

## Timeout Meaning

Disconnect timeout context is based on the participant, not only the room `call_status`.

### Active Call Reconnect Timeout: 45 seconds

Applies only when the disconnected participant is an active call participant.

Participant-specific rules:

- During `CALL_PENDING`, only the call host is treated as `ACTIVE_CALL`.
- During `CALL_PENDING`, a non-host room participant who has not joined the call is treated as `ROOM_ONLY`.
- During `NEGOTIATING` or `IN_CALL`, both active room participants are treated as `ACTIVE_CALL`.

After 45 seconds:

- remove the disconnected participant from the room;
- end the active call if the disconnected participant was in `ACTIVE_CALL` context;
- do not transfer room host;
- recompute room state;
- delete room if empty.

### Offline Room Timeout: 5 minutes

Applies when a participant disconnects while they are only in the room/lobby, not actively part of a call.

After 5 minutes:

- remove the disconnected participant from the room;
- do not transfer room host;
- recompute room state;
- delete room if empty.

---

# Implementation Clarifications

## Source of Truth

Postgres is the source of truth for:

- room existence;
- participant membership;
- room host identity;
- room status;
- call status;
- call host participant;
- reconnect deadlines;
- hashed participant and host tokens.

The in-memory `ConnectionManager` stores only live WebSocket objects for the current backend process.

Redis is not required for the core implementation. If Redis is added later, it should be treated as ephemeral scaling infrastructure, not as the durable source of truth.

`rooms.call_host_participant_id` is the only source of truth for the current call host. Do not add or maintain a participant-level `is_call_host` column.

## Atomicity

`RoomService.join_room` must run inside a Postgres transaction and lock the room row using `SELECT ... FOR UPDATE` before counting active or disconnected-within-window participants and inserting the new participant.

A disconnected participant whose reconnect deadline has not expired still occupies one of the two room slots. If a third user tries to join while a disconnected participant is still inside the reconnect window, return `ROOM_FULL` and show UI copy explaining that a participant is temporarily reconnecting.

`RoomService.start_call` must also be atomic. Use a Postgres transaction with a row lock on the room row. The first simultaneous `start-call` request that observes `call_status = IDLE` sets `call_status = CALL_PENDING` and `call_host_participant_id = sender`. The second simultaneous request observes the updated call state and receives `CALL_ALREADY_STARTED`.

Do not implement both Redis locks and Postgres locks in the core build. Use Postgres row locks for deterministic local behavior.

## WebSocket Identity

The authenticated participant associated with the WebSocket connection is the source of truth for all WebSocket events.

If an event payload contains `participant_id`, it must match the WebSocket connection participant id. If it does not match, reject the event with an `INVALID_PARTICIPANT` error and do not process the event.

## Duplicate WebSocket Connections

If a valid participant opens a new WebSocket while an old WebSocket still exists, accept the new socket, close the old socket with close code `4429`, and keep the participant `ACTIVE`.

This avoids treating normal browser refreshes or fast reconnects as participant disconnects.

When a socket closes, only mark the participant disconnected if the closing socket is still the currently registered socket for that participant.

If the socket was already replaced by a newer duplicate connection, ignore the close for participant-status purposes.

## Active Call Participant Definition

For the core 1:1 implementation:

- During `CALL_PENDING`, the active call participant is the call host.
- After `join-call` succeeds, both ACTIVE room participants are considered active call participants.
- During `NEGOTIATING` or `IN_CALL`, either ACTIVE room participant may leave the call.
- The backend does not need a separate `call_participants` table for the core 1:1 build.

---

## Canonical Room Status Recompute

Use one helper in `RoomService` for all room-status recomputation.

For `call_status = IDLE`:

- 2 ACTIVE participants -> `READY_FOR_CALL`;
- 1 ACTIVE participant plus 1 DISCONNECTED reserved participant -> `WAITING_FOR_PARTICIPANT`;
- 1 ACTIVE participant -> `WAITING_FOR_PARTICIPANT`;
- 0 ACTIVE participants but at least 1 DISCONNECTED reserved participant -> `WAITING_FOR_PARTICIPANT`;
- 0 reserved participants -> delete room.

For `call_status = CALL_PENDING`, `NEGOTIATING`, or `IN_CALL`, call state controls room status until the call ends, reconnect cleanup expires, or reconnect logic intentionally moves the call back to `NEGOTIATING`/`CALL_PENDING`.

---

## Call Connection State

`IN_CALL` means the peer-to-peer ICE connection has actually connected.

After the backend forwards the first valid `answer`, SDP exchange is considered complete, but the backend must not mark the room `IN_CALL` yet. The backend remains in `NEGOTIATING` until the frontend reports media connection.

Frontend must send `media-connected` after its `RTCPeerConnection` reaches `connectionState === "connected"` or `iceConnectionState === "connected" | "completed"`. The backend transitions `NEGOTIATING -> IN_CALL` after receiving `media-connected` from both active call participants.

Frontend UI connection status remains authoritative for the local browser and should be based on `RTCPeerConnection` state, not only backend room status.

## Disconnect Idempotency

Disconnect handling must be idempotent.

If a participant is already `DISCONNECTED`, do not reset or extend their reconnect deadline unless they explicitly reconnect successfully and later disconnect again from a new active session.

Heartbeat cleanup and WebSocket disconnect handling may race; both paths must safely tolerate the participant already being disconnected or already removed.

---

## ICE Failure Reporting

ICE failure recovery is frontend-only and intentionally simple in the core build.

When the frontend detects ICE failure, it should:

- show a failed/degraded connection state;
- close the failed `RTCPeerConnection`;
- allow the user to leave and rejoin the call to renegotiate from a clean state.

The core build should not implement coordinated ICE-failure recovery, remote peer connection recreation, an `ICE_FAILED` call-ended reason, or an ICE-failure reporting event.

`DECISIONS.md` must mention that production could report ICE failures to the backend for analytics, debugging, coordinated call teardown, and coordinated peer-connection recreation across both clients.

## Username Validation and Rendering

Backend must validate usernames on create/join:

- trim whitespace;
- require at least one non-whitespace character;
- reject usernames longer than 40 characters;
- allow duplicate display names.

Frontend must render usernames as plain text only. Do not use `dangerouslySetInnerHTML`, `innerHTML`, or equivalent APIs for usernames or error messages that include usernames.

---

# Tech Stack and Dependencies

Use this stack unless the assignment explicitly requires otherwise.

## Backend

- Python 3.12+
- FastAPI
- Uvicorn
- SQLAlchemy 2.0 async ORM
- Alembic
- asyncpg
- Pydantic v2
- python-dotenv or Pydantic Settings for config
- pytest
- pytest-asyncio
- httpx
- websockets through FastAPI / Starlette

## Backend Dependency Notes

- Do not add full auth libraries such as PyJWT/passlib/bcrypt for the core implementation.
- Use `secrets.token_urlsafe(...)` for opaque participant and host tokens.
- Store only token hashes in Postgres.
- Use HMAC-SHA256 or SHA-256 with an application secret for token hashing.
- Do not introduce Redis for the core build. Redis is a documented scaling improvement only.

## Frontend

- React
- Vite
- TypeScript
- Browser WebRTC APIs
- Native WebSocket API
- React Context + `useReducer` for state

## Infrastructure

- Docker
- Docker Compose
- PostgreSQL
- Alembic migrations

## Optional Developer Tools

- Ruff for linting/formatting
- mypy for Python type checking if time permits
- ESLint for frontend linting
- TypeScript compiler checks through `tsc --noEmit`

---

# Repository Structure

Use this structure.

```text
minirtc/
  backend/
    alembic/
      versions/
    alembic.ini
    app/
      main.py
      api/
        routes/
          rooms.py
          signaling.py
      core/
        config.py
        errors.py
        logging.py
        background_tasks.py
      db/
        base.py
        session.py
        models.py
      repositories/
        room_repository.py
      services/
        room_service.py
        signaling_service.py
        ice_service.py
      websocket/
        connection_manager.py
        schemas.py
      tests/
        unit/
        integration/
        websocket/
  frontend/
    src/
      api/
        rooms.ts
      hooks/
        useRoom.ts
        useWebSocket.ts
        useWebRTC.ts
        useMediaDevices.ts
      components/
        JoinRoomForm.tsx
        RoomPage.tsx
        CallControls.tsx
        ConnectionStatus.tsx
        VideoPanel.tsx
      state/
        roomReducer.ts
      types/
        signaling.ts
  README.md
  DECISIONS.md
  docker-compose.yml
```

Do not create `participant_service.py`.

Participant membership operations belong in `RoomService`.

---

# Repository Method Contracts

Use a single repository module for durable room and participant state.

File:

```text
backend/app/repositories/room_repository.py
```

Do not create `user_repository.py` or `participant_repository.py` for the core implementation.

## `RoomRepository`

Suggested public methods:

```python
from datetime import datetime
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

class RoomRepository:
    async def create_room(
        self,
        session: AsyncSession,
        *,
        room_code: str,
        host_token_hash: str,
    ) -> Room: ...

    async def get_room_by_code(
        self,
        session: AsyncSession,
        *,
        room_code: str,
    ) -> Room | None: ...

    async def get_room_by_code_for_update(
        self,
        session: AsyncSession,
        *,
        room_code: str,
    ) -> Room | None: ...

    async def create_participant(
        self,
        session: AsyncSession,
        *,
        room_id: UUID,
        username: str,
        participant_token_hash: str,
    ) -> Participant: ...

    async def get_participant(
        self,
        session: AsyncSession,
        *,
        participant_id: UUID,
    ) -> Participant | None: ...

    async def get_participant_for_update(
        self,
        session: AsyncSession,
        *,
        participant_id: UUID,
    ) -> Participant | None: ...

    async def list_room_participants(
        self,
        session: AsyncSession,
        *,
        room_id: UUID,
    ) -> list[Participant]: ...

    async def list_reserved_slot_participants(
        self,
        session: AsyncSession,
        *,
        room_id: UUID,
        now: datetime,
    ) -> list[Participant]: ...

    async def count_reserved_slots(
        self,
        session: AsyncSession,
        *,
        room_id: UUID,
        now: datetime,
    ) -> int: ...

    async def update_room_status(
        self,
        session: AsyncSession,
        *,
        room_id: UUID,
        status: str,
        call_status: str | None = None,
    ) -> None: ...

    async def set_room_host_participant(
        self,
        session: AsyncSession,
        *,
        room_id: UUID,
        host_participant_id: UUID,
    ) -> None: ...

    async def set_call_host(
        self,
        session: AsyncSession,
        *,
        room_id: UUID,
        call_host_participant_id: UUID | None,
    ) -> None: ...

    async def mark_participant_disconnected(
        self,
        session: AsyncSession,
        *,
        participant_id: UUID,
        disconnected_at: datetime,
        reconnect_deadline_at: datetime,
        disconnect_context: str,
    ) -> None: ...

    async def mark_participant_active(
        self,
        session: AsyncSession,
        *,
        participant_id: UUID,
        last_seen_at: datetime,
    ) -> None: ...

    async def update_participant_last_seen(
        self,
        session: AsyncSession,
        *,
        participant_id: UUID,
        last_seen_at: datetime,
    ) -> None: ...

    async def record_media_connected(
        self,
        session: AsyncSession,
        *,
        participant_id: UUID,
        connected_at: datetime,
    ) -> None: ...

    async def clear_media_connected_for_room(
        self,
        session: AsyncSession,
        *,
        room_id: UUID,
    ) -> None: ...

    async def remove_participant(
        self,
        session: AsyncSession,
        *,
        participant_id: UUID,
    ) -> None: ...

    async def delete_room(
        self,
        session: AsyncSession,
        *,
        room_id: UUID,
    ) -> None: ...

    async def list_expired_disconnected_participants(
        self,
        session: AsyncSession,
        *,
        now: datetime,
        limit: int = 100,
    ) -> list[Participant]: ...
```

## Reserved Slot Definition

A participant reserves one of the room's two slots if:

- `status == ACTIVE`; or
- `status == DISCONNECTED` and `reconnect_deadline_at > now`.

Expired disconnected participants do not reserve a slot after cleanup removes them.

## Token Validation Helpers

Token hashing/verification may live in `core/security.py` even though full account auth is not implemented.

Suggested helpers:

```python
def generate_opaque_token() -> str: ...
def hash_token(raw_token: str) -> str: ...
def verify_token(raw_token: str, token_hash: str) -> bool: ...
```

---

# Backend Responsibility Boundaries

## `ConnectionManager`

File:

```text
backend/app/websocket/connection_manager.py
```

Owns only the in-memory WebSocket transport layer.

Responsibilities:

- accept websocket connections;
- store active sockets;
- remove sockets;
- send raw JSON to one participant;
- broadcast raw JSON to a room;
- expose connection lookup helpers;
- track in-memory socket objects only.

Canonical structure:

```python
active_connections: dict[str, dict[str, WebSocket]]
# room_code -> participant_id -> websocket
```

Do not put room business rules here.

Do not perform state transitions here.

Do not access the database here.

Do not access Redis here. Redis is not part of the core implementation; if added later, it belongs behind service/repository abstractions, not inside the transport manager.

---

## `SignalingService`

File:

```text
backend/app/services/signaling_service.py
```

Coordinates WebSocket messages with business state.

Responsibilities:

- validate participant identity;
- validate room state before processing events;
- call `RoomService` for state transitions;
- call `ConnectionManager` to send/broadcast events;
- forward WebRTC signaling payloads;
- enforce `CALL_ALREADY_STARTED` behavior;
- handle websocket disconnect cleanup;
- emit presence events;
- emit room deletion events.

Do not store raw WebSocket objects here.

---

## `RoomService`

File:

```text
backend/app/services/room_service.py
```

Owns room, participant, and call state.

Responsibilities:

- create room;
- join room;
- leave room;
- delete room;
- start call;
- end call;
- mark participant disconnected;
- reconnect participant;
- remove expired participants;
- preserve original room host;
- recompute room status;
- enforce 2-person capacity;
- perform Postgres writes for room, participant, call, and reconnect state.

Participant logic belongs here. Do not create a separate participant service.

---

## `IceService`

File:

```text
backend/app/services/ice_service.py
```

Responsibilities:

- provide frontend-safe ICE server config;
- keep TURN credentials out of frontend static environment variables;
- return STUN/TURN config from an authenticated participant endpoint.

---

# Data Model

## PostgreSQL Principles

Postgres stores durable room and participant membership state while rooms exist.

Rooms are deleted when empty.

No persistent call history is implemented.

No user account table is implemented.

---

## Tables

### rooms

```sql
CREATE TABLE rooms (
    id UUID PRIMARY KEY,
    room_code TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL,
    call_status TEXT NOT NULL DEFAULT 'IDLE',
    call_host_participant_id UUID NULL,
    host_participant_id UUID NULL,
    host_token_hash TEXT NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
```

### participants

```sql
CREATE TABLE participants (
    id UUID PRIMARY KEY,
    room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    username TEXT NOT NULL,
    participant_token_hash TEXT NOT NULL,
    status TEXT NOT NULL,
    joined_at TIMESTAMP NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMP NOT NULL DEFAULT NOW(),
    disconnected_at TIMESTAMP NULL,
    reconnect_deadline_at TIMESTAMP NULL,
    disconnect_context TEXT NULL,
    media_connected_at TIMESTAMP NULL
);
```

---

## Indexes

```sql
CREATE UNIQUE INDEX idx_rooms_room_code ON rooms(room_code);
CREATE INDEX idx_participants_room_id ON participants(room_id);
CREATE INDEX idx_participants_room_status ON participants(room_id, status);
CREATE INDEX idx_participants_reconnect_deadline ON participants(reconnect_deadline_at);
```

---

## Notes

- `username` is display-only and not globally unique.
- Usernames must be trimmed, required, at most 40 characters, and rendered as text only in the frontend. Never inject usernames with `innerHTML` or equivalent APIs.
- Duplicate display names are allowed.
- `participant_token_hash` is used only to re-identify a participant for reconnect and websocket connection.
- `host_token_hash` allows the original room creator to delete the room even if not currently connected.
- Tokens are opaque random values generated by the backend and stored hashed in Postgres.
- This is not full account authorization.
- Use Alembic migrations for schema creation and changes. Do not rely on ad hoc `create_all` for the submitted implementation.
- `host_participant_id` and `call_host_participant_id` are nullable UUID references managed by application logic in the core build. Do not add circular foreign key constraints unless you also handle room/participant creation ordering and `ON DELETE SET NULL` correctly.

---

# Detailed Database Transaction Rules

Use Postgres transactions and row locks for correctness in the core build.

Do not add Redis locks for the core implementation.

## Atomic Room Creation

```text
1. Generate room_code and host_token. Retry room_code generation on unique constraint collision up to 3 times, then return an internal error.
2. Begin transaction.
3. Insert room with status EMPTY and call_status IDLE.
4. Generate participant_token.
5. Insert first participant with status ACTIVE.
6. Set host_participant_id to first participant.
7. Set room status to WAITING_FOR_PARTICIPANT.
8. Commit.
9. Return raw participant_token and host_token once; store only hashes.
```

## Atomic Room Join

```text
1. Begin transaction.
2. SELECT room FOR UPDATE by room_code.
3. If room does not exist, return ROOM_NOT_FOUND.
4. Remove expired disconnected participants for this room inside the same transaction before counting reserved slots.
5. If no reserved participants remain after expired participant cleanup and the room was otherwise empty, delete the room and return ROOM_NOT_FOUND.
6. Count reserved slots:
   - ACTIVE participants;
   - DISCONNECTED participants whose reconnect_deadline_at is still in the future.
7. If reserved slot count >= 2, rollback and return ROOM_FULL.
8. Insert participant with status ACTIVE.
9. Recompute room status:
   - one reserved slot -> WAITING_FOR_PARTICIPANT unless call_status is CALL_PENDING;
   - two reserved slots -> READY_FOR_CALL unless call_status is CALL_PENDING/NEGOTIATING/IN_CALL.
10. Commit.
11. Broadcast participant-joined and room-state after commit.
```

## Atomic Start Call

```text
1. Begin transaction.
2. SELECT room FOR UPDATE.
3. Verify sender participant is ACTIVE and belongs to room.
4. If call_status is not IDLE, rollback and send CALL_ALREADY_STARTED to sender.
5. Set call_status to CALL_PENDING.
6. Set room status to CALL_PENDING.
7. Set call_host_participant_id to sender.
8. Clear previous media_connected_at values for room participants.
9. Commit.
10. Broadcast call-started after commit.
```

## Atomic Join Call

```text
1. Begin transaction.
2. SELECT room FOR UPDATE.
3. Verify sender participant is ACTIVE and belongs to room.
4. Verify call_status is CALL_PENDING.
5. Verify at least two ACTIVE participants are present.
6. Set call_status to NEGOTIATING.
7. Set room status to NEGOTIATING.
8. Clear media_connected_at for both participants.
9. Commit.
10. Broadcast call-joined after commit.
```

## Atomic Media Connected

```text
1. Begin transaction.
2. SELECT room FOR UPDATE.
3. Verify sender participant is ACTIVE and belongs to room.
4. Verify call_status is NEGOTIATING or IN_CALL.
5. Record sender media_connected_at.
6. If all active call participants have media_connected_at set:
   - set call_status to IN_CALL;
   - set room status to IN_CALL.
7. Commit.
8. Broadcast room-state after commit if state changed.
```

## Atomic End Call / Leave Call

```text
1. Begin transaction.
2. SELECT room FOR UPDATE.
3. Verify sender participant is ACTIVE and belongs to room.
4. If call_status is IDLE, commit no state changes and treat the request as an idempotent no-op. Do not broadcast `call-ended`.
5. Verify sender is an active call participant:
   - if call_status is CALL_PENDING, only call_host_participant_id may end the pending call;
   - if call_status is NEGOTIATING or IN_CALL, either ACTIVE room participant may end/leave the call.
6. If sender is not an active call participant, commit no state changes and treat the request as an idempotent no-op. Do not broadcast `call-ended`.
7. Clear call_host_participant_id.
8. Clear media_connected_at for room participants.
9. Set call_status to IDLE.
10. Recompute room status using the canonical room-status recompute rule.
11. Commit.
12. If state changed, broadcast call-ended and room-state after commit.
```

## Atomic Leave Room

```text
1. Begin transaction.
2. SELECT room FOR UPDATE.
3. Verify participant token.
4. If call_status is CALL_PENDING, NEGOTIATING, or IN_CALL:
   - end the call;
   - clear call_host_participant_id;
   - clear media_connected_at;
   - set call_status to IDLE.
5. Delete participant row.
6. Recompute room status from remaining active/reserved participants.
7. If no participants remain, delete room row.
8. Commit.
9. Broadcast participant-left, call-ended, room-state, or room-deleted after commit.
```

## Atomic Reconnect

```text
1. Begin transaction.
2. SELECT room FOR UPDATE.
3. SELECT participant FOR UPDATE.
4. Verify participant token.
5. Determine whether participant status was ACTIVE or DISCONNECTED before this request.
6. If participant status is DISCONNECTED:
   - verify reconnect_deadline_at is in the future;
   - store the previous disconnect_context before clearing it;
   - set participant status ACTIVE;
   - clear disconnected_at, reconnect_deadline_at, and disconnect_context.
7. If participant status is already ACTIVE:
   - treat reconnect as an idempotent successful session restore;
   - previous disconnect_context is not available, so compute active-call participation from current call state:
     - CALL_PENDING -> participant is active-call participant only if participant.id == room.call_host_participant_id;
     - NEGOTIATING or IN_CALL -> any ACTIVE room participant is an active-call participant;
     - IDLE -> not an active-call participant;
   - do not reset reconnect deadlines;
   - do not broadcast participant-reconnected.
8. Update last_seen_at.
9. Apply call-state-specific reconnect/session-restore behavior:
   - if call_status is IDLE: return must_restart_peer_connection=false;
   - if call_status is CALL_PENDING and the reconnecting/restoring participant is not the call host or previous disconnect_context was ROOM_ONLY: keep call_status as CALL_PENDING and return must_restart_peer_connection=false;
   - if call_status is CALL_PENDING and the reconnecting/restoring participant is the call host or previous disconnect_context was ACTIVE_CALL: keep call_status as CALL_PENDING and return must_restart_peer_connection=true;
   - if call_status is NEGOTIATING or IN_CALL: clear media_connected_at for all room participants; if two ACTIVE participants are present, set call_status and room status back to NEGOTIATING and return must_restart_peer_connection=true; otherwise set call_status and room status to CALL_PENDING and return must_restart_peer_connection=true.
10. Commit.
11. If participant was previously DISCONNECTED, broadcast participant-reconnected and room-state after commit.
12. If participant was already ACTIVE but reconnect/session restore moved call_status back to NEGOTIATING or CALL_PENDING, broadcast room-state after commit.
13. If the call moved back to NEGOTIATING, both clients recreate RTCPeerConnection and rerun deterministic offer/answer negotiation.
```

## Cleanup Expiration Transaction

```text
1. Background task finds expired disconnected participant.
2. Begin transaction.
3. SELECT room FOR UPDATE.
4. SELECT participant FOR UPDATE.
5. If participant is no longer expired, rollback.
6. If participant was in active call context, end the call.
7. Delete participant row.
8. Recompute room state.
9. Delete room if empty.
10. Commit.
11. Broadcast state changes after commit.
```

---

# Redis / Realtime State Decision

Redis is not required for the core implementation.

The core build uses:

- Postgres for room existence, participant membership, room status, call status, reconnect deadlines, and token hashes;
- the in-memory `ConnectionManager` for live WebSocket objects in a single backend process;
- FastAPI lifespan-managed cleanup loops that read expired reconnect deadlines from Postgres.

This keeps the take-home implementation simpler and easier to run locally.

## Future Redis Scaling Model

`DECISIONS.md` must explain that Redis would be introduced for multi-instance scaling and high room churn. In that future design, Redis should remain ephemeral and should not become the durable source of truth for room membership.

Possible future Redis uses:

- heartbeat keys;
- reconnect deadline keys;
- room presence snapshots;
- Redis pub/sub for WebSocket fanout across backend instances;
- short-lived coordination locks if Postgres row locks become a bottleneck.

If Redis is introduced later and Redis state is missing for an existing room, the backend must recompute room state from Postgres and treat any active call as ended unless the clients renegotiate successfully.

---

# REST API Contracts

## POST /rooms

Creates a room and immediately joins the creator as the first participant and room host.

Request:

```json
{
  "username": "Josh"
}
```

Response:

```json
{
  "room_code": "nanoid-or-token",
  "participant": {
    "participant_id": "uuid",
    "username": "Josh",
    "is_room_host": true
  },
  "participant_token": "opaque-token",
  "host_token": "opaque-token"
}
```

Important:

- Do not return `room_url`.
- The frontend constructs the shareable URL using its own origin and the returned `room_code`.

---

## POST /rooms/{room_code}/join

Adds a participant to a room using only a username.

Request:

```json
{
  "username": "Sam"
}
```

Success response:

```json
{
  "room_code": "abc123",
  "participant": {
    "participant_id": "uuid",
    "username": "Sam",
    "is_room_host": false
  },
  "participant_token": "opaque-token",
  "room_status": "READY_FOR_CALL",
  "reserved_participant_count": 2
}
```

If room is full:

HTTP `409`:

```json
{
  "error": {
    "code": "ROOM_FULL",
    "message": "This room already has two participants."
  }
}
```

If room does not exist:

HTTP `404`:

```json
{
  "error": {
    "code": "ROOM_NOT_FOUND",
    "message": "Room not found."
  }
}
```

Joining is a REST action, not a WebSocket side effect.

The WebSocket connection is opened only after a successful REST join/create response.

---

## POST /rooms/{room_code}/reconnect

Restores a participant within the applicable reconnect window.

Request:

```json
{
  "participant_id": "uuid",
  "participant_token": "opaque-token"
}
```

Response:

```json
{
  "participant_id": "uuid",
  "room_code": "abc123",
  "room_status": "READY_FOR_CALL",
  "call_status": "IDLE",
  "reserved_participant_count": 1,
  "must_restart_peer_connection": false
}
```

`must_restart_peer_connection` is computed by the backend from participant-specific reconnect/session-restore context, not only from room `call_status`:

- `false` when `call_status` is `IDLE`;
- `false` when `call_status` is `CALL_PENDING` and the reconnecting/restoring participant is not the call host or the participant's previous `disconnect_context` was `ROOM_ONLY`;
- `true` when `call_status` is `CALL_PENDING` and the reconnecting/restoring participant is the call host or the participant's previous `disconnect_context` was `ACTIVE_CALL`;
- `true` when `call_status` is `NEGOTIATING` or `IN_CALL`.

Rules:

- Browser refresh is treated as reconnect/session restore.
- If a valid reconnect request arrives while the participant is already `ACTIVE`, treat it as an idempotent successful session restore, but still compute `must_restart_peer_connection` from current call state and active-call participation.
- If an already-`ACTIVE` reconnect/session restore occurs while `call_status` is `NEGOTIATING` or `IN_CALL`, clear `media_connected_at` for all room participants, move the room back to `NEGOTIATING` if two ACTIVE participants are present, return `must_restart_peer_connection=true`, and broadcast `room-state` after commit.
- Reconnect within timeout preserves room membership.
- Active call reconnect timeout is 45 seconds.
- Room-only reconnect timeout is 5 minutes.
- During `CALL_PENDING`, a reconnecting/restoring `ROOM_ONLY` participant does not force the room into `NEGOTIATING`; they still need to click Join Call.
- After reconnect/session restore, frontend destroys/recreates `RTCPeerConnection` only if `must_restart_peer_connection` is true or if a local peer connection already exists.

---

## POST /rooms/{room_code}/leave

Explicitly leaves the room. This is distinct from leaving only the active call.

Request:

```json
{
  "participant_id": "uuid",
  "participant_token": "opaque-token"
}
```

Response:

```json
{
  "left": true,
  "room_deleted": false
}
```

Rules:

- If the participant is in an active/pending/negotiating call, end the call for both participants.
- If this is the final participant, the room is deleted.
- Frontend must prompt before calling this endpoint only if there are no other ACTIVE or DISCONNECTED-within-reconnect-window participants.

---

## POST /rooms/{room_code}/delete

Deletes the room.

Used by the original room host. This uses POST instead of DELETE because the request needs a JSON body and this avoids DELETE-body compatibility issues across clients and intermediaries.

Request:

```json
{
  "host_token": "opaque-token"
}
```

Response:

```json
{
  "deleted": true
}
```

Rules:

- The original room host can delete the room even if not currently in the room.
- End active call if present.
- Remove all participants.
- Delete Postgres room row.
- Clear in-memory room bookkeeping for the room.
- If Redis is added in a future scaling iteration, delete Redis room keys.
- Broadcast `room-deleted` before closing sockets when possible.

---

## GET /rooms/{room_code}

Returns public room state.

Response:

```json
{
  "room_code": "abc123",
  "status": "WAITING_FOR_PARTICIPANT",
  "reserved_participant_count": 1,
  "capacity": 2,
  "call_status": "IDLE|CALL_PENDING|NEGOTIATING|IN_CALL"
}
```

---

## POST /rooms/{room_code}/ice-servers

Returns ICE server config for an authenticated room participant.

Request:

```json
{
  "participant_id": "uuid",
  "participant_token": "opaque-token"
}
```

Response:

```json
{
  "ice_servers": [
    {
      "urls": ["stun:stun.l.google.com:19302"]
    },
    {
      "urls": ["turn:turn.example.com:3478"],
      "username": "runtime-turn-username",
      "credential": "runtime-turn-password"
    }
  ]
}
```

Rules:

- Frontend must not hardcode TURN credentials.
- Frontend calls this endpoint before constructing `RTCPeerConnection`.
- The endpoint must validate `participant_id` and `participant_token` before returning TURN credentials.
- For local development, TURN may be omitted if not configured, but STUN should always be present.
- `DECISIONS.md` must mention that production TURN credentials should be short-lived and generated dynamically when possible.

---

## Common REST Error Responses

Use consistent error envelopes for token/auth failures.

Invalid participant token or participant id/token mismatch returns HTTP `401` or `403`:

```json
{
  "error": {
    "code": "INVALID_PARTICIPANT",
    "message": "Invalid participant credentials."
  }
}
```

Invalid host token returns HTTP `403`:

```json
{
  "error": {
    "code": "INVALID_HOST_TOKEN",
    "message": "Invalid host token."
  }
}
```

Apply these consistently to reconnect, leave-room, host-delete, and ICE-server endpoints.

---

# WebSocket Connection Contract

## Endpoint

```text
/ws/rooms/{room_code}?participant_id={participant_id}&participant_token={participant_token}
```

Browser WebSocket APIs cannot set arbitrary auth headers, so participant credentials are passed in query parameters for this implementation.

`DECISIONS.md` must mention that a production version should issue short-lived one-time WebSocket tokens to reduce token exposure in logs.

The authenticated participant attached to the WebSocket connection is the source of truth for every client event. Payload `participant_id` values are optional for client convenience, but if present they must match the connection participant id.

If the same participant opens a second valid WebSocket, accept the new WebSocket and close the old WebSocket with `4429`. Do not mark the participant disconnected.

WebSocket connections are accepted only for participants whose status is `ACTIVE`.

If a participant has status `DISCONNECTED`, reject the WebSocket with `4401` and require the frontend to call `POST /rooms/{room_code}/reconnect` first. This prevents a stale token from bypassing reconnect deadline validation.

---

## WebSocket Close Codes

Use these close codes.

```python
WS_CLOSE_INVALID_PARTICIPANT = 4401
WS_CLOSE_ROOM_NOT_FOUND = 4404
WS_CLOSE_ROOM_FULL = 4409
WS_CLOSE_ROOM_DELETED = 4410
WS_CLOSE_DUPLICATE_CONNECTION = 4429
WS_CLOSE_INTERNAL_ERROR = 4500
```

Meaning:

| Code | Meaning |
|---:|---|
| 4401 | Invalid participant id/token |
| 4404 | Room not found |
| 4409 | Room full; should normally happen at REST join, not WS |
| 4410 | Room deleted |
| 4429 | Duplicate websocket connection for same participant |
| 4500 | Unexpected backend error |

---

# WebSocket Event Contracts

Every message has:

```json
{
  "type": "event-name",
  "payload": {}
}
```

Do not implement `call-rejected`.

There is no explicit rejection flow.

---

## Client -> Server Events

### heartbeat

```json
{
  "type": "heartbeat",
  "payload": {
    "participant_id": "uuid"
  }
}
```

Server behavior:

- validate sender identity from the WebSocket connection;
- if `payload.participant_id` is present, verify it matches the connection participant id;
- update `participant.last_seen_at` in Postgres;
- do not broadcast heartbeat events;
- if participant is already `DISCONNECTED`, ignore heartbeat unless the participant has successfully completed REST reconnect.

---

### start-call

```json
{
  "type": "start-call",
  "payload": {
    "participant_id": "uuid"
  }
}
```

Server behavior:

- if no call is active, set call state to `CALL_PENDING`;
- set `call_host_participant_id` to sender;
- broadcast `call-started`;
- if a call already exists, send `error` only to sender with code `CALL_ALREADY_STARTED`.

---

### join-call

```json
{
  "type": "join-call",
  "payload": {
    "participant_id": "uuid"
  }
}
```

Server behavior:

- validate participant is in room;
- transition `CALL_PENDING -> NEGOTIATING` if there are two active participants;
- broadcast `call-joined`;
- clients then begin deterministic WebRTC offer/answer flow.

---

### end-call

```json
{
  "type": "end-call",
  "payload": {
    "participant_id": "uuid"
  }
}
```

Server behavior:

- if `call_status` is `IDLE`, treat `end-call` as an idempotent no-op: do not return an error, do not change state, and do not broadcast `call-ended`;
- verify sender is an active call participant before ending anything;
- if `call_status` is `CALL_PENDING`, only `call_host_participant_id` may end the pending call;
- if `call_status` is `NEGOTIATING` or `IN_CALL`, either ACTIVE room participant may send `end-call`;
- if sender is not an active call participant, treat `end-call` as an idempotent no-op and do not broadcast `call-ended`;
- if the sender is the call host, treat the UI action as `End Call`;
- if the sender is not the call host, treat the UI action as `Leave Call`;
- in a 1:1 call, either participant ending/leaving the call ends the call for both participants;
- both participants remain in the room;
- transition room status using the canonical room-status recompute rule;
- if state changed, broadcast `call-ended`.

---

### offer

```json
{
  "type": "offer",
  "payload": {
    "sdp": {
      "type": "offer",
      "sdp": "v=0..."
    }
  }
}
```

Server behavior:

- validate sender is in room;
- validate room is `NEGOTIATING` or `IN_CALL`;
- forward to the other participant only;
- if the target participant has no active WebSocket, drop the signaling message and optionally send `PEER_NOT_CONNECTED` to the sender;
- do not persist SDP server-side.

---

### answer

```json
{
  "type": "answer",
  "payload": {
    "sdp": {
      "type": "answer",
      "sdp": "v=0..."
    }
  }
}
```

Server behavior:

- validate sender is in room;
- validate room is `NEGOTIATING` or `IN_CALL`;
- forward to the other participant only;
- if the target participant has no active WebSocket, drop the signaling message and optionally send `PEER_NOT_CONNECTED` to the sender;
- do not persist SDP server-side;
- after forwarding the first valid `answer`, treat SDP exchange as complete but keep room status `NEGOTIATING` until media connection is reported by both participants. If reconnect logic moved a previous `IN_CALL` call back to `NEGOTIATING`, handle the new answer through this same flow.

---

### media-connected

```json
{
  "type": "media-connected",
  "payload": {
    "participant_id": "uuid"
  }
}
```

Server behavior:

- validate sender is in room;
- validate room is `NEGOTIATING` or `IN_CALL`;
- record `media_connected_at` for the sender;
- when both active call participants have reported media connected, transition `NEGOTIATING -> IN_CALL`;
- broadcast `room-state` with `room_status` and `call_status` set to `IN_CALL`.

---

### ice-candidate

```json
{
  "type": "ice-candidate",
  "payload": {
    "candidate": "...",
    "sdpMid": "0",
    "sdpMLineIndex": 0
  }
}
```

Server behavior:

- validate sender is in room;
- forward to the other participant only;
- if the target participant has no active WebSocket, drop the signaling message and optionally send `PEER_NOT_CONNECTED` to the sender;
- do not store ICE candidates server-side.

---

## Server -> Client Events

### room-state

```json
{
  "type": "room-state",
  "payload": {
    "room_status": "READY_FOR_CALL",
    "reserved_participant_count": 2,
    "capacity": 2,
    "participants": [
      {
        "participant_id": "uuid",
        "username": "Josh",
        "status": "ACTIVE"
      }
    ],
    "call_status": "IDLE|CALL_PENDING|NEGOTIATING|IN_CALL",
    "call_host_participant_id": "uuid-or-null"
  }
}
```

---

### participant-joined

```json
{
  "type": "participant-joined",
  "payload": {
    "participant_id": "uuid",
    "username": "Sam",
    "reserved_participant_count": 2
  }
}
```

---

### participant-left

```json
{
  "type": "participant-left",
  "payload": {
    "participant_id": "uuid",
    "reserved_participant_count": 1,
    "call_ended": true
  }
}
```

---

### participant-disconnected

```json
{
  "type": "participant-disconnected",
  "payload": {
    "participant_id": "uuid",
    "reconnect_timeout_seconds": 45
  }
}
```

Use `45` for active calls and `300` for room-only disconnects.

---

### participant-reconnected

```json
{
  "type": "participant-reconnected",
  "payload": {
    "participant_id": "uuid",
    "must_restart_peer_connection": true
  }
}
```

---

### call-started

```json
{
  "type": "call-started",
  "payload": {
    "call_host_participant_id": "uuid",
    "message": "A call has started. Join the call when ready."
  }
}
```

---

### call-joined

```json
{
  "type": "call-joined",
  "payload": {
    "call_host_participant_id": "uuid",
    "room_status": "NEGOTIATING"
  }
}
```

---

### call-ended

```json
{
  "type": "call-ended",
  "payload": {
    "reason": "HOST_ENDED|PARTICIPANT_LEFT_CALL|PARTICIPANT_LEFT_ROOM|RECONNECT_TIMEOUT|ROOM_DELETED"
  }
}
```

---

### room-deleted

```json
{
  "type": "room-deleted",
  "payload": {
    "reason": "EMPTY_ROOM|HOST_DELETED"
  }
}
```

---

### error

```json
{
  "type": "error",
  "payload": {
    "code": "CALL_ALREADY_STARTED",
    "message": "Call already started, please join the existing call."
  }
}
```

---

# Typed Schemas

Keep schemas aligned with the REST and WebSocket contracts above.

## Backend Pydantic Schemas

File:

```text
backend/app/websocket/schemas.py
```

or split REST schemas into `backend/app/api/schemas.py` if preferred.

```python
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, Field, field_validator

RoomStatusLiteral = Literal[
    "EMPTY",
    "WAITING_FOR_PARTICIPANT",
    "READY_FOR_CALL",
    "CALL_PENDING",
    "NEGOTIATING",
    "IN_CALL",
]

CallStatusLiteral = Literal[
    "IDLE",
    "CALL_PENDING",
    "NEGOTIATING",
    "IN_CALL",
]

ParticipantStatusLiteral = Literal["ACTIVE", "DISCONNECTED"]


class ErrorEnvelope(BaseModel):
    code: str
    message: str


class ErrorResponse(BaseModel):
    error: ErrorEnvelope


class UsernameRequestBase(BaseModel):
    username: str = Field(min_length=1)

    @field_validator("username", mode="before")
    @classmethod
    def validate_username(cls, value: str) -> str:
        trimmed = str(value).strip()
        if not trimmed:
            raise ValueError("Username is required.")
        if len(trimmed) > 40:
            raise ValueError("Username must be 40 characters or fewer.")
        return trimmed


class CreateRoomRequest(UsernameRequestBase):
    pass


class JoinRoomRequest(UsernameRequestBase):
    pass


class ParticipantDTO(BaseModel):
    participant_id: UUID
    username: str
    is_room_host: bool = False
    status: ParticipantStatusLiteral | None = None


class CreateRoomResponse(BaseModel):
    room_code: str
    participant: ParticipantDTO
    participant_token: str
    host_token: str


class JoinRoomResponse(BaseModel):
    room_code: str
    participant: ParticipantDTO
    participant_token: str
    room_status: RoomStatusLiteral
    reserved_participant_count: int


class ReconnectRequest(BaseModel):
    participant_id: UUID
    participant_token: str


class ReconnectResponse(BaseModel):
    participant_id: UUID
    room_code: str
    room_status: RoomStatusLiteral
    call_status: CallStatusLiteral
    reserved_participant_count: int
    must_restart_peer_connection: bool


class LeaveRoomRequest(BaseModel):
    participant_id: UUID
    participant_token: str


class LeaveRoomResponse(BaseModel):
    left: bool
    room_deleted: bool


class DeleteRoomRequest(BaseModel):
    host_token: str


class DeleteRoomResponse(BaseModel):
    deleted: bool


class IceServer(BaseModel):
    urls: list[str]
    username: str | None = None
    credential: str | None = None


class IceServersRequest(BaseModel):
    participant_id: UUID
    participant_token: str


class IceServersResponse(BaseModel):
    ice_servers: list[IceServer]
```

## Backend WebSocket Schemas

```python
class WebSocketMessage(BaseModel):
    type: str
    payload: dict[str, Any] = Field(default_factory=dict)


class HeartbeatPayload(BaseModel):
    participant_id: UUID | None = None


class StartCallPayload(BaseModel):
    participant_id: UUID | None = None


class JoinCallPayload(BaseModel):
    participant_id: UUID | None = None


class EndCallPayload(BaseModel):
    participant_id: UUID | None = None


class MediaConnectedPayload(BaseModel):
    participant_id: UUID | None = None


class OfferPayload(BaseModel):
    sdp: dict[str, Any]


class AnswerPayload(BaseModel):
    sdp: dict[str, Any]


class IceCandidatePayload(BaseModel):
    candidate: str | None = None
    sdpMid: str | None = None
    sdpMLineIndex: int | None = None
    usernameFragment: str | None = None
```

## Frontend TypeScript Types

File:

```text
frontend/src/types/signaling.ts
```

```ts
export type RoomStatus =
  | "EMPTY"
  | "WAITING_FOR_PARTICIPANT"
  | "READY_FOR_CALL"
  | "CALL_PENDING"
  | "NEGOTIATING"
  | "IN_CALL";

export type CallStatus = "IDLE" | "CALL_PENDING" | "NEGOTIATING" | "IN_CALL";

export type ParticipantStatus = "ACTIVE" | "DISCONNECTED";

export type Participant = {
  participant_id: string;
  username: string;
  status: ParticipantStatus;
  is_room_host?: boolean;
};

export type RoomStatePayload = {
  room_status: RoomStatus;
  reserved_participant_count: number;
  capacity: 2;
  participants: Participant[];
  call_status: CallStatus;
  call_host_participant_id: string | null;
};

export type ClientSignalingMessage =
  | { type: "heartbeat"; payload: { participant_id?: string } }
  | { type: "start-call"; payload: { participant_id?: string } }
  | { type: "join-call"; payload: { participant_id?: string } }
  | { type: "end-call"; payload: { participant_id?: string } }
  | { type: "media-connected"; payload: { participant_id?: string } }
  | { type: "offer"; payload: { sdp: RTCSessionDescriptionInit } }
  | { type: "answer"; payload: { sdp: RTCSessionDescriptionInit } }
  | { type: "ice-candidate"; payload: RTCIceCandidateInit };

export type ServerSignalingMessage =
  | { type: "room-state"; payload: RoomStatePayload }
  | { type: "participant-joined"; payload: { participant_id: string; username: string; reserved_participant_count: number } }
  | { type: "participant-left"; payload: { participant_id: string; reserved_participant_count: number; call_ended: boolean } }
  | { type: "participant-disconnected"; payload: { participant_id: string; reconnect_timeout_seconds: number } }
  | { type: "participant-reconnected"; payload: { participant_id: string; must_restart_peer_connection: boolean } }
  | { type: "call-started"; payload: { call_host_participant_id: string; message: string } }
  | { type: "call-joined"; payload: { call_host_participant_id: string; room_status: "NEGOTIATING" } }
  | { type: "call-ended"; payload: { reason: "HOST_ENDED" | "PARTICIPANT_LEFT_CALL" | "PARTICIPANT_LEFT_ROOM" | "RECONNECT_TIMEOUT" | "ROOM_DELETED" } }
  | { type: "room-deleted"; payload: { reason: "EMPTY_ROOM" | "HOST_DELETED" } }
  | { type: "error"; payload: { code: string; message: string } }
  | { type: "offer"; payload: { sdp: RTCSessionDescriptionInit } }
  | { type: "answer"; payload: { sdp: RTCSessionDescriptionInit } }
  | { type: "ice-candidate"; payload: RTCIceCandidateInit };
```

---

# WebRTC Implementation Rules

## Media Requirements

Audio is required.

Video is optional.

Before sending `start-call` or `join-call`, the frontend must successfully acquire required audio media.

If microphone access fails:

- do not send `start-call`;
- do not send `join-call`;
- show a blocking retryable error.

Camera failure may fall back to audio-only.

### Microphone Failure

If microphone permission is denied or no microphone is available:

- do not start/join the call;
- show a blocking error;
- allow the user to retry after granting permission.

Do not continue video-only.

### Camera Failure

If camera permission is denied or no camera is available:

- allow audio-only call;
- show non-blocking warning;
- keep camera toggle disabled until a camera is available.

---

## ICE Candidate Queueing

ICE candidate queueing is purely frontend memory.

The backend must not store candidates.

Frontend algorithm:

```text
on remote ice-candidate received:
  if peerConnection.remoteDescription is set:
    addIceCandidate(candidate)
  else:
    pendingIceCandidates.push(candidate)

on setRemoteDescription success:
  for candidate in pendingIceCandidates:
    addIceCandidate(candidate)
  pendingIceCandidates = []
```

---

## Reconnect Peer Connection Rule

After reconnect, the frontend destroys and recreates `RTCPeerConnection` only if:

- `must_restart_peer_connection` is true in the reconnect response; or
- a local `RTCPeerConnection` already exists and needs cleanup.

If the participant reconnects while only sitting in the room/lobby, or reconnects as a `ROOM_ONLY` participant while another user's call is only `CALL_PENDING`, do not create a peer connection until the user explicitly joins the call.

When recreating a peer connection:

- destroy the existing `RTCPeerConnection`;
- stop old event handlers;
- create a new `RTCPeerConnection`;
- reattach local media tracks;
- restart negotiation from the beginning.

Do not preserve previous signaling state.

Do not attempt to reuse the old peer connection.

---

## Initiator Selection

Initiator selection happens purely on the frontend.

The backend does not assign initiator roles.

Both clients independently compute the same result from the participant list in `room-state`:

```text
initiator = participant with lexicographically lowest participant_id among active room participants
```

Only the initiator creates SDP offers.

The non-initiator waits for an offer and creates an answer.

This avoids implementing full WebRTC perfect negotiation in the core assignment.

`DECISIONS.md` must explain that the perfect negotiation pattern is a future production-grade alternative.

---

## Offer Collision

Because only the deterministic initiator may create offers, offer collision should not occur in the normal implementation.

If a non-initiator attempts to send an offer anyway:

- backend may forward it because signaling server is intentionally dumb about SDP roles;
- frontend must ignore unexpected offers if it is the deterministic initiator and already has a local offer.

---

## Video Toggle

Video toggle is frontend-only media track control.

Implementation:

```text
camera off: localVideoTrack.enabled = false
camera on: localVideoTrack.enabled = true
```

Do not renegotiate just to toggle camera visibility.

If adding a video track after joining audio-only, renegotiation may be needed. For implementation simplicity, acquire audio+video up front where possible, but allow video track disabled.

---

## Mute Toggle

Mute toggle is frontend-only media track control.

Implementation:

```text
muted: localAudioTrack.enabled = false
unmuted: localAudioTrack.enabled = true
```

No backend event required for mute state in this implementation.

---

## ICE Failure Recovery

ICE failure recovery is frontend-only and intentionally simple in the core build.

If frontend receives:

```text
iceConnectionState === "failed"
```

Then:

1. show degraded/failed connection state;
2. close current `RTCPeerConnection`;
3. stop local call media/handlers for the failed call;
4. let the user leave and rejoin the call to renegotiate from a clean state.

Do not send an ICE failure event to the backend in the core implementation.

Do not implement coordinated remote peer connection recreation in the core implementation.

`DECISIONS.md` must mention that production could report ICE failures to the backend for analytics, debugging, coordinated call teardown, and coordinated peer-connection recreation across both clients.

---

# Explicit Sequence Flows

## Create Room Flow

```text
1. User enters username.
2. Frontend POST /rooms with username.
3. Backend creates room with random non-guessable room_code.
4. Backend creates first participant.
5. Backend assigns first participant as room host.
6. Backend stores hashed participant_token and host_token.
7. Backend returns room_code, participant_id, participant_token, host_token.
8. Frontend constructs shareable room URL.
9. Frontend opens WebSocket with participant credentials.
10. Backend sends room-state.
```

---

## Join Room Flow

```text
1. User opens /room/{room_code}.
2. User enters username.
3. Frontend POST /rooms/{room_code}/join.
4. Backend validates room exists.
5. Backend counts active + disconnected participants still within reconnect windows.
6. If count >= 2, return 409 ROOM_FULL.
7. Backend creates participant.
8. Backend recomputes room status.
9. Backend returns participant_id and participant_token.
10. Frontend opens WebSocket.
11. Backend broadcasts participant-joined.
12. Backend sends room-state to both participants.
```

---

## Start Call Flow

```text
1. Participant clicks Start Call.
2. Frontend acquires required audio media before signaling.
3. If microphone access fails, frontend shows a blocking retryable error and does not send `start-call`.
4. Frontend sends start-call over WebSocket.
5. Backend atomically checks current call state.
6. If no call exists, backend sets call state to CALL_PENDING.
7. Backend sets call_host_participant_id to sender.
8. Backend broadcasts call-started.
9. Call host may show local call UI immediately.
10. Other participant sees Join Call button.
```

---

## Simultaneous Start Call Flow

```text
1. Participant A sends start-call.
2. Participant B sends start-call nearly simultaneously.
3. Backend handles requests inside a Postgres transaction with `SELECT ... FOR UPDATE` on the room row.
4. First request sets state to CALL_PENDING.
5. Second request sees existing call state.
6. Backend sends error to second sender:
   CALL_ALREADY_STARTED: Call already started, please join the existing call.
7. Second sender UI shows Join Call action.
```

---

## Join Existing Call Flow

```text
1. Non-host participant clicks Join Call.
2. Frontend acquires required audio media before signaling.
3. If microphone access fails, frontend shows a blocking retryable error and does not send `join-call`.
4. Frontend sends join-call.
5. Backend validates room has active call pending.
6. Backend transitions CALL_PENDING -> NEGOTIATING.
7. Backend broadcasts call-joined.
8. Both frontends fetch ICE servers if not already fetched.
9. Both frontends create RTCPeerConnection.
10. Both frontends compute deterministic initiator locally.
11. Initiator creates offer.
12. Offer forwarded over WebSocket.
13. Non-initiator sets remote description.
14. Non-initiator flushes queued ICE if any.
15. Non-initiator creates answer.
16. Answer forwarded over WebSocket.
17. Initiator sets remote description.
18. Initiator flushes queued ICE if any.
19. ICE candidates continue to flow.
20. On connection established, UI shows Connected.
21. After the answer is forwarded, SDP exchange is complete, but backend remains `NEGOTIATING`.
22. Each frontend sends `media-connected` after ICE reaches connected/completed.
23. Backend transitions `NEGOTIATING -> IN_CALL` only after both active call participants report media connected.
```

---

## Leave Call Flow

```text
1. User clicks End Call if they are the call host, or Leave Call if they are not the call host.
2. Frontend sends end-call over WebSocket.
3. Backend validates sender is an active participant in the current call.
4. Backend ends the active call for both participants.
5. Backend keeps both participants in the room.
6. Backend transitions room status to READY_FOR_CALL if both participants remain active.
7. Backend broadcasts call-ended with HOST_ENDED or PARTICIPANT_LEFT_CALL.
8. Frontend stops/cleans up peer connection and media tracks for the call, but keeps the room WebSocket open.
```

---

## Explicit Leave Room Flow

```text
1. User clicks Leave Room.
2. If frontend knows there are no other ACTIVE or DISCONNECTED-within-reconnect-window participants, show final participant prompt.
3. If user cancels, do nothing.
4. If user confirms, POST /rooms/{room_code}/leave.
5. Backend validates participant token.
6. Backend ends active call if present.
7. Backend removes participant.
8. If no participants remain, delete room.
9. Backend broadcasts participant-left or room-deleted.
10. Frontend closes WebSocket and media tracks.
```

---

## WebSocket Disconnect Flow

```text
1. WebSocket disconnects unexpectedly.
2. ConnectionManager removes raw socket.
3. SignalingService marks participant DISCONNECTED through RoomService.
4. RoomService determines participant-specific timeout type:
   - 45 seconds if the participant is in `ACTIVE_CALL` context
   - 300 seconds if the participant is in `ROOM_ONLY` context
5. RoomService writes `reconnect_deadline_at` and `disconnect_context` to Postgres.
6. SignalingService broadcasts participant-disconnected.
7. SignalingService also broadcasts room-state, including the disconnected participant with status `DISCONNECTED` while their reconnect window is active.
8. Background cleanup removes participant if deadline expires.
```

---

## Reconnect Flow

```text
1. Browser refreshes or network reconnects.
2. Frontend still has participant_id and participant_token in `sessionStorage`.
3. Frontend POST /rooms/{room_code}/reconnect.
4. Backend validates token and reconnect deadline, or treats the request as an idempotent restore if the participant is already ACTIVE.
5. Backend marks participant ACTIVE if they were DISCONNECTED.
6. Backend computes must_restart_peer_connection using participant-specific reconnect/session-restore context.
7. Frontend opens new WebSocket after successful reconnect/session restore.
8. Backend broadcasts participant-reconnected only if the participant was previously DISCONNECTED, then broadcasts room-state.
9. If must_restart_peer_connection is true, or if a local peer connection already exists, frontend destroys the old RTCPeerConnection if any.
10. Frontend creates a new RTCPeerConnection only when needed for an active/pending/negotiating call.
11. Frontend restarts negotiation from the beginning only when must_restart_peer_connection is true.
```

---

# Background Cleanup

Use FastAPI lifespan-managed background tasks.

Implement in:

```text
backend/app/core/background_tasks.py
```

Start tasks from FastAPI lifespan in `main.py`.

Use `asyncio.create_task(...)` internally and cancel tasks cleanly on shutdown.

Do not use Celery/APScheduler for this take-home.

Do not use per-request `BackgroundTasks` for infinite cleanup loops.

## Cleanup Loops

### Heartbeat Cleanup

Runs every `CLEANUP_INTERVAL_SECONDS`.

Heartbeat stale cleanup must use the same `RoomService.mark_participant_disconnected` logic as WebSocket disconnect.

Logic:

```text
for each ACTIVE participant in Postgres:
  if now - last_seen_at > HEARTBEAT_STALE_AFTER_SECONDS:
    begin transaction
    SELECT room FOR UPDATE
    SELECT participant FOR UPDATE
    if participant is no longer ACTIVE, no-op
    compute disconnect_context from participant-specific active-call participation
    set disconnected_at, reconnect_deadline_at, and disconnect_context
    commit
    broadcast participant-disconnected and room-state after commit
```

### Reconnect Expiration Cleanup

Runs every `CLEANUP_INTERVAL_SECONDS`.

Logic:

```text
for each participant where reconnect_deadline_at is not null:
  if now > reconnect_deadline_at:
    remove participant from room
    if participant was in active call:
      end call
    do not transfer room host
    recompute room state
    if room empty:
      delete room
    else:
      broadcast room-state
```

---

# Frontend State Model

Use a reducer.

```ts
type RoomStatus =
  | "EMPTY"
  | "WAITING_FOR_PARTICIPANT"
  | "READY_FOR_CALL"
  | "CALL_PENDING"
  | "NEGOTIATING"
  | "IN_CALL";

type CallStatus = "IDLE" | "CALL_PENDING" | "NEGOTIATING" | "IN_CALL";

type RoomState = {
  roomCode: string;
  participantId: string;
  participantToken: string;
  username: string;
  reservedParticipantCount: number;
  capacity: 2;
  roomStatus: RoomStatus;
  callStatus: CallStatus;
  callHostParticipantId: string | null;
  participants: Participant[];
  connectionStatus: "idle" | "connecting" | "connected" | "reconnecting" | "failed";
  isMuted: boolean;
  isCameraEnabled: boolean;
  error: string | null;
};
```

Media toggle state is frontend-only.

Do not persist mute/camera state to backend.

## Browser Storage

Store `room_code`, `participant_id`, `participant_token`, and `host_token` in `sessionStorage` only.

Use `sessionStorage` so refresh/reconnect works during the current browser session without persisting room access tokens across browser restarts.

Do not use `localStorage` for participant or host tokens in the core build.

`DECISIONS.md` must mention that production room persistence across browser restarts would require a more deliberate design, such as short-lived refreshable room session tokens, account-backed room membership, or explicit "remember this room" behavior with token rotation.

---

# Frontend Reducer Actions

File:

```text
frontend/src/state/roomReducer.ts
```

Use reducer actions that mirror server events and local media state.

```ts
import type { Participant, RoomStatePayload } from "../types/signaling";

type ConnectionStatus = "idle" | "connecting" | "connected" | "reconnecting" | "failed";

type RoomAction =
  | { type: "ROOM_STATE_RECEIVED"; payload: RoomStatePayload }
  | { type: "PARTICIPANT_JOINED"; payload: { participant_id: string; username: string; reserved_participant_count: number } }
  | { type: "PARTICIPANT_LEFT"; payload: { participant_id: string; reserved_participant_count: number; call_ended: boolean } }
  | { type: "PARTICIPANT_DISCONNECTED"; payload: { participant_id: string; reconnect_timeout_seconds: number } }
  | { type: "PARTICIPANT_RECONNECTED"; payload: { participant_id: string; must_restart_peer_connection: boolean } }
  | { type: "CALL_STARTED"; payload: { call_host_participant_id: string; message: string } }
  | { type: "CALL_JOINED"; payload: { call_host_participant_id: string; room_status: "NEGOTIATING" } }
  | { type: "CALL_ENDED"; payload: { reason: string } }
  | { type: "ROOM_DELETED"; payload: { reason: string } }
  | { type: "SET_CONNECTION_STATUS"; payload: ConnectionStatus }
  | { type: "SET_MUTED"; payload: boolean }
  | { type: "SET_CAMERA_ENABLED"; payload: boolean }
  | { type: "SET_LOCAL_STREAM"; payload: MediaStream | null }
  | { type: "SET_REMOTE_STREAM"; payload: MediaStream | null }
  | { type: "SET_MEDIA_WARNING"; payload: string | null }
  | { type: "SET_ERROR"; payload: string | null };
```

## Reducer Rules

- `ROOM_STATE_RECEIVED` replaces canonical room/call state from backend.
- `PARTICIPANT_DISCONNECTED` should not remove the participant immediately; show reconnecting/offline UI until timeout or room-state update.
- `CALL_ENDED` clears local/remote media streams and resets call UI but does not clear room membership.
- `ROOM_DELETED` clears room state and navigates the user out of the room.
- `SET_MUTED` and `SET_CAMERA_ENABLED` are frontend-only; do not send these states to backend.
- Usernames must be rendered as text, not HTML.

---

# Frontend Hook Boundaries

## `useRoom`

Owns REST room actions:

- create room;
- join room;
- reconnect;
- leave room;
- fetch room state;
- fetch ICE servers.

## `useWebSocket`

Owns signaling transport:

- connect websocket;
- send signaling events;
- receive websocket events;
- reconnect websocket;
- close websocket;
- heartbeat interval.

Does not own `RTCPeerConnection`.

## `useWebRTC`

Owns peer connection:

- create `RTCPeerConnection`;
- fetch/use ICE server config;
- get local media;
- attach tracks;
- create offer/answer;
- set local/remote descriptions;
- queue ICE candidates until remote description is set;
- close peer connection;
- restart negotiation after reconnect;
- handle ICE failure by closing the failed peer connection and prompting the user to leave/rejoin the call.

Does not own room membership.

## `useMediaDevices`

Owns media permissions and device errors:

- microphone required;
- camera optional;
- audio-only fallback if camera fails;
- blocking error if microphone fails.

---

# Testing Plan

## Unit Tests

### RoomService

- create room creates host participant.
- join room succeeds when one participant exists.
- join room rejects third participant with `ROOM_FULL`.
- leave room ends active call.
- final participant leave deletes room.
- room host deletion deletes room even if host is not connected.
- room host does not transfer when host expires after reconnect timeout.
- active call disconnect uses 45-second timeout.
- room-only disconnect uses 5-minute timeout.
- during `CALL_PENDING`, call host disconnect uses 45-second timeout and non-host room participant disconnect uses 5-minute timeout.
- reconnect is idempotent when participant is already ACTIVE.
- reconnecting a `ROOM_ONLY` participant during `CALL_PENDING` does not move the room to `NEGOTIATING`.

### SignalingService

- first `start-call` wins.
- second simultaneous `start-call` receives `CALL_ALREADY_STARTED`.
- `offer` forwards to other participant.
- `answer` forwards to other participant and keeps backend status `NEGOTIATING` until media connection is reported.
- `ice-candidate` forwards to other participant.
- `media-connected` transitions `NEGOTIATING -> IN_CALL` only after both participants report connected.
- `end-call` from either active call participant ends the call for both while keeping both in the room.
- `end-call` from a non-call participant during `CALL_PENDING` is an idempotent no-op.
- `call-rejected` is not handled and does not exist in schema.

### IceService

- returns STUN config.
- omits TURN server when not configured.
- returns TURN credentials only from backend endpoint.

---

## Integration Tests

- POST /rooms returns room_code, participant_id, participant_token, host_token.
- POST /rooms/{room_code}/join accepts username.
- POST /rooms/{room_code}/join returns `ROOM_FULL` for third user.
- POST /rooms/{room_code}/ice-servers validates participant token and returns valid ICE server shape.
- POST /rooms/{room_code}/reconnect succeeds within timeout.
- POST /rooms/{room_code}/delete with host_token deletes room.
- GET /rooms/{room_code} after deletion returns 404.

---

## WebSocket Tests

- websocket rejects invalid participant token with close code 4401.
- websocket rejects DISCONNECTED participant until REST reconnect succeeds.
- websocket sends initial room-state.
- websocket broadcasts participant-joined.
- websocket broadcasts participant-disconnected.
- websocket broadcasts participant-reconnected.
- websocket forwards offer/answer/ice-candidate.
- websocket accepts a duplicate valid connection, closes the old socket with 4429, and keeps participant ACTIVE.
- websocket sends error for second simultaneous start-call.
- websocket broadcasts room-deleted before closing when room is deleted.

---

# Test Fixtures and Mocks

Add these fixtures to make tests deterministic and CODEX-friendly.

## Backend Fixtures

```text
test_session
  Async SQLAlchemy session wrapped in transaction rollback per test.

test_client
  FastAPI HTTP client using the test database.

room_with_one_participant
  Room with one ACTIVE participant, participant_token, and host_token.

room_with_two_participants
  Room with two ACTIVE participants and both participant tokens.

room_with_pending_call
  Room with two participants and call_status CALL_PENDING.

room_in_negotiation
  Room with two participants and call_status NEGOTIATING.

disconnected_active_call_participant
  Participant with DISCONNECTED status and reconnect_deadline_at = now + 45 seconds.

disconnected_room_only_participant
  Participant with DISCONNECTED status and reconnect_deadline_at = now + 300 seconds.

expired_disconnected_participant
  Participant with DISCONNECTED status and reconnect_deadline_at in the past.

fake_connection_manager
  In-memory fake that records sent/broadcast websocket messages without real sockets.
```

## WebSocket Test Helpers

```text
connect_participant_ws(room_code, participant_id, participant_token)
  Opens a websocket using the same query parameter contract as production.

collect_ws_messages(ws, count, timeout)
  Reads a bounded number of messages for assertions.

assert_broadcast(fake_connection_manager, room_code, event_type)
  Verifies that a broadcast event was emitted.

assert_sent_to_participant(fake_connection_manager, participant_id, event_type)
  Verifies that a participant-specific event was emitted.
```

## Frontend Mocks

Mock browser APIs in frontend tests where needed:

- `RTCPeerConnection`
- `RTCSessionDescription`
- `RTCIceCandidate`
- `MediaStream`
- `MediaStreamTrack`
- `navigator.mediaDevices.getUserMedia`
- native `WebSocket`

## Time Control

Use a frozen-time helper or monkeypatchable clock abstraction for reconnect tests.

Required scenarios:

- 44 seconds after active-call disconnect: participant still reserves slot.
- 46 seconds after active-call disconnect: participant expires and call ends.
- 299 seconds after room-only disconnect: participant still reserves slot.
- 301 seconds after room-only disconnect: participant expires and may free room slot.

---

# Environment Variables

## Backend

```env
DATABASE_URL=postgresql+asyncpg://postgres:postgres@db:5432/minirtc
# REDIS_URL=redis://redis:6379  # optional future scaling improvement, not required for core build
STUN_SERVER_URL=stun:stun.l.google.com:19302
TURN_SERVER_URL=
TURN_USERNAME=
TURN_PASSWORD=
CORS_ALLOWED_ORIGINS=http://localhost:5173
ROOM_CODE_LENGTH=12
TOKEN_HASH_SECRET=change-me-for-local-development
```

## Frontend

```env
VITE_API_BASE_URL=http://localhost:8000
VITE_WS_BASE_URL=ws://localhost:8000
```

Do not put TURN credentials in frontend env vars.

Redis is intentionally optional for the core build. If added later, document the scaling rationale and failure behavior in `DECISIONS.md`.

---

# DECISIONS.md Required Sections

`DECISIONS.md` must include these sections.

## 1. Why WebSocket Signaling

Explain:

- WebRTC needs signaling but does not define signaling transport.
- WebSockets provide low-latency bidirectional communication.
- REST is used for room creation/join because it gives clean HTTP errors such as `ROOM_FULL`.
- WebSocket is used after membership is established.
- Browser WebSocket APIs cannot set arbitrary auth headers, so this core build passes participant credentials in query parameters. Production should mint short-lived one-time WebSocket tokens to reduce exposure in logs.

---

## 2. Why Peer-to-Peer WebRTC

Explain:

- For 1:1 calls, peer-to-peer is simpler and cheaper than SFU/MCU.
- Backend does not carry audio/video media.
- Backend only coordinates signaling and presence.

---

## 3. Account Authorization Decision

Implementation does not include full account creation/login.

Explain:

- The assignment asks for minimal security and non-guessable/validated room IDs.
- Full auth would add significant scope unrelated to the core realtime/WebRTC challenge.
- Instead, implementation uses:
  - cryptographically random room codes;
  - opaque participant tokens;
  - hashed participant tokens in DB;
  - host token for room deletion.

Future account authorization design:

- user table with email, password hash, display name;
- password hashing with bcrypt/argon2;
- login endpoint returning JWT;
- protected room creation;
- room membership tied to user IDs;
- short-lived WebSocket tokens minted via REST;
- refresh token handling;
- rate limiting and abuse prevention;
- audit logging for room deletion.

---

## 4. Why No Waitlist

Implementation rejects third joiner with `ROOM_FULL`.

Explain:

- The product is explicitly 1:1.
- Waitlists add extra state, fairness rules, promotion logic, and edge cases.
- For a take-home, core WebRTC correctness is higher priority.

Future waitlist design:

- Redis queue per room;
- queue position updates;
- automatic promotion when a slot opens;
- reconnect position preservation;
- timeout cleanup for stale waitlisted users.

---

## 5. STUN/TURN and NAT Traversal

Explain:

- STUN helps peers discover public reflexive addresses.
- TURN relays media when direct peer-to-peer connection fails.
- TURN can become expensive because it carries media bandwidth.
- Production would use coturn or managed TURN.
- Credentials should be short-lived and fetched from an authenticated backend endpoint.
- The core implementation validates participant credentials before returning ICE server config.
- Production should generate short-lived TURN credentials dynamically when possible.

---

## 6. Why Redis Is Not Required for the Core Build

Explain:

- The take-home can run as a single backend process with Postgres as source of truth and an in-memory WebSocket connection manager.
- Avoiding Redis keeps local setup and implementation complexity lower.
- Postgres row locks are sufficient for room capacity and simultaneous call-start atomicity at this scale.
- Redis becomes useful when the app needs multiple WebSocket workers, cross-instance fanout, high-frequency presence, or very high room churn.
- If Redis is added later, it should be ephemeral and recoverable from Postgres.

---

## 7. Scaling to 10k Rooms/Day

Discuss what breaks:

- single-process websocket memory;
- in-memory connection manager;
- Redis hot keys if room churn is high;
- TURN bandwidth cost;
- Postgres write volume from presence updates if overused.

How to scale:

- keep presence in Redis, not Postgres;
- use Redis pub/sub for multi-instance websocket fanout;
- shard rooms by room_code;
- avoid writing every heartbeat to Postgres;
- autoscale websocket workers;
- use managed TURN carefully with usage limits.

---

## 8. Perfect Negotiation Future Improvement

Implementation uses deterministic frontend initiator selection.

Future production approach:

- use WebRTC perfect negotiation pattern;
- assign polite/impolite peers;
- handle offer collisions more robustly;
- support symmetric renegotiation;
- better support track additions like screen sharing.

---

## 9. Screen Sharing Future Improvement

Not implemented.

Discuss:

- requires additional media track;
- may require renegotiation;
- UI must distinguish camera vs screen track;
- permissions and browser behavior differ;
- more offer/answer collision risk;
- perfect negotiation becomes more valuable.

---

## 10. Persistent Call History Future Improvement

Not implemented.

Future design:

- calls table;
- started_at/ended_at;
- ended_reason;
- participant snapshots;
- analytics and debugging value.

---

## 11. Request Correlation IDs Future Improvement

Not implemented.

Future design:

- include `request_id` in websocket messages;
- correlate errors and acknowledgements;
- easier debugging under packet loss/retry conditions.

---

## 12. ICE Failure Reporting and Coordinated Recovery Future Improvement

Core implementation keeps ICE failure recovery frontend-only and simple: the user can leave/rejoin the call after a failed connection instead of the backend coordinating recovery.

Future production design:

- frontend reports ICE failures to backend;
- backend stores aggregate failure metrics for debugging;
- backend can coordinate call teardown or renegotiation across both clients;
- backend can notify the remote peer to close and recreate its `RTCPeerConnection`;
- clients can perform a coordinated ICE restart or full peer-connection recreation using request/correlation IDs;
- failure analytics can inform TURN provisioning and network-quality improvements.

## 13. Browser Session Storage and Room Persistence

Core implementation stores room credentials in `sessionStorage`, not `localStorage`.

Explain:

- `sessionStorage` supports refresh/reconnect within the current tab session;
- it avoids persisting room access tokens across browser restarts;
- this is safer for a no-account take-home implementation.

Future production options for room persistence across browser restarts:

- account-backed room membership;
- short-lived refreshable room session tokens;
- explicit "remember this room" UX;
- token rotation and revocation;
- short-lived one-time WebSocket tokens derived from a room session.

---

# README.md Required Notes

`README.md` must include:

- how to run backend, frontend, Postgres, and migrations locally;
- how to apply Alembic migrations;
- how to test with two tabs or two browsers;
- a note that microphone access requires `localhost` or HTTPS;
- a note that deployed WebRTC requires HTTPS and WSS;
- a note that calls may fail across restrictive networks if TURN is not configured;
- what was built;
- what was skipped;
- optional deployment instructions if deployment is completed.

---

# Local Development, Tooling, and CI Commands

## Backend Setup

Recommended backend files:

```text
backend/pyproject.toml
backend/alembic.ini
backend/app/
backend/tests/
```

Suggested commands:

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
alembic upgrade head
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

## Frontend Setup

```bash
cd frontend
npm install
npm run dev
```

## Docker Compose

`docker-compose.yml` should run at minimum:

- Postgres
- backend
- frontend

Redis is optional and should not be required for the core build.

Suggested commands:

```bash
docker compose up --build
```

## Migrations

Use Alembic for schema changes.

```bash
cd backend
alembic revision --autogenerate -m "initial schema"
alembic upgrade head
```

Do not rely on `Base.metadata.create_all()` for the submitted implementation.

## Backend Quality Commands

```bash
cd backend
ruff check .
ruff format --check .
pytest
```

If mypy is configured:

```bash
mypy app tests
```

## Frontend Quality Commands

```bash
cd frontend
npm run lint
npm run typecheck
npm run build
```

## Suggested CI Pipeline

Run on pull request or push:

```text
1. Start Postgres service.
2. Install backend dependencies.
3. Run Alembic migrations.
4. Run backend lint.
5. Run backend tests.
6. Install frontend dependencies.
7. Run frontend lint/typecheck.
8. Run frontend build.
```

## Manual Local Verification

README should instruct reviewers to test with:

```text
1. Open browser tab A.
2. Create room with username Alice.
3. Copy room URL.
4. Open browser tab B or a second browser.
5. Join with username Bob.
6. Start call from Alice.
7. Join call from Bob.
8. Verify audio/video connection.
9. Toggle mute and camera.
10. Refresh one tab and verify reconnect behavior.
11. Try third joiner and verify ROOM_FULL.
12. Leave call and verify room remains open.
13. Leave room as final participant and verify delete prompt.
```

---

# Implementation Order

## Phase 1: Backend Room Basics

1. Create FastAPI app.
2. Add Postgres models.
3. Add Alembic configuration and initial migration.
4. Add room repository.
5. Add room service.
6. Implement POST /rooms.
7. Implement POST /rooms/{room_code}/join.
8. Implement GET /rooms/{room_code}.
9. Implement POST /rooms/{room_code}/delete.
10. Add tests for room creation, join, room full, deletion.

## Phase 2: WebSocket Signaling

1. Add ConnectionManager.
2. Add SignalingService.
3. Add websocket endpoint.
4. Add websocket close codes.
5. Add room-state event.
6. Add start-call/join-call/end-call.
7. Add offer/answer/ice-candidate forwarding.
8. Add media-connected event and IN_CALL transition after both clients report connected.
9. Add websocket tests.

## Phase 3: Reconnect and Cleanup

1. Add heartbeat events.
2. Store `last_seen_at`, `disconnected_at`, `reconnect_deadline_at`, and `disconnect_context` in Postgres.
3. Add reconnect REST endpoint.
4. Add FastAPI lifespan background cleanup tasks.
5. Add 45-second active call timeout.
6. Add 5-minute room-only timeout.
7. Confirm room host does not transfer on expired host disconnect.
8. Add tests.

## Phase 4: Frontend

1. Create minimal React app.
2. Add create/join room UI.
3. Add room page.
4. Add websocket hook.
5. Add WebRTC hook.
6. Add media device handling.
7. Add Start Call / Join Call UI.
8. Add mute/video toggles.
9. Add End Call / Leave Call behavior distinct from Leave Room.
10. Add connection status based on RTCPeerConnection state.
11. Add UI copy explaining reconnect-reserved slots when room is temporarily full.
12. Add final participant leave prompt.

## Phase 5: Docs and Polish

1. Write README with local testing, HTTPS/WSS, microphone, TURN, and migration notes.
2. Write DECISIONS.md.
3. Add Docker Compose.
4. Add tests to CI.
5. Add optional deployment last.


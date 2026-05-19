# MiniRTC Decisions

## 1. Why WebSocket Signaling

WebRTC handles peer-to-peer media, but it does not define how peers discover each other or exchange SDP offers, answers, and ICE candidates. MiniRTC uses REST for room creation/join because those flows benefit from normal HTTP status codes such as `404 ROOM_NOT_FOUND` and `409 ROOM_FULL`. After membership is established, WebSockets provide low-latency bidirectional signaling and presence events.

Browser WebSocket APIs cannot set arbitrary auth headers, so this core build passes participant credentials in query parameters. In production I would mint short-lived one-time WebSocket tokens over REST to reduce token exposure in logs and browser tooling.

## 2. Why Peer-To-Peer WebRTC

For a 1:1 call, peer-to-peer WebRTC is simpler and cheaper than routing media through an SFU or MCU. The backend never carries audio or video; it coordinates room state, presence, and signaling only. That keeps compute and bandwidth costs much lower for this assignment.

## 3. Account Authorization Decision

The assignment asks for minimal security and non-guessable or validated room IDs. Full accounts would add substantial scope outside the realtime/WebRTC challenge, so this implementation uses cryptographically random room codes, opaque participant tokens, hashed token storage, and a separate host token for room deletion.

A production account model would add users, password hashing with bcrypt or Argon2, login, JWT or session handling, protected room creation, room membership tied to user IDs, short-lived WebSocket tokens, refresh-token handling, rate limiting, abuse prevention, and audit logs for room deletion.

## 4. Why No Waitlist

MiniRTC is explicitly 1:1. A third joiner receives `ROOM_FULL`, including while a disconnected participant is still inside the reconnect window. Waitlists add queue fairness, promotion rules, reconnect position preservation, stale-entry cleanup, and more UI states. For this assignment, WebRTC correctness and room-state clarity matter more.

Future waitlists could use a Redis queue per room, queue position events, automatic promotion when a slot opens, and stale waitlist timeout cleanup.

## 5. STUN/TURN And NAT Traversal

STUN helps peers discover public reflexive addresses. TURN relays media when direct peer-to-peer connectivity fails, which is necessary on restrictive NATs and corporate networks. TURN can become expensive because it carries media bandwidth.

This implementation always returns STUN from the backend and optionally returns TURN credentials if configured. Production should use coturn or managed TURN, generate short-lived credentials dynamically, enforce usage limits, and monitor relay bandwidth.

## 6. Why Redis Is Not Required For The Core Build

The local take-home app runs as a single backend process. Postgres is the durable source of truth for rooms, participants, call state, reconnect deadlines, and token hashes. The in-memory connection manager stores only live WebSocket objects. Postgres row locks are enough for two-person capacity and simultaneous call-start atomicity at this scale.

Redis becomes useful for multiple WebSocket workers, cross-instance fanout, high-frequency presence, and high room churn. If added later, Redis should remain ephemeral and recoverable from Postgres.

## 7. Scaling To 10k Rooms/Day

The first pressure points would be single-process WebSocket memory, in-memory fanout, Postgres writes from frequent heartbeat updates, room churn, and TURN bandwidth. Costs stay sane by keeping media peer-to-peer when possible, using TURN only when needed, limiting TURN bandwidth, batching or moving presence to Redis, and scaling WebSocket workers horizontally.

A scaled version would use Redis pub/sub for cross-instance room fanout, room-code based sharding, presence in Redis instead of Postgres heartbeat writes, autoscaled WebSocket workers, managed Postgres, and careful TURN observability.

## 8. Perfect Negotiation Future Improvement

This implementation avoids offer collision by deterministically choosing the frontend initiator: the active participant with the lexicographically lowest participant ID creates offers. Production should use the WebRTC perfect negotiation pattern with polite/impolite peers, better collision handling, and symmetric renegotiation support.

## 9. Screen Sharing Future Improvement

Screen sharing is not implemented. It would add a separate media track, browser permission states, UI for distinguishing camera versus screen tracks, and likely renegotiation. Perfect negotiation becomes more important once either peer can add or replace tracks.

## 10. Persistent Call History Future Improvement

Calls are not persisted after the room disappears. Production could add a calls table with `started_at`, `ended_at`, end reason, participant snapshots, and diagnostic metadata. That would help analytics, billing, support, and debugging.

## 11. Request Correlation IDs Future Improvement

WebSocket messages do not include request correlation IDs. A production protocol should include `request_id` values so clients can correlate acknowledgements and errors, especially under retries, reconnects, or packet loss.

## 12. ICE Failure Reporting And Coordinated Recovery Future Improvement

The core build keeps ICE failure recovery frontend-only: the failed peer connection is closed and the user can leave/rejoin the call. Production could report ICE failures to the backend for analytics, notify the remote peer, coordinate peer-connection recreation, perform ICE restarts, and use request IDs to make recovery observable.

## 13. Browser Session Storage And Room Persistence

The frontend stores room credentials in `sessionStorage`, not `localStorage`. This supports refresh/reconnect inside the current tab session without persisting room access tokens across browser restarts.

Production persistence could use account-backed room membership, short-lived refreshable room session tokens, explicit "remember this room" behavior, token rotation, revocation, and one-time WebSocket tokens derived from the room session.


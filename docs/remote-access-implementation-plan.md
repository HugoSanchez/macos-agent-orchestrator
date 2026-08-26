# Verso Remote Access — Implementation Plan

Status: final planning recommendation, reviewed with Claude Code Fable 5. Detailed protocol schemas and threat-model artifacts are Phase 0 deliverables.

## Objective

Let a user pair a phone with Verso on their Mac by scanning a QR code, then list/create sessions, send messages, observe live agent activity, reconnect after network changes, and cancel or approve a run from anywhere in the world. The Mac remains the source of truth and performs all agent work. If the Mac is asleep, offline, signed out, or Verso is not running, the phone reports it as unavailable.

## Product and trust decisions

1. Remote Access is explicit opt-in and requires a Verso account on both Mac and phone. Anonymous relaying is rejected because it complicates abuse prevention, recovery, and revocation.
2. Local mode remains local by default. Enabling Remote Access is a separately disclosed capability that contacts the Verso control plane, while inference, provider credentials, chats, memory, and tools remain on the Mac.
3. Do not expose the orchestrator or Hermes on a LAN/public interface. They remain bound to loopback and retain the current launch-scoped sidecar token.
4. The hosted relay is an untrusted transport for content. Command and event payloads are end-to-end encrypted between each paired phone and the Mac. The relay sees routing metadata, sizes, timing, and online state, but not chat content or tool output.
5. Initially expose only a versioned remote API: host presence, session list/read/create, prompt submission, turn status/events, cancellation, and narrow approval responses. No arbitrary HTTP proxy, session mutation, settings mutation, provider credentials, connector management, filesystem API, browser control, or raw Hermes RPC.
6. Mobile can deny or approve a dangerous action once, protected by device authentication (Face ID/passcode). Persistent approvals such as “always allow” require the Mac UI.
7. Offline commands are not queued in the cloud. If the host is offline, commands fail visibly. This prevents stale prompts or approvals from executing hours later.

## Existing functionality to reuse

### Verso

- `desktop/orchestrator` already owns product session IDs, a local SQLite chat store, HTTP endpoints for sessions/messages/cancel, and SSE translation for Hermes events.
- The sidecar already has a strong per-launch loopback token and strict loopback Host/CORS checks. Keep this boundary unchanged.
- The browser shell already demonstrates that session navigation can be driven without the Swift shell.
- The managed backend already has Privy exchange, users, devices, long-lived revocable app sessions, and Postgres/Drizzle persistence.
- The macOS app already stores its managed session in Keychain and can supply short-lived runtime data to the sidecar.

### Hermes

Verso pins Hermes 0.19.0 commit `3ef6bbd201263d354fd83ec55b3c306ded2eb72a` and currently uses its OpenAI-compatible `/v1/responses` SSE endpoint.

The pinned Hermes runtime also provides `/v1/runs`:

- `POST /v1/runs` starts work asynchronously and returns `run_id` with HTTP 202.
- `GET /v1/runs/{run_id}` returns pollable queued/running/waiting/completed/failed/cancelled state and retains terminal state for a bounded period.
- `GET /v1/runs/{run_id}/events` streams message deltas, tool lifecycle, reasoning, approval requests, and terminal events.
- `POST /v1/runs/{run_id}/approval` resolves approval choices.
- `POST /v1/runs/{run_id}/stop` interrupts a run.

Hermes also ships `hermes serve`, a JSON-RPC/WebSocket integration with session create/list/resume/history/status/interrupt and richer event/approval flows. It is valuable but switching Verso's existing session ownership to it would be a larger migration. Decision: keep the orchestrator as Verso's stable product boundary and use `/v1/runs`, after bringing it to feature parity with Verso's current `/v1/responses` integration. The pinned run API currently needs Hermes patches for rich tool arguments/results, reasoning deltas and effort, image input/history, recoverable pending-approval details, and a capped per-run approval-timeout override. Hermes already has a global approval timeout, but changing it would affect every approval surface. Budget and upstream the focused run-API changes in Phase 0. A `/v1/responses` fallback is useful only for local detached-turn work; it cannot ship remote approvals and is not the Remote Access plan of record.

Hermes' event SSE is a single-consumer queue, not a replay log: once its subscriber disconnects, the stream is destroyed and cannot be reattached. Therefore `ChatTurnService` must attach immediately, remain the sole subscriber, and persist a small, bounded Verso event journal. If that local stream itself drops, record a gap marker and poll run status for the terminal result; never pretend missing deltas were recovered. Phase 0 also makes a pending approval pollable—with its stable ID, redacted command, choices, and deadline—so a dropped stream does not strand a run waiting for an approval nobody can display. Hermes remains the transcript/final-result recovery source; the journal exists for reconnectable UX, not as another agent database.

## Proposed architecture

```text
 iOS app
   |  TLS WebSocket + encrypted envelopes
   v
 Verso relay (one logical room per Mac host)
   ^
   |  outbound TLS WebSocket + encrypted envelopes
 Native macOS RemoteAccessManager
   |  (owns relay socket, device keys, HPKE)
   |
   +--> loopback remote bridge using existing launch token
           |
           +--> RemoteCommandRouter (strict allowlist, auth context, validation)
                   |
                   +--> ChatTurnService + local event journal
                            |
                            +--> Hermes /v1/runs + SSE/status/stop/approval on loopback
                            +--> existing ChatStore / Hermes history recovery
```

The relay should be a small independent deployable, not added to the existing stateful Fastify process. Preferred implementation if Verso has no existing realtime platform: a Cloudflare Worker plus one hibernating Durable Object per host ID. It supplies WebSocket fan-out, connection hibernation, per-object coordination, and edge termination. Keep a provider-neutral relay protocol so this can move later. The existing Fastify backend remains the account/pairing control plane and issuer of short-lived relay access tokens. JWT signing, verification, and rotation are new capabilities and must use a maintained library and a managed key service, not custom code.

The native macOS layer owns the relay WebSocket and cryptographic keys so private material stays in Keychain/Secure Enclave and encryption uses CryptoKit. It invokes a narrow loopback bridge in the sidecar using the existing launch-scoped token. The command allowlist and schema checks exist on both sides of that bridge; neither side accepts an arbitrary local URL or Hermes method.

### Why a relay is needed

For a reliable consumer experience across arbitrary networks, both the phone and Mac need a publicly reachable rendezvous and transport. A purely direct connection cannot be the only path: home and mobile networks commonly use NAT, firewalls, changing addresses, and carrier-grade NAT. WebRTC-style peer-to-peer connectivity would still require a signaling service plus STUN, and a TURN relay for the cases where direct traversal fails. Port forwarding, public exposure of the Mac, and requiring a user-managed VPN are rejected for the default product because they weaken either security or usability.

“Verso relay” means a small service operated as part of the Verso product, but its infrastructure can be managed by Cloudflare. Verso owns the Worker/Durable Object code, authentication policy, deployment, monitoring, and cost; Cloudflare runs the underlying edge infrastructure. It is not a transcript backend: it holds live socket/routing state, sees limited metadata, cannot decrypt content, and does not retain ciphertext in v1. The existing Verso backend remains responsible for accounts, pairing, revocation, and short-lived relay credentials.

An expert-user mode could later substitute an overlay network such as Tailscale or a self-hosted relay. That would reduce Verso-operated transport for those users, but it would add setup and would not replace the default QR-and-go path.

## Identity, pairing, and cryptography

Do not invent a channel protocol from raw ECDH/HKDF/nonce primitives. Both endpoints are Apple platforms, so use CryptoKit's implementation of the standardized RFC 9180 HPKE construction in authenticated mode, with the supported P-256/SHA-256/AES-GCM ciphersuite. Use a fresh HPKE message context/envelope for each command or event so reconnects do not depend on synchronized counters. Store persistent authentication keys in Keychain/Secure Enclave where supported. Bind protocol version, host ID, device ID, message ID, direction, and expiry as authenticated context. Private keys never enter the sidecar, backend database, or relay. Phase 0 must verify CryptoKit HPKE against Verso's deployment targets and cross-device test vectors; if an older supported OS lacks it, use an audited RFC 9180 library rather than a home-grown fallback.

Pairing flow:

1. Mac creates a 256-bit single-use pairing secret, pairing ID, and five-minute expiry, and exposes its HPKE authentication public key. Backend stores the pairing ID, host/user association, expiry, and status, but not the secret.
2. QR contains a universal link with pairing ID, Mac public key, and the secret in the URL fragment so it is not sent in ordinary HTTP requests. If app installation interrupts the handoff, ask the user to scan again; do not depend on deferred deep-link attribution.
3. Phone must be signed into the same Verso user, generates its authentication key pair, and submits its public key plus a proof keyed by the QR secret through the control plane.
4. The backend accepts only the first atomic claim. Mac verifies the proof, shows phone name and a short authentication string derived from both keys and the pairing transcript, and requires explicit confirmation.
5. Each side stores the other device's authenticated public key and its own private key in Keychain. Subsequent content uses authenticated HPKE envelopes; there is no backend-held shared content key.
6. Backend marks the device paired and issues only short-lived relay JWTs (for example, five minutes), scoped to one user, host, device, role, and connection purpose. Existing long-lived app sessions are never accepted directly by the relay.
7. Pairing secrets are single-use, expire automatically, and are invalidated on cancel/success. Rate-limit creation and claim attempts.

Envelope replay protection:

- Random 128-bit message ID, created-at, short expiry, and request ID on every command.
- Mac maintains durable, bounded per-device accepted message IDs and idempotency results in local SQLite and rejects duplicates/expired messages before dispatch, including after a sidecar or app restart.
- Responses/events bind to the original request/turn ID.

Revocation:

- Backend revocation prevents new relay JWT issuance and disconnects matching relay sockets.
- Mac revocation deletes the paired-device public-key binding and rejects all further envelopes even if the backend misbehaves.
- Provide “Connected devices”, last seen, and “Revoke” on Mac. Phone provides “Disconnect this Mac.”

## Relay protocol

Use compact versioned JSON control frames around binary ciphertext initially; move to CBOR only if measurements justify it.

Connection states: `connecting`, `online`, `host_offline`, `reconnecting`, `revoked`, `upgrade_required`.

Frame classes:

- `hello` / `authenticated` / heartbeat
- `host_presence`
- `request` (opaque encrypted command)
- `response` (opaque encrypted result)
- `event` (opaque encrypted turn event with monotonically increasing local event sequence)
- `ack`
- `error` for relay-level routing/auth errors only

The relay never interprets product commands. It checks the relay JWT, host/device relationship, role, frame size, rate limit, and destination. It does not persist ciphertext in v1. When no host socket is live, it returns `host_offline` immediately.

## Local turn architecture and reconnect behavior

Refactor chat execution before adding the relay:

1. Extract current route-owned execution into `ChatTurnService` with `startTurn`, `cancelTurn`, `approveTurn`, `getTurn`, and `subscribe(afterSequence)`.
2. The HTTP/SSE desktop path and `RemoteCommandRouter` call the same service. Its versioned event schema is the only interface seen by the journal, UI, or relay; Hermes `/v1/runs` and any temporary `/v1/responses` fallback are thin adapters behind it. There is one implementation of validation, model selection, attachment rules, duplicate-send prevention, analytics, title generation, history linking, and cancellation.
3. Starting a turn returns a durable local `turn_id` immediately, then starts Hermes `/v1/runs` and records the Hermes `run_id`.
4. The service—not the HTTP or relay connection—owns Hermes SSE consumption. A phone/browser disconnect never cancels the turn.
5. Normalize important events into a versioned schema and append them to local SQLite with a per-turn sequence. Persist bounded deltas/tool state plus terminal result; cap by event count/bytes and compact completed turns after the assistant message is durable.
6. Subscribers ask for events after sequence N. On reconnect, replay the journal, then continue live. If the journal has compacted or has a gap, return a snapshot marker and reload canonical messages/status.
7. Reconcile on sidecar restart: reload durable turn/idempotency records before accepting commands, query Hermes run status when available, otherwise use Hermes session history plus the current recovery code. Never claim a turn is still running if ownership was lost.
8. Phone reconnect algorithm: reconnect relay with exponential backoff + jitter, fetch host presence, fetch current session/turn snapshot, request events after its last acknowledged sequence, and reload canonical messages on any gap.
9. When Hermes requests approval, persist the pending request locally before notifying clients. Use a capped per-run timeout override (target 10 minutes for remote-capable runs; retain Hermes's 60-second default otherwise), show the deadline on mobile, accept only `approve once` or `deny`, and resolve exactly once if multiple clients race. A waiting run consumes local execution capacity, so expose that state, retain concurrency caps, and test the chosen timeout under load.

## Remote API v1

Every command is schema-validated and authorized against device scopes. Do not forward arbitrary paths.

- `host.getStatus`
- `sessions.list`
- `sessions.get`
- `sessions.create`
- `messages.list`
- `turns.start` (text only in the first slice)
- `turns.get`
- `turns.subscribe`
- `turns.cancel`
- `turns.approveOnce` / `turns.deny`

Idempotency:

- Mutating commands require a client-generated idempotency key.
- Store bounded results locally by `(device_id, idempotency_key)` so retries cannot create duplicate sessions or prompts.
- A session allows at most one active turn, matching current behavior.

## Notifications and phone lifecycle

Do not rely on a permanent iOS WebSocket in the background. The active app uses WebSocket; after suspension it reconnects and rehydrates.

- Register APNs tokens against the existing device record.
- On terminal/waiting-for-approval transitions, Mac sends a minimal signed notification hint through the control plane.
- APNs text is generic (“Verso needs your attention” / “Verso finished”). No prompt, response, tool output, or keys in push payloads.
- Opening the notification reconnects and fetches encrypted state from the Mac.

## Delivery phases

### Phase 0 — contracts and Hermes parity (2 weeks)

- Add architecture decision records for trust model, scope, relay vendor boundary, and Hermes integration.
- Contract-test pinned Hermes `/v1/runs`: models, conversation history including prior image inputs, tool events, reasoning, approvals, stop, failure, status retention, and current recovery behavior.
- Patch the bundled Hermes run path for required rich tool data, reasoning deltas/effort, image input/history, pollable pending-approval details, and a capped per-run approval-timeout override; contribute upstream where practical.
- Verify CryptoKit HPKE on every supported deployment target and publish fixed cross-device protocol test vectors.
- Prototype `ChatTurnService` against fake Hermes and real bundled Hermes.
- Exit criterion: `/v1/runs` passes Verso parity tests, including recovering and resolving an approval after the SSE subscriber dies and after a mobile-length wait. If it does not, Phase 1 may proceed locally on `/v1/responses`, but remote approval and the public beta remain blocked.

### Phase 1 — detached local turns (3–4 weeks)

- Implement `ChatTurnService`, event journal, snapshots, idempotency, and HTTP compatibility adapter.
- Move the existing desktop UI onto reconnectable event subscriptions without changing visible behavior.
- Test client disconnect, UI reload, sidecar restart, Hermes restart/failure, duplicate command, cancel, and journal compaction.
- Exit criterion: a local turn completes and is recoverable when its UI SSE connection is killed mid-run.

### Phase 2 — control plane and pairing (2–3 weeks)

- Extend backend schema with remote hosts, pairings, paired devices/scopes, APNs tokens, revocation, and audit/security events. Add explicit foreign keys and unique constraints for provider identity, host/device ownership, pairing claims, and revocation records.
- Add short-lived relay JWT issuance and key rotation.
- Implement QR UI, universal-link landing route, Keychain keys, pairing confirmation, device list/revoke.
- Require iOS 17 or later for the initial mobile client, matching CryptoKit HPKE availability; revisit an audited compatibility library only if product requirements demand an older target.
- Threat-model review and pairing/HPKE protocol test vectors across macOS and iOS.
- Exit criterion: the two Apple clients interoperate; backend/relay cannot decrypt; replay, wrong user, expired QR, simultaneous claims, swapped key, and revoked device all fail.

### Phase 3 — relay and desktop remote router (2–3 weeks)

- Implement provider-neutral relay contract and Cloudflare Durable Object adapter.
- Implement outbound relay client, strict `RemoteCommandRouter`, encrypted envelopes, rate/size limits, heartbeat/reconnect, presence, and observability without plaintext logging.
- Exit criterion: remotely list/create/send/cancel over two unrelated networks; relay restart and network switch recover without duplicating work.

### Phase 4 — mobile integration and production hardening (3–4 weeks, mobile app assumed to exist in a named codebase)

- Wire the mobile app to pairing, session API, streaming/replay, offline states, Face ID approvals, device revocation, APNs, and upgrade gating.
- Book the external penetration test/security review by the end of Phase 2 to absorb vendor lead time. Complete it here alongside load/soak/fault tests, privacy copy, abuse controls, dashboards, runbooks, gradual rollout and kill switch.
- Exit criterion: beta SLOs and security gates below pass.

Expected core effort excluding building the mobile app/UI from scratch: roughly 12–16 engineering weeks, plus an independent security review. The range includes the required Hermes parity work. If no mobile client codebase already exists, estimate and staff that separately before committing to a beta date. Two engineers can overlap backend/relay and desktop work after Phase 1; elapsed calendar time can be lower than summed engineering time.

## Security and reliability gates

- No listener changes: orchestrator and Hermes remain loopback-only.
- Backend and relay logs verified to contain no decrypted command/event bodies, keys, QR secrets, app session tokens, or model/provider secrets.
- Threat model covers malicious relay/operator, stolen phone, stolen app token, QR shoulder-surfing, replay, device/account revocation, DNS/TLS failure, oversized frames, confused deputy/path traversal, downgrade, and compromised paired device.
- Protocol version negotiation fails closed; old insecure clients cannot silently downgrade.
- Dependency/SBOM and secret scans, fuzz/property tests for envelope parsing, and cross-language crypto test vectors.
- Relay JWT signing keys rotate; emergency remote-access kill switch does not affect local Verso.
- Backpressure and caps for event journal, relay frames, concurrent turns, requests/device, and pairing attempts.
- Availability target for beta: host presence accuracy within 30 seconds (accepting the heartbeat cost needed to achieve it); reconnect after ordinary network switch within 10 seconds p95; zero duplicate turns under retries; remote outage never breaks local chat.
- Required fault tests: Hermes SSE killed mid-run and held past its stream TTL; approval answered after several minutes; desktop and phone simultaneous fan-out; exact-once turn creation across sidecar/app restart; two phones racing one QR; clock skew; journal caps/compaction; relay JWT expiry mid-WebSocket; version-floor rejection; and remote kill switch.
- Soak tests: 24-hour host connection, repeated phone suspend/resume, relay eviction/restart, packet loss, token expiry during active turn, laptop sleep/wake, lid close/open reconciliation, and app/sidecar upgrade.
- During an active remote turn, the Mac app may request a scoped system sleep assertion and releases it on terminal state or timeout. This can prevent idle sleep but does not promise operation through lid closure, shutdown, logout, or network loss.

## Explicit non-goals for v1

- Waking a sleeping/shut-down Mac from arbitrary networks.
- Cloud execution or cloud copies of transcripts/memory.
- Offline command queueing.
- Remote settings/provider/connector/file/browser administration.
- Multiple users sharing one host.
- Permanent remote approvals.
- Full attachment support in the first end-to-end slice.

## Rollout

1. Internal opt-in behind backend and desktop feature flags.
2. Security review fixes and small managed-account alpha.
3. Invite beta with per-user/host kill switches and version floor.
4. Observe reconnect, pairing, relay, duplicate-request, approval, and host-offline metrics.
5. General availability only after incident/runbook, key-rotation, relay failover, and revocation drills.

## Review outcome

Claude Code Fable 5 explicitly agreed with this implementation baseline after two reviews. Its requested revisions are incorporated above: make Hermes run parity and recoverable approval state prerequisites, treat its SSE as a fragile single-consumer stream, persist idempotency across restarts, use a per-run mobile approval timeout, strengthen schema constraints, replace bespoke channel crypto with standardized HPKE, narrow v1, add fault tests, and use the 12–16 week estimate.

# Multi-Endpoint Group Bridge Design

## Purpose

This document designs future support for bridge sessions with more than two
Discord voice endpoints. The current self-hosted MVP remains a two-endpoint
bridge. Multi-endpoint group bridges should be added incrementally without
breaking the current `/bridge create` and `/bridge join <code>` flow.

## Product Goal

Let three or more Discord servers join the same voice bridge group so users in
each server can hear and talk with users in every other joined server.

Example:

1. Server A creates a bridge group.
2. Server B joins the group with a pairing code.
3. Server C joins the same group with a valid invite or group code.
4. Speech from Server A is heard in Server B and Server C.
5. Speech from Server B is heard in Server A and Server C.
6. Speech from Server C is heard in Server A and Server B.

The user-facing product should still feel Discord-native and self-hosted. A web
dashboard can be added later, but it should not be required for the first group
bridge release.

## Non-Goals

This design does not add these features:

- Public bridge discovery.
- Managed hosted-service onboarding.
- Payments or account plans.
- Same-server channel-to-channel bridging with one bot account.
- Stage channel support.
- Recording, transcription, or moderation bots.
- Arbitrary non-Discord voice adapters.

## Design Principles

- Keep two-endpoint bridges working exactly as they do now.
- Treat a group bridge as one bridge with `N` endpoints, not as many hidden
  two-endpoint bridges.
- Never transmit audio back into the endpoint where that audio originated.
- Require explicit action for each endpoint that joins a group.
- Keep pairing codes and sensitive remote details ephemeral by default.
- Keep storage, authorization, and Discord API behavior behind existing provider
  boundaries.
- Make resource limits explicit because each extra endpoint increases receive,
  mix, encode, and transmit work.

## User Experience

The existing two-endpoint commands can remain the default path:

- `/bridge create`
- `/bridge join <code>`
- `/bridge status`
- `/bridge leave`
- `/bridge help`

Group support should extend the command model instead of replacing it.

Recommended first group command shape:

- `/bridge create max_endpoints:<number>` creates a pending group bridge.
- `/bridge join <code>` joins the caller's current voice channel to the group.
- `/bridge invite` creates another short-lived join code for a running group.
- `/bridge status` shows the local endpoint plus the count of remote endpoints.
- `/bridge leave` removes the caller's endpoint from the group.

The first implementation can keep `max_endpoints` small, such as 3 or 4, until
CPU, latency, and Discord behavior are measured.

### Create Group

1. User joins a normal Discord voice channel.
2. User runs `/bridge create max_endpoints:3`.
3. The bot checks `PermissionPolicy.can('create_bridge', context, bridge)`.
4. The bot creates a pending bridge record with one endpoint and a maximum
   endpoint count.
5. The bot returns an ephemeral pairing code and expiry.

If `max_endpoints` is omitted, the default should remain `2` until group
bridges are intentionally enabled.

### Join Group

1. User joins a normal Discord voice channel.
2. User runs `/bridge join <code>`.
3. The bot resolves the caller's current voice channel.
4. The bot loads the target bridge and validates that it can accept another
   endpoint.
5. The bot checks `PermissionPolicy.can('join_bridge', context, bridge)`.
6. The bot adds the endpoint and starts or updates routing.
7. The bot returns a short success response.

Joining should be rejected when:

- The code is invalid, expired, consumed, or revoked.
- The bridge is full.
- The same guild/channel is already in the bridge.
- Local allowlists deny the guild or voice channel.
- The bot lacks required Discord voice permissions.
- The bridge is in a failed, stopping, stopped, or deleted state.

### Invite More Endpoints

For a running group bridge, `/bridge invite` should create a new short-lived
join code if the caller can manage the bridge and the bridge is not full.

Invite codes should be one-time use by default. If reusable codes are added
later, they should be a separate explicit mode with stronger audit and revoke
behavior.

### Leave Group

`/bridge leave` should remove the caller's current endpoint from the bridge.

Recommended behavior:

- If one endpoint leaves and at least two endpoints remain, the bridge keeps
  running.
- If only one endpoint remains, the bridge stops or becomes pending depending on
  the configured policy.
- If the creator leaves, ownership should not silently transfer unless a future
  permission model explicitly supports it.

## State Model

The current bridge record already has an `endpoints` array. Group support should
generalize the record while preserving the two-endpoint shape.

Recommended additional bridge fields:

- `mode`: `pair` or `group`.
- `maxEndpoints`: maximum endpoint count for the bridge.
- `createdByUserId`: user that created the group.
- `createdInGuildId`: guild where the group was created.
- `invitePolicy`: `creator_only`, `endpoint_admins`, or `any_endpoint_user`.
- `emptyPolicy`: `stop_when_below_two` for the first implementation.
- `generation`: monotonic integer incremented whenever endpoints are added or
  removed.

Endpoint records should add:

- `joinedByUserId`: user that added the endpoint.
- `joinedAt`: ISO timestamp.
- `status`: `pending`, `joining`, `active`, `leaving`, `left`, or `failed`.
- `lastError`: optional short error summary.

Pairing or invite code records should add:

- `maxUses`: default `1`.
- `usedCount`: default `0`.
- `bridgeGeneration`: bridge generation when the code was created.
- `purpose`: `initial_join` or `additional_endpoint`.

The first implementation should keep one-time codes. The fields above leave a
clean path to reusable group invites later without changing the basic record.

## Routing Model

Two-endpoint routing currently has two directions:

- Endpoint A to Endpoint B.
- Endpoint B to Endpoint A.

Group routing should use source-excluded fanout:

- For every active source endpoint, receive user audio from that endpoint.
- Build one outbound mix for each target endpoint.
- Each target mix includes audio from all active source endpoints except the
  target endpoint itself.
- Transmit that target-specific mix into the target endpoint.

For `N` endpoints, the bridge creates up to `N` outbound mixes. Each mix can
include up to `N - 1` source endpoint streams.

This avoids routing a server's own audio back into the same server while still
letting every server hear all other servers.

## Audio Pipeline

The first group bridge implementation should preserve the existing Discord
receive/transmit boundary and evolve the mixer.

Recommended core dependency change:

- Replace `startTwoWayForwarding(endpointA, sessionA, endpointB, sessionB)` with
  a topology-neutral forwarding dependency such as
  `startGroupForwarding({ bridgeId, endpoints, sessions })`.
- Keep the two-endpoint implementation as a compatibility wrapper around the
  group forwarder.

Recommended mixer behavior:

- Decode incoming Opus per active speaker.
- Tag every source stream with `sourceEndpointId` and `speakerId`.
- For each target endpoint, mix only frames whose `sourceEndpointId` differs
  from the target endpoint id.
- Apply gain based on active sources in the target mix.
- Drop or cap buffers per speaker to avoid unbounded latency.
- Destroy all source and target pipelines when an endpoint leaves.

Open performance question:

- The current mixer decodes to PCM and re-encodes one mixed stream. Group
  routing may need one mixed encode per target endpoint. This is simpler and
  safer for correctness, but it increases CPU roughly with endpoint count.

## Bridge Engine Changes

`BridgeEngine` should be changed in phases.

Phase 1: topology acceptance

- Allow `BridgeDefinition.endpoints.length >= 2` only when group mode is
  explicitly enabled.
- Preserve the exact two-endpoint validation path for default bridges.
- Add a clear error for unsupported endpoint counts when group mode is disabled.

Phase 2: group start/stop lifecycle

- Join all endpoints for a group bridge.
- Start recovery and voice-state monitoring for each endpoint.
- Start group forwarding after all required endpoint sessions are joined.
- Stop and clean up every active endpoint session.

Phase 3: dynamic endpoint membership

- Add a runtime operation for adding an endpoint to an already running bridge.
- Add a runtime operation for removing one endpoint without stopping the whole
  bridge.
- Persist bridge generation changes through `StateStore`.

The first shippable group release can avoid dynamic in-place reconfiguration by
stopping and restarting the group when an endpoint joins, but that will create
audio interruption. A better implementation should support adding endpoints
without tearing down existing sessions.

## Permission And Safety

Group bridges increase abuse risk because one invite can connect more
communities than a two-endpoint bridge.

Required checks:

- Each endpoint join must pass `PermissionPolicy`.
- The resulting bridge must pass guild and voice-channel allowlists.
- The bridge must enforce `maxEndpoints`.
- The same voice channel must not appear twice in one group.
- Pairing and invite codes must expire.
- Detailed remote guild and channel information should remain hidden unless a
  future trusted-admin mode explicitly reveals it.

Recommended policy additions:

- `invite_bridge_endpoint`
- `remove_bridge_endpoint`

These can be added later. The first implementation can reuse `join_bridge` and
`stop_bridge` if the policy receives the full bridge and target endpoint.

## Recovery And Empty-Channel Rules

Recovery should be endpoint-scoped.

Recommended behavior:

- If one endpoint disconnects or the bot is moved, recover that endpoint without
  disturbing the rest of the group when possible.
- If one endpoint becomes empty, remove that endpoint from the group.
- If fewer than two active endpoints remain, stop the bridge by default.
- If startup fails for one endpoint before the group is running, disconnect all
  already joined endpoints and mark the bridge failed.

Voice-state monitoring should accept an array of endpoint recoveries instead of
assuming exactly two endpoints.

## Observability

Structured logs should include:

- `bridgeId`
- `bridgeMode`
- `endpointCount`
- `maxEndpoints`
- `sourceEndpointId`
- `targetEndpointId`
- `speakerId`
- `bridgeGeneration`
- `reason`

Useful events:

- Group created.
- Endpoint invite created.
- Endpoint joined.
- Endpoint rejected.
- Endpoint left.
- Group routing started.
- Group routing restarted.
- Group stopped because fewer than two endpoints remained.
- Mixer buffer frames dropped.
- Endpoint recovery started, succeeded, or failed.

## Incremental Implementation Plan

1. Add group bridge contracts and state fields while keeping the default command
   path two-endpoint only.
2. Add tests for bridge definition validation, endpoint uniqueness, and
   `maxEndpoints`.
3. Build `startGroupForwarding()` for a fixed set of endpoints and wrap the
   current two-way forwarding through it.
4. Add bridge engine support for starting and stopping fixed-size groups.
5. Extend `/bridge create` with an explicit group option behind a local config
   flag.
6. Extend `/bridge invite` for adding endpoints up to `maxEndpoints`.
7. Add endpoint removal behavior for `/bridge leave`.
8. Measure CPU, latency, and buffer drops with three and four endpoints before
   raising the default limit.

## Acceptance Criteria For First Group Release

- Existing two-endpoint pairing behavior remains unchanged.
- A self-hosted operator can enable group bridge support explicitly.
- A group bridge can run with three Discord voice endpoints.
- Audio from each endpoint is transmitted to every other endpoint and not back
  into its source endpoint.
- The bot rejects duplicate endpoints and bridges that exceed `maxEndpoints`.
- `/bridge status` reports local endpoint state and group endpoint count.
- `/bridge leave` removes one endpoint or stops the group when fewer than two
  active endpoints remain.
- Logs make routing, endpoint joins/leaves, and mixer pressure diagnosable.

## Open Questions

- Should group support be enabled by config flag for the first release?
- What should the hard default `maxEndpoints` be: 3 or 4?
- Should joining a running group restart routing or add an endpoint in place?
- Should non-creator endpoint admins be allowed to generate `/bridge invite`
  codes?
- Should a group have a stable display name, or should status remain mostly
  endpoint-count based for privacy?
- How much latency is acceptable for three or four endpoints on a small
  self-hosted machine?

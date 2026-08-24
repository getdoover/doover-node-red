# doover-js Transport Reference

The definitive guide for implementing our `DooverTransport` adapter (interface in
`packages/nodered-core/lib/transport.js`) on top of the **doover-js** library.

Both the on-device (`LocalTransport`) and cloud (`CloudTransport`) implementations
of `DooverTransport` wrap doover-js clients. doover-js exposes a common
`DataClient` interface implemented by `DooverClient` (cloud), `LocalAgentClient`
(local web API), and `MultiplexClient` (fan-out). We use the first two directly.

- **Installed / documented version:** `doover-js@0.7.1` (latest at time of
  writing), installed to a throwaway dir and inspected.
- **Local source reference:** `/Users/tomwyatt/doover-apps/doover-js` — a **v0.6.5**
  checkout. All `src/**` line citations below are against 0.6.5. Where 0.7.1's
  shipped `dist/**` diverges it is called out in [§12 Version drift](#12-version-drift-065-src--071-dist).

> The old hand-rolled gRPC client (dda-agent :50051) is parked. doover-js talks
> to the dda-agent's **local web API on `DEFAULT_WEB_PORT` = 49100** (REST +
> WebSocket gateway), not gRPC.

---

## 1. TL;DR — DooverTransport → doover-js mapping

Our transport interface (`transport.js`) maps onto doover-js as follows. `client`
is a `DooverClient` or `LocalAgentClient`; `agentId` is the resolved device agent
id (a string — see [§6.3](#63-agent-scoping-the-local-agent-is-not-implicitly-a-channelref)).

| `DooverTransport` method | doover-js call |
|---|---|
| `connect()` | `client.gateway.connect()` (idempotent); then resolve/cache `agentId` via `client.getAgentScope()` |
| `close()` | `client.gateway.disconnect()` |
| `publish(ch, payload)` (merge) | `client.aggregates.patchAggregate(agentId, ch, payload, params)` |
| `publish(ch, payload, {replaceData:true})` | `client.aggregates.putAggregate(agentId, ch, payload, params)` |
| `publish(..., {recordLog:true})` | pass `{ log_update: true }` as the `params` arg (see [§5.3](#53-put-vs-patch--merge-vs-replace-critical)) |
| `subscribe(ch, cb)` | `client.gateway.subscribeToChannel({agent_id, name:ch}, {onMessage,onAggregate,onMessageUpdate})` → returns unsubscribe fn |
| `getAggregate(ch)` | `client.aggregates.getAggregate(agentId, ch)` → returns `Aggregate`; take `.data` |
| `sendOneShot(ch, payload)` | `client.gateway.sendOneShotMessage({agent_id, name:ch}, payload)` |
| `agentId()` | cached string from `getAgentScope()` (local) / configured target id (cloud) |
| `appKey()` | **not a doover-js concept** — read `APP_KEY` env var (local) or config (cloud) |
| `status()` | derive from `client.getStatus()` / `client.onStatusChange()` (see [§6.4](#64-status-tracking-clientstatustracker)) |

Two semantic gaps to design around, both detailed below:

1. **`PublishOptions.maxAge` has no doover-js equivalent.** The doover-js REST
   aggregate params are `{ suppress_response?, clear_attachments?, log_update? }`
   only — there is no `max_age_secs` / cloud-debounce field. See [§5.3](#53-put-vs-patch--merge-vs-replace-critical).
2. **No message replay on reconnect.** doover-js resumes the session and
   re-subscribes but does **not** replay missed messages or re-fetch aggregates.
   The tag layer MUST re-seed from `getAggregate` on every (re)connect. See
   [§8 Reconnect semantics](#8-gatewayclient-subscription--reconnect-semantics-critical).

---

## 2. CJS usage from Node (no bundler)

The package is CJS-compatible. `dist/index.js` is plain CommonJS (`"use strict";
Object.defineProperty(exports, …)`), `package.json#main = dist/index.js`. A plain
`require("doover-js")` works under Node 22/24 with global `fetch` and `WebSocket`.

```js
const {
  DooverClient,
  LocalAgentClient,
  GatewayClient,
  DooverApiError,
  UnsupportedCapabilityError,
} = require("doover-js");
```

Verified working require surface (0.7.1, `Object.keys(require("doover-js"))`):

```
ALL_CAPABILITIES, AgentsApi, AggregatesApi, AlarmsApi, AmbiguousWriteError,
AuthProfile, ChannelsApi, ConnectionsApi, CookieAuth, DEFAULT_OFFLINE_RETENTION_MS,
DV_AUDIT_CHANNEL, DooverApiError, DooverAuth, DooverAuthError, DooverClient,
DooverDataProvider, DooverGatewayError, DooverOfflineError, DooverRpcError,
DooverStatsCollector, DooverTokenAuth, DooverValidationError, GatewayClient,
LocalAgentClient, MemoryOfflineStorageAdapter, MessagesApi, MultiplexClient,
NotificationsApi, OfflineDataClient, OrganisationsApi, PermissionsApi,
ProcessorsApi, RestClient, RpcDispatcher, TurnApi, UsersApi, addTimestampToMessage,
buildAuth, extractSnowflakeId, generateSnowflakeIdAtTime, getDooverClient,
getIdentifierFromPath, isDooverRequestOptions, peekDooverClient, requestOptions,
resetDooverClient, splitRequestOptions
```

**Subpath export:** `require("doover-js/node")` exposes `ConfigManager` (a
`~/.doover/config` profile reader, pydoover-config compatible). The `./react`
and `./refine` subpaths pull in React/@refinedev peer deps — **do not require
them** from nodered-core.

### CJS / ESM traps in 0.7.1

- **No top-level `await`, no ESM-only syntax** in the CJS `dist` — safe to
  `require`.
- **`react`/`refine` subpaths are peer-dep-gated.** `package.json` marks
  `react`, `@refinedev/core`, `@tanstack/react-query` as optional peers. As long
  as you only touch the root and `/node` subpaths, no React install is needed.
- **`getDooverClient()` is a process-global singleton** keyed on
  `globalThis.__doover_js_client__` (`src/client/singleton.ts:3`). First caller's
  config wins; later differing configs log a warning and are ignored. **Do not use
  it** in nodered-core — Node-RED can have multiple connection config nodes with
  different endpoints. Always `new DooverClient(...)` / `new LocalAgentClient(...)`
  per connection node.
- **Browser lifecycle hooks are auto-skipped in Node** (`typeof document`/`window`
  guards, `src/gateway/gateway-client.ts:455-463`). You can also set
  `disableBrowserLifecycleHooks: true` explicitly.
- **`sessionStorage` for impersonation is guarded** (`src/http/rest-client.ts:249`)
  — no-op in Node.

### fetch / WebSocket injection (for tests)

Both `DooverClientConfig` and `LocalAgentClientConfig` accept injection points
(`src/http/rest-client.ts:13-18`, `src/client/local-agent-client.ts:36-38`):

- `fetchImpl?: typeof fetch` — swap in a stub for REST. Falls back to global
  `fetch` (`src/http/rest-client.ts:125`).
- `webSocketImpl?: typeof WebSocket` — a `WebSocket` **constructor**. Falls back to
  global `WebSocket` (`src/gateway/gateway-client.ts:131`). This is the knob the
  doover-js gateway tests use (`MockWebSocket as unknown as typeof WebSocket`).
- `webSocketFactory?: ({url, headers}) => WebSocket` — a factory taking url +
  headers; used when you need to pass auth **headers** on the WS handshake (the
  `ws` npm package supports this; browsers do not). If a factory is present,
  token auth sends `Authorization: Bearer` via headers; otherwise it appends
  `?token=` to the URL (`src/auth/doover-token-auth.ts:57-74`).

For our `MockTransport` we do **not** wrap doover-js at all — it's a hand-rolled
in-memory implementation of `DooverTransport`. These injection points are for
integration tests that exercise the real `LocalTransport`/`CloudTransport`
against a fake agent.

---

## 3. The `DataClient` interface surface

`src/client/data-client.ts:77-106`. Every client (`DooverClient`,
`LocalAgentClient`, `MultiplexClient`) implements this:

```ts
interface DataClient {
  readonly agents, channels, messages, aggregates, alarms, connections,
           notifications, permissions, processors, turn, users;  // sub-clients
  readonly gateway;   // GatewayClientLike
  readonly rpc;       // RpcDispatcherLike

  getCapabilities(): ReadonlySet<Capability>;
  supports(cap: Capability): boolean;

  isConnected(): boolean;
  getStatus(): DataClientStatus;
  onStatusChange(listener: (s: DataClientStatus) => void): () => void;

  getAgentScope(): Promise<AgentScope>;
  getKnownAgentScope(): AgentScope | "unknown";
}
```

Sub-clients are the concrete `*Api` classes (structurally typed as `*ApiLike =
Pick<Class, keyof Class>`, `data-client.ts:21-33`). Only four are relevant to us:
`agents`, `channels`, `messages`, `aggregates`. `gateway` handles realtime.

**Capability gating.** `getCapabilities()` returns the set of supported
capabilities. On `LocalAgentClient` the unsupported sub-clients are Proxies that
**reject every call** with `UnsupportedCapabilityError` (`local-agent-client.ts:236`).
`DooverClient` supports everything (`ALL_CAPABILITIES`, `doover-client.ts:144`).
Gate optional features with `client.supports("aggregates.put")` before calling.

### 3.1 `agents` sub-client (`AgentsApi`, `src/apis/agents-api.ts:159`)

- `listAgents(options?): Promise<AgentsResponse>` — `{ agents: Agent[], … }`. On
  the local agent this returns the one device the agent serves; we use
  `agents[0].id` as the agent id.
- `getMultiAgentMessages(channelName, params)` / `getMultiAgentAggregates(channelName, params)`
  — cloud-only batch reads across many agents (auto-chunked at 250 ids for the
  CloudFront 8 KB URL cap, `agents-api.ts:308`). **Not supported on local.** Useful
  later for cloud "read many devices at once", not for v1.

### 3.2 `channels` sub-client (`ChannelsApi`, `src/apis/channels-api.ts:27`)

- `listChannels(agentId, {include_aggregate?, include_archived?, …}?): Promise<Channel[]>`
- `getChannel(agentId, channelName, {include_aggregate?}?): Promise<Channel>` —
  a `Channel` optionally carries `.aggregate` when `include_aggregate: true`.
- `createChannel` / `putChannel` / `archiveChannel` / `unarchiveChannel` /
  `listDataSeries` — cloud-only for our purposes.

Every method has a two-form overload: **positional** `(agentId, channelName, …)`
**or** an **identifier object** `({ agentId, channelName }, …)`. Both are handled by
`resolveChannelArgs` / `resolveAgentArgs` (`src/apis/_args.ts`). Positional is
simplest for us.

> **Channel resolution is by NAME, scoped by agent id** — never a channel id.
> Every REST path is `/agents/{agentId}/channels/{channelName}/…`
> (`aggregates-api.ts:22`, `channels-api.ts:37`). There is no "resolve channel by
> id" call in the surface we use. So our transport only ever needs `(agentId,
> channelName)`.

### 3.3 `messages` sub-client (`MessagesApi`, `src/apis/messages-api.ts:58`)

- `postMessage(agentId, channelName, body): Promise<MessageStructure>` — appends a
  persisted message (this is `create_message` / `CreateMessage`). `body` is
  `CreateMessageRequest | FormData`. To record it in history set
  `record_log: true` on the message body (`MessageStructure.record_log`,
  `types/common.ts:38`). Used for the `notify` and activity-log writes to the
  `notifications` and `activity_logs` channels.
- `listMessages(agentId, channelName, {before?, after?, limit=10, order="desc"}?): Promise<MessageStructure[]>`
  — cursor windowed by snowflake id; `order:"asc"` reverses client-side
  (`messages-api.ts:44-56`).
- `getTimeseries`, `getMessage`, `putMessage`, `patchMessage`, `deleteMessage`,
  `getInvocationLogs`, `createMultipartPayload(json, attachments)` — post/multipart
  helpers. On local, only `listMessages/postMessage/putMessage/patchMessage/
  createMultipartPayload` are advertised (`local-agent-client.ts:140`).

All returned messages are stamped with a `.timestamp` derived from the snowflake
id (`addTimestampToMessage`, `messages-api.ts:84`).

### 3.4 `aggregates` sub-client — see [§5](#5-aggregates--the-channel-value-layer).

---

## 4. Core data shapes

From `src/types/common.ts`:

```ts
interface ChannelRef { agent_id: string; name: string; }                 // :17

interface Aggregate<TData = Record<string, JSONValue>> {                 // :22
  data: TData;                 // <-- the user payload / merged channel state
  attachments: Attachment[];
  last_updated?: number | null;
  __source?: SourceProvenance; // stamped by the client (which source returned it)
}

interface MessageStructure<TData = JSONValue> {                          // :31
  data: TData; attachments; id; author_id;
  channel: ChannelRef; timestamp: number; record_log?: boolean; __source?;
}

interface Channel { aggregate?: Aggregate; name; id?; owner_id; … }      // :42
```

> The user's value always lives under `.data`. `getAggregate()` returns the whole
> `Aggregate`; our `DooverTransport.getAggregate` must return `agg.data` (or
> `null` when empty) to satisfy the "aggregate = merged latest state" contract.

`__source` provenance (`SourceProvenance`) is stamped onto **every** returned
datum and gateway event by `ProvenanceStamper` (`local-agent-client.ts:108`,
`doover-client.ts:97`). Harmless for us; strip it before handing payloads to
flows if you want clean `msg.payload`.

---

## 5. Aggregates — the channel value layer

`src/apis/aggregates-api.ts`. All paths are
`/agents/{agentId}/channels/{channelName}/aggregate`.

### 5.1 Read

```js
const agg = await client.aggregates.getAggregate(agentId, channelName); // Aggregate
const value = agg?.data ?? null;
```

`getAggregate(agentId, channelName)` **or** `getAggregate({agentId, channelName})`
(`aggregates-api.ts:14-19`). GET; returns the full `Aggregate`.

### 5.2 Write

```js
await client.aggregates.patchAggregate(agentId, channelName, payloadObj, params); // merge
await client.aggregates.putAggregate(agentId, channelName, payloadObj, params);   // replace
```

`body` is `Record<string, unknown> | FormData` (use FormData +
`messages.createMultipartPayload` only for attachments). `params` is
`AggregateMutationParams` (`aggregates-api.ts:5-9`):

```ts
interface AggregateMutationParams {
  suppress_response?: boolean;   // don't echo the updated aggregate back
  clear_attachments?: boolean;
  log_update?: boolean;          // persist this write in channel history
}
```

### 5.3 PUT vs PATCH — merge vs replace (CRITICAL)

- **`patchAggregate` = deep-merge** (Doover diff-merge: nested dicts recurse,
  `null` deletes a key). This is the **default** for `DooverTransport.publish()`.
- **`putAggregate` = replace the aggregate wholesale.** Maps to
  `PublishOptions.replaceData === true`.

Evidence: the doover-js migration table (`README.md:262-263`) maps the old
`viewer.updateAggregate(id,data,params)` → **`patchAggregate`** and
`viewer.putAggregate(id,data,params)` → **`putAggregate`**. "update" is the
merge path; "put" is the replace path. The HTTP verbs match (PATCH=merge,
PUT=replace, `aggregates-api.ts:58/97`). The actual merge is performed
**server-side** by the dda-agent web API / cloud — doover-js just forwards the
verb + body; there is no client-side merge flag.

**Mapping `PublishOptions` → doover-js:**

| `PublishOptions` (transport.js) | doover-js |
|---|---|
| default (merge) | `patchAggregate(...)` |
| `replaceData: true` | `putAggregate(...)` |
| `recordLog: true` | `params.log_update = true` |
| `maxAge` (seconds / `-1`) | **NO EQUIVALENT** — see below |

> **`maxAge` gap.** The gRPC `UpdateAggregate` had `max_age_secs` /
> `replace_data` / `save_log`. The doover-js REST aggregate params expose only
> `log_update` (= `save_log`) and the PUT/PATCH verb (= `replace_data`). There is
> **no `max_age_secs`** field. If a caller passes `maxAge`, the transport must
> either drop it (documented no-op) or — if the local web API still honours a
> `max_age` query param — pass it via a raw `client.rest.request(...)` call
> (`DooverClient.rest` is public; `LocalAgentClient`'s `rest` is private, so on
> local you'd need `patchAggregate` only). **Recommendation:** treat `maxAge` as a
> no-op in the doover-js transports and note it in the node help; revisit if the
> web API documents a max-age param.

### 5.4 One-shot (live) values

One-shots do **not** go through the aggregate REST API — they go over the
gateway: `client.gateway.sendOneShotMessage(channelRef, data)` (op 15). Delivered
to live subscribers, never merged/persisted. See [§7](#7-one-shot-send).

---

## 6. `LocalAgentClient` (on-device, `LocalTransport`)

`src/client/local-agent-client.ts`. Talks to the dda-agent local web API
(REST + WS) on `http://<host>:49100`.

### 6.1 Constructor config (`LocalAgentClientConfig`, `:30-45`)

```ts
new LocalAgentClient({
  baseUrl: "http://localhost:49100",  // REQUIRED. The local agent web API.
  wssUrl,               // optional; defaults to baseUrl with http→ws (see note)
  fetchImpl,            // test injection
  webSocketImpl,        // test injection (constructor)
  webSocketFactory,     // test injection (headers)
  disableBrowserLifecycleHooks,  // set true in Node if you want to be explicit
  sourceId,             // stable id; defaults to `local:<host>:<port>` (:62)
  sourceLabel,
  auth,                 // reserved for future LAN auth; IGNORED in v1 (:43)
});
```

- **No auth** — the local client constructs `RestClient`/`GatewayClient` with **no
  `DooverAuth`** (`:124-125`), `sharing:"none"`, `organisationId:null`.
- **`wssUrl` default = `baseUrl` with `http`→`ws`** (`:71-73`, `:115`). So
  `http://localhost:49100` → `ws://localhost:49100`. **The WS is opened at that URL
  verbatim — no path is appended.** If the dda-agent serves its gateway on a
  sub-path (e.g. `ws://localhost:49100/ws`), you must pass `wssUrl` explicitly.
  **Verify the exact local WS path against the dda-agent web API before wiring
  `LocalTransport`.** (This is the single most likely integration snag.)

### 6.2 Capability list (`LOCAL_CAPABILITIES`, `:47-60`)

```
agents.list
channels.list, channels.get
aggregates.get, aggregates.put, aggregates.patch
messages.list, messages.post, messages.put
gateway.subscribe, gateway.realtime, gateway.oneShot
```

Everything we need (publish, subscribe, aggregate, one-shot, message post) is
present. Everything else (`alarms.*`, `notifications.*`, `permissions.*`,
`connections.*`, `processors.*`, `turn.*`, `users.*`, `rpc.*`, and the
create/archive/delete channel/message ops) **throws `UnsupportedCapabilityError`**
(`:236-247`). Confirmed at runtime: `local.getCapabilities()` returns exactly the
12 caps above.

### 6.3 Agent scoping — the local agent is NOT implicitly a `ChannelRef`

The local agent serves **one** device, but doover-js still needs the **agent id
string** to build channel paths/refs. The client resolves it lazily:

- `getAgentScope(): Promise<AgentScope>` calls `agents.listAgents()` and takes
  `agents[0].id` (`:168-191`), caching it as `{mode:"list", agentIds:[id]}`.
- `getKnownAgentScope()` returns `"unknown"` until that first resolution
  (`:193-195`).
- Resolution is auto-kicked on every gateway `ready` and **invalidated on each new
  session** (`:157-160`).
- On failure it does **not** cache (leaves it null so the next caller retries,
  `:180-183`).

**Implication for `LocalTransport`:** in `connect()`, after
`gateway.connect()`, `await client.getAgentScope()` and cache
`agentIds[0]` as the agent id. Every `patchAggregate` / `getAggregate` /
`subscribeToChannel` / `sendOneShotMessage` call needs that string. Do **not**
assume it — subscribing before the id resolves gives you no channel ref.
`DooverTransport.agentId()` returns this cached string.

> **`appKey()` is out of scope for doover-js.** doover-js has no app-key concept.
> The tag layer's app-key namespacing comes from the pydoover app env
> (`APP_KEY`, per PLAN §7). `LocalTransport.appKey()` reads `process.env.APP_KEY`;
> `CloudTransport.appKey()` returns the configured app key or `null`.

### 6.4 Status tracking (`ClientStatusTracker`)

`src/client/status-tracker.ts`. Both clients own one; surfaced via
`client.getStatus()` and `client.onStatusChange(listener) → unsubscribe`.

`DataClientStatus` (`data-client.ts:49-69`) fields we use: `connected` (bool),
`state` (`"connected"|"connecting"|"disconnected"|"degraded"|"error"`), `session`,
`lastEvent`, `lastError`, `agentScope`, `at`. State is derived from gateway
`open`/`ready`/`close`/`wssError` events (`status-tracker.ts:52-70`):

- `lastEvent === "error"` → `"error"`
- connected → `"connected"`
- `lastEvent === "init"` (never opened) → `"disconnected"`
- otherwise (saw open/close, not currently up) → `"connecting"` (i.e.
  reconnecting)

**Map to our `ConnectionStatus`** (`"connecting"|"connected"|"disconnected"`):
`connected` → `"connected"`; `disconnected`/`init` → `"disconnected"`;
everything else (`connecting`/`error`/`degraded`) → `"connecting"` (drive a yellow
dot; use `lastError` for the tooltip). Subscribe with `onStatusChange` and
re-emit our `"status"` event.

### 6.5 Error types

- `UnsupportedCapabilityError` (`src/client/errors.ts:10`) — **extends
  `DooverApiError`**, carries `.capability` and `.clientId`. Thrown for
  un-advertised methods (all local cloud-only ops).
- `DooverApiError` (`src/http/errors.ts:1`) — `.status`, `.body`, `.url`,
  `.method`. Thrown for non-2xx REST responses (`rest-client.ts:135`).
- `DooverGatewayError` (`src/http/errors.ts:30`) — thrown by `gateway.send()`
  when the socket isn't OPEN (`gateway-client.ts:419`). **Relevant:** calling
  `sendOneShotMessage`/`subscribe` while disconnected will `void connect()` and
  return without throwing (`:274-278`), but a direct `send` on a closed socket
  throws this. Guard one-shots behind `isConnected()`.
- `DooverValidationError`, `DooverAuthError` (auth failures / refresh failures),
  `AmbiguousWriteError` (MultiplexClient only — not used).

`instanceof DooverApiError` catches both API errors and unsupported-capability
errors.

---

## 7. `DooverClient` (cloud, `CloudTransport`)

`src/client/doover-client.ts`. Constructor takes `DooverClientConfig`
(`src/http/rest-client.ts:6-30`).

### 7.1 Constructor config

```js
new DooverClient({
  dataRestUrl,     // REQUIRED — data/channels REST base
  controlApiUrl,   // REQUIRED — control API base (agents live here)
  dataWssUrl,      // REQUIRED — gateway WebSocket URL
  organisationId,  // optional; sets X-Doover-Organisation header
  sharing,         // "internal" (default) | "external" | "none"
  // ---- auth (AuthConfig, build-auth.ts:15-25) ----
  token,           // access token → sent as `Authorization: Bearer <token>`
  tokenExpires,    // Date|number; else decoded from JWT
  refreshToken,
  refreshTokenId,
  authServerUrl,       // e.g. https://auth.doover.com — needed for auto-refresh
  authServerClientId,  // needed for auto-refresh
  profile, configManager,  // OR: named ~/.doover/config profile (via /node ConfigManager)
  auth,            // OR: a pre-built DooverAuth (mutually exclusive with raw fields)
  fetchImpl, webSocketImpl, webSocketFactory, disableBrowserLifecycleHooks,
  sourceId,        // defaults to "cloud"
  sourceLabel,
});
```

### 7.2 Token auth + refresh (`DooverTokenAuth`, `src/auth/doover-token-auth.ts`)

- If any of `token`/`refreshToken`/`authServerUrl`/… is present, `buildAuth`
  constructs a `DooverTokenAuth` (`build-auth.ts:88-106`).
- Every REST request sends `Authorization: Bearer <token>` and uses
  `credentials:"omit"` (`doover-token-auth.ts:46-53`).
- **Auto-refresh:** before each request/WS connect, `ensureReady()` refreshes if
  the token is within 30 s of expiry (`:90-101`, `:141-148`). Refresh POSTs
  `{authServerUrl}/oauth2/token?grant_type=refresh_token&…` (`:162-167`) and needs
  **all three** of `authServerUrl`, `refreshToken`, `authServerClientId` or it
  throws `DooverAuthError` (`:151-160`). Refreshed tokens persist back to the
  config profile if one is attached (`:213-234`). Reconnecting WS uses the latest
  token automatically.
- A **long-lived bare `token`** (no refresh fields) also works — it just won't
  auto-refresh (open question in PLAN §9.2: the sanctioned way to mint a scoped
  long-lived token for a Node-RED install).

### 7.3 Production base URLs

doover-js does **not** hardcode any production URL — the caller supplies all
three. There are no defaults in `src` or `dist` (the README examples use
`example.com`). The production values, from pydoover's API auth
(`/Users/tomwyatt/pydoover/tests/test_api_auth.py:141-154`):

| `DooverClientConfig` field | Production value | pydoover env |
|---|---|---|
| `controlApiUrl` | `https://api.doover.com` | `BASE_URL` |
| `dataRestUrl` | `https://data.doover.com/api` | `BASE_DATA_URL` |
| `authServerUrl` | `https://auth.doover.com` | `AUTH_SERVER_URL` |
| `dataWssUrl` | **not defaulted by pydoover — CONFIRM** | — |

> `dataWssUrl` (the gateway WSS) is not present in pydoover's config; it is
> typically the data host over `wss` (candidate: `wss://data.doover.com/ws` or a
> dedicated gateway host). **Confirm the exact production gateway URL** with the
> platform team before shipping `CloudTransport`; make all four URLs config
> fields on the cloud connection node (default `controlApiUrl`/`dataRestUrl`/
> `authServerUrl` to the values above).

### 7.4 Targeting a specific agent (cloud)

The cloud client serves **all** agents (`getAgentScope()` → `{mode:"all"}`,
`doover-client.ts:148`). Unlike local, there is no implicit device — **you supply
the target `agentId` on every call**. `CloudTransport` is constructed with a
target agent id (from the connection node's agent picker, PLAN §2.2) and passes
it into every `patchAggregate(agentId, …)` / `getAggregate(agentId, …)` /
`subscribeToChannel({agent_id, …})`. `agents.listAgents()` (control API) backs the
agent-picker dropdown.

---

## 8. GatewayClient subscription + reconnect semantics (CRITICAL)

`src/gateway/gateway-client.ts`. Both clients expose the same `gateway`
(`GatewayClientLike`). The realtime WS protocol is op-coded JSON.

### 8.1 Subscribing

Use the **high-level** `subscribeToChannel` (`:205-258`), not the low-level
`subscribe`:

```js
const off = client.gateway.subscribeToChannel(
  { agent_id: agentId, name: channelName },
  {
    onMessage:       (msg) => {/* MessageStructure — a persisted append */},
    onAggregate:     (agg) => {/* Aggregate — merged state changed OR sync seed */},
    onMessageUpdate: (msg, requestData) => {/* edited message */},
  }
);
// later:
off(); // idempotent; last detach tears down the wire subscription
```

Semantics (`:205-258`):

- **Multiplexed by channel.** Multiple handler sets per channel share one wire
  subscription. First handler → wire `subscribe` (op 12); last detach → wire
  `unsubscribe` (op 13). This is exactly the "multiplex many callbacks per tag"
  behaviour PLAN §2.1 wants — and it fixes the pydoover footgun (second
  `subscribe_to_tag` replacing the first). **Build our per-callback fan-out on top
  of this**, one `subscribeToChannel` per channel.
- **`onAggregate` fires for BOTH `ChannelSync` and `AggregateUpdate`** (`:223-235`)
  — the initial seed and subsequent changes come through the same handler. There
  is no one-shot handler in `ChannelHandlers`; one-shots are a separate gateway
  event (see §8.4).
- **No auto-connect gap:** if the socket isn't up, `subscribe` calls
  `void connect()` and records the subscription; it is (re)sent on `ready`
  (`:172-175`, `resubscribeAll` `:411-415`).

**Mapping to our `ChannelMessage` event kinds** (transport.js `ChannelEventType`):

| our event | gateway source |
|---|---|
| `"sync"` | first `onAggregate` after subscribe — but see §8.3, **synthesize it yourself from `getAggregate`** |
| `"aggregate"` | subsequent `onAggregate` (AggregateUpdate) |
| `"message"` | `onMessage` (MessageCreate) |
| `"message_update"` | `onMessageUpdate` |
| `"oneshot"` | `oneShotMessage` gateway event (§8.4) |

### 8.2 Wire protocol (op codes)

From `handleMessage`/`send` (`:167-286`, `:331-409`) and confirmed by
`src/test/gateway-client.test.ts:101` (`[10,12,14,15,13]`):

- Outbound: `10` identify · `11` resume · `12` subscribe · `13` unsubscribe ·
  `14` syncChannel · `15` one-shot.
- Inbound (`op:0`, discriminated by `t`): `Hello` → identify/resume;
  `Ready`(`d`=session) → cache session, `resubscribeAll`; `ChannelSync`,
  `MessageCreate`, `MessageUpdate`, `AggregateUpdate`, `AlarmTrigger`,
  `OneShotMessage`, `ChannelSubscription`/`ChannelUnsubscription`, `WSSErrorEvent`.
  `op:3` → session cancelled (`session=null`, emit `sessionCancelled`).

### 8.3 Reconnect + replay — the tag-layer-critical part

**doover-js does NOT replay missed messages and does NOT re-fetch aggregates on
reconnect.** Precisely, on an unexpected close (`:140-143` → `scheduleReconnect`):

1. Exponential backoff with full jitter, base 1 s, cap 30 s
   (`:434-453`, `RECONNECT_BASE_MS`/`RECONNECT_CAP_MS` `:21-22`; verified by
   `gateway-client.test.ts:252-298`). `explicitlyDisconnected` (set by
   `disconnect()`) suppresses reconnect (`:148-157`, `:435`).
2. New socket → `Hello` → `identifyOrResume` (`:389-409`): because `session` is
   **retained across an unexpected close** (only `disconnect()`, `reconnect()`,
   and `op:3` clear it), it sends **op 11 RESUME** with the old
   `session_id`/`session_token`.
3. On `Ready`, `resubscribeAll()` re-sends **`subscribe` (op 12) only** for every
   tracked channel (`:411-415`). **It does NOT call `syncChannel` (op 14) and does
   NOT hit the aggregate REST API.**

Consequences:

- **Ephemeral one-shots / live values sent while disconnected are lost.** There is
  no client buffer. Whether a resumed server session backfills anything is a
  server guarantee not represented in doover-js — **do not rely on it.**
- **Persisted messages (`MessageCreate`) are not client-replayed.** If a resumed
  session doesn't push them, the consumer must re-fetch via
  `messages.listMessages`. For tags (which live in the aggregate) this doesn't
  matter; for message-consuming nodes it might.
- **The aggregate is only re-seeded if the server volunteers a `ChannelSync` in
  response to the op-12 subscribe.** `subscribeToChannel` never calls
  `syncChannel` itself. **Do not assume a fresh seed on reconnect.**

**MANDATE for the tag layer / `DooverTransport`:** treat `getAggregate` as the
source of truth for state, and **re-seed on every (re)connect**:

- On `subscribe`, immediately `await getAggregate(channel)` and deliver it as our
  synthetic `"sync"` event (this is already the documented contract:
  transport.js says `"sync"` is *"client-synthesised initial state … from the
  seeded `GetAggregate`"*). Don't wait for a gateway `ChannelSync`.
- Register a `gateway.on("ready", …)` listener (fires on first connect **and**
  every resume) and, for each subscribed tag channel, re-`getAggregate` and diff
  against last-known to emit change events. This closes the "missed
  AggregateUpdate during the outage" hole deterministically.
- Optionally also call `client.gateway.syncChannel(channelRef)` on `ready` to ask
  the server to push a fresh `ChannelSync`, but the REST re-fetch is the reliable
  path — the WS one depends on server behaviour.

`gateway.reconnect()` (`:311-329`) is a manual "reconnect now" that **drops the
session** (forces a fresh op-10 identify, not a resume) — useful for a debug
control, not the automatic path.

### 8.4 One-shot send

```js
client.gateway.sendOneShotMessage({ agent_id: agentId, name: channelName }, payload);
```

`:274-286` — op 15. Fire-and-forget (returns `void`, not a Promise). If
disconnected it triggers `connect()` and drops the message (no queue). Inbound
one-shots arrive as the `oneShotMessage` gateway event
(`GatewayOneShotMessage.d = {id, author_id, channel, data}`, `types.ts:93-102`),
**not** through `subscribeToChannel`'s `ChannelHandlers`. To receive them:

```js
client.gateway.on("oneShotMessage", (evt) => {
  if (evt.channel.agent_id === agentId && evt.channel.name === channelName) {
    /* evt.data is the payload */
  }
});
```

Our transport must fan these out per-channel itself (filter by `channel`), since
the gateway's per-channel registry only wires message/aggregate/sync — one-shots
are a flat event. Wrap `sendOneShot` to return a resolved Promise for the
`async` signature, guarding on `isConnected()`.

### 8.5 GatewayClient standalone (no client)

You can `new GatewayClient(config, auth?)` directly (`:66`). `DooverClient`/
`LocalAgentClient` already build one internally and expose it as `.gateway`; use
that. Only construct a bare `GatewayClient` if you want realtime without the REST
sub-clients (we don't — we need `getAggregate`).

---

## 9. Putting it together — LocalTransport skeleton

```js
const { LocalAgentClient, DooverApiError } = require("doover-js");

class LocalTransport extends DooverTransport {
  constructor({ baseUrl = "http://localhost:49100", wssUrl } = {}) {
    super();
    this._client = new LocalAgentClient({ baseUrl, wssUrl,
      disableBrowserLifecycleHooks: true });
    this._agentId = null;
    this._client.onStatusChange((s) => this._onStatus(s));
  }

  async connect() {
    await this._client.gateway.connect();
    const scope = await this._client.getAgentScope();   // resolves device id
    this._agentId = scope.mode === "list" ? scope.agentIds[0] : null;
    // re-seed tag state on every (re)connect:
    this._client.gateway.on("ready", () => this.emit("resync"));
  }
  async close() { this._client.gateway.disconnect(); }

  async publish(channel, payload, opts = {}) {
    const params = opts.recordLog ? { log_update: true } : undefined;
    const fn = opts.replaceData ? "putAggregate" : "patchAggregate";
    await this._client.aggregates[fn](this._agentId, channel, payload, params);
    // opts.maxAge has no doover-js equivalent — ignored.
  }

  subscribe(channel, cb) {
    const ref = { agent_id: this._agentId, name: channel };
    const off = this._client.gateway.subscribeToChannel(ref, {
      onAggregate: (agg) => cb({ channel, event: "aggregate",
        payload: agg.data, aggregate: agg.data }),
      onMessage: (m) => cb({ channel, event: "message", payload: m.data,
        messageId: m.id }),
      onMessageUpdate: (m) => cb({ channel, event: "message_update",
        payload: m.data, messageId: m.id }),
    });
    const onOneShot = (e) => { if (e.channel.name === channel)
      cb({ channel, event: "oneshot", payload: e.data }); };
    this._client.gateway.on("oneShotMessage", onOneShot);
    // synthesize the initial "sync" from REST, not from the gateway:
    this.getAggregate(channel).then((data) =>
      cb({ channel, event: "sync", payload: data, aggregate: data ?? {} }));
    return () => { off(); this._client.gateway.off("oneShotMessage", onOneShot); };
  }

  async getAggregate(channel) {
    const agg = await this._client.aggregates.getAggregate(this._agentId, channel);
    return agg?.data ?? null;
  }
  async sendOneShot(channel, payload) {
    this._client.gateway.sendOneShotMessage(
      { agent_id: this._agentId, name: channel }, payload);
  }
  agentId() { return this._agentId; }
  appKey() { return process.env.APP_KEY ?? null; }
  status() { return this._status; }
}
```

`CloudTransport` is identical except: `new DooverClient({dataRestUrl,
controlApiUrl, dataWssUrl, authServerUrl, token, refreshToken, …})`, and
`this._agentId` comes from the connection node's configured target agent (not
`getAgentScope`, which returns `{mode:"all"}`).

---

## 10. What we do NOT get from doover-js (build ourselves)

- **The tag layer** (app-key namespacing, nested KeyPath, diff-based change
  detection, `set_tags` atomic multi-write, `live` tags). doover-js has **no tag
  concept** — tags are our convenience layer over the `tag_values` channel
  aggregate, per PLAN §2.1. Build `TagClient` on `DooverTransport`.
- **`appKey`** — env/config, not doover-js.
- **`maxAge` publish semantics** — no doover-js field (§5.3).
- **Rate-limit / debounce guards** for cloud writes (PLAN §6) — our concern.
- **The abstract `DooverTransport` base + `MockTransport`** — hand-rolled; don't
  wrap doover-js for the mock.

---

## 11. fetch / WebSocket in Node 22/24

Global `fetch` and `WebSocket` exist in both Node 22 (app container) and Node 24
(local) — no `ws` / `undici` dependency needed for the happy path. The gateway
uses global `WebSocket` unless `webSocketImpl`/`webSocketFactory` is supplied
(`gateway-client.ts:125-133`); REST uses global `fetch` unless `fetchImpl` is set
(`rest-client.ts:125`). Use `webSocketFactory` (with the `ws` package) **only** if
you need to send cloud auth on the WS handshake via headers rather than the
`?token=` query param — global `WebSocket` can't set request headers.

---

## 12. Version drift: 0.6.5 (`src`) → 0.7.1 (`dist`)

Diffed the local 0.6.5 `src` against the installed 0.7.1 `dist`. **None of the
surfaces we use changed shape.** Confirmed identical in 0.7.1:

- `LocalAgentClientConfig` — byte-identical (`dist/client/local-agent-client.d.ts`).
- `LOCAL_CAPABILITIES` — same 12 caps (`dist/client/local-agent-client.js:14-25`),
  same gated method lists (`:76-79`).
- `AggregatesApi` — same `getAggregate` / `putAggregate` / `patchAggregate`
  signatures and paths (`dist/apis/aggregates-api.js`).
- Gateway op codes and `subscribeToChannel` / `syncChannel` /
  `sendOneShotMessage` — unchanged (`dist/gateway/gateway-client.js:149/163/229/242`).
- `DataClient` interface, `DooverClientConfig`, auth/refresh flow — unchanged.

**Additions in 0.7.1 (new exports, none breaking, none required by us):**

- **Offline cache layer:** `OfflineDataClient`, `MemoryOfflineStorageAdapter`,
  `DooverOfflineError`, `DEFAULT_OFFLINE_RETENTION_MS`
  (`dist/client/offline-cache.js`). A read-through/cache-first wrapper around a
  `DataClient` with per-channel retention policies. **Ignore for v1** — Node-RED
  is long-lived and we re-seed from `getAggregate` ourselves (§8.3).
- **Per-request options:** `requestOptions()`, `isDooverRequestOptions()`,
  `splitRequestOptions()`, and a `REQUEST_OPTIONS_SYMBOL`
  (`dist/client/request-options.js`). Lets you pass a **trailing options object**
  (`{ sources, cache, [symbol] }`) as the last arg to sub-client methods, mainly
  for `MultiplexClient` source-scoping and cache control.
  - **CJS trap to be aware of:** these helpers sniff the **last argument** of a
    sub-client call — an object is treated as request-options if it has a
    `sources` array, a `cache` key, or the symbol (`request-options.js:12-19`).
    Our aggregate `params` object (`{log_update, suppress_response,
    clear_attachments}`) has none of those keys, so it is **not** misinterpreted —
    safe. Just don't add a `cache` or `sources` key to a params object you intend
    as aggregate mutation params.

Because 0.6.5 and 0.7.1 agree on everything we touch, develop against the
installed **0.7.1 dist** and use the 0.6.5 `src` for readable, commented
reference. Pin `doover-js@0.7.x` in `nodered-core`'s `package.json`.

---

## 13. Quick reference — file:line citations (0.6.5 src)

| Topic | Source |
|---|---|
| `DataClient` interface | `src/client/data-client.ts:77` |
| `LocalAgentClientConfig` | `src/client/local-agent-client.ts:30` |
| `LOCAL_CAPABILITIES` | `src/client/local-agent-client.ts:47` |
| local agent scope resolution | `src/client/local-agent-client.ts:168` |
| `DooverClientConfig` | `src/http/rest-client.ts:6` |
| `DooverClient` ctor / all-caps | `src/client/doover-client.ts:73` / `:144` |
| token auth + refresh | `src/auth/doover-token-auth.ts:46,90,151` |
| `getAggregate`/`put`/`patch` + params | `src/apis/aggregates-api.ts:14,26,65` / `:5` |
| PUT=replace, PATCH=merge (migration) | `README.md:262-263` |
| channel resolution by name+agent | `src/apis/channels-api.ts:37`, `aggregates-api.ts:22` |
| `postMessage` / `record_log` | `src/apis/messages-api.ts:88` / `types/common.ts:38` |
| `subscribeToChannel` (multiplexed) | `src/gateway/gateway-client.ts:205` |
| gateway op codes / resume / resubscribe | `src/gateway/gateway-client.ts:389,411` |
| reconnect backoff (1s→30s jitter) | `src/gateway/gateway-client.ts:434,21` |
| `sendOneShotMessage` | `src/gateway/gateway-client.ts:274` |
| one-shot inbound event shape | `src/gateway/types.ts:93` |
| status tracker / state derivation | `src/client/status-tracker.ts:52` |
| error types | `src/client/errors.ts:10`, `src/http/errors.ts:1` |
| fetch/WS/factory injection | `src/http/rest-client.ts:13`, `gateway-client.ts:125` |
| prod URLs (control/data/auth) | `pydoover/tests/test_api_auth.py:141` |
| env contract (APP_KEY, DDA_URI…) | PLAN §7; `pydoover/pydoover/docker/application.py:1272` |
</content>

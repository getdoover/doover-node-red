# Device Agent gRPC Transport Contract

**Audience:** the implementer of `LocalTransport` in `@doover/nodered-core`, using
`@grpc/grpc-js` + `@grpc/proto-loader` against the on-device Doover Device Agent (DDA).

**Authoritative sources** (this doc is a distillation; the proto wins on any conflict):

- Proto: `pydoover/protos/device_agent.proto` — all line citations below are into this file.
- Reference client (the behaviour to replicate): `pydoover/pydoover/docker/device_agent/device_agent.py`
  (`DeviceAgentInterface`) and its base `pydoover/pydoover/docker/grpc_interface.py`
  (`GRPCInterface`).
- Data model shapes: `pydoover/pydoover/models/data/{aggregate,message,channel,events}.py`.

> **The single most important thing in this document:** the modern reference client
> **does not use `WriteToChannel` or `GetChannelSubscription`** (the two RPCs named in
> `PLAN.md`). It publishes with **`CreateMessage`** / **`UpdateAggregate`** / **`SendOneShotMessage`**
> and subscribes with **`ChannelEventSubscription`**. The `WriteToChannel` /
> `GetChannelSubscription` pair is the legacy API — still present in the proto and stubs,
> but abandoned by the reference implementation. Build against the modern set. See
> [§2 The two eras](#2-the-two-eras-critical) before writing any code.

---

## 1. Connection basics

### 1.1 Service identity (for proto-loader)

- Proto `package device_agent;` (proto line 5), `service deviceAgent` (proto line 8).
- Fully-qualified gRPC service name on the wire: **`device_agent.deviceAgent`**
  (confirmed in the generated stub method paths, e.g. `/device_agent.deviceAgent/CreateMessage`).
- Load the vendored `device_agent.proto`; access the client constructor as
  `grpcObj.device_agent.deviceAgent`.

### 1.2 Endpoint & channel

- Endpoint comes from env var **`DDA_URI`**, default **`localhost:50051`** (verified on-device
  env contract; pydoover's own default is `127.0.0.1:50051`, `device_agent.py:109`).
- **Insecure channel** only — `grpc.credentials.createInsecure()`. The reference client uses
  `grpc.aio.insecure_channel(self.uri)` everywhere (`grpc_interface.py:32`, `device_agent.py:310`).
  No TLS, no auth metadata on the socket. It is a localhost unix-adjacent TCP endpoint.
- **Unary calls**: the Python client opens a **fresh channel per request** (`async with ...`
  in `make_request`, `grpc_interface.py:30-35`) with a **default 7-second deadline**
  (`dda_timeout=7`, `device_agent.py:111`). In JS you may instead keep one long-lived
  `grpc.Client` and pass a per-call `deadline`; either is fine. Use a ~7 s deadline on unary calls.
- **Streaming calls**: a dedicated long-lived channel per subscription (`device_agent.py:310`).

### 1.3 How `app_key` is passed — `RequestHeader.app_id`

- Every request message embeds a `RequestHeader` (proto lines 30-32):
  ```proto
  message RequestHeader { optional string app_id = 1; }
  ```
- The **app key string** (env var `APP_KEY`) goes into **`header.app_id`**. There is no
  metadata-based auth; identity is this field only.
- The reference client sets `header = RequestHeader(app_id=self.app_key)` on:
  `CreateMessage` (`device_agent.py:548`), `SendOneShotMessage` (`:564`),
  `UpdateMessage` (`:588`), `GetTurnCredential` (`:479`).
- **Footgun — inconsistent header population:** the reference client **omits the header
  entirely** on `UpdateAggregate` (`update_channel_aggregate`, `device_agent.py:614-621` — no
  `header=`), on `GetAggregate` (`:468`), `GetMessage` (`:492`), `GetMessages` (`:526`),
  and `FetchAttachment` (`:627`). The DDA tolerates a missing/empty `app_id` on these — it is
  the single-tenant local agent and infers context. **Recommendation:** always set
  `header.app_id = APP_KEY` on every request anyway; it is harmless where ignored and correct
  where used. Do not rely on the header for tag namespacing — that is done inside the payload
  (see [§7](#7-tags-ride-on-the-aggregate)).

### 1.4 proto-loader options you MUST set

64-bit integer fields (`message_id`, `agent_id`, `author_id`, all timestamps) are **Snowflake
IDs / epoch-millis that exceed `2^53`** and will silently lose precision if decoded as JS
`number`. Load with:

```js
const def = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,   // preserve snake_case field names (channel_name, response_header, …)
  longs: String,    // uint64 -> string; REQUIRED, ids/timestamps overflow Number
  enums: String,
  defaults: true,
  oneofs: true,
});
```

- With `keepCase: true`, every field name in this document maps 1:1 to the JS object key
  (`response_header`, not `responseHeader`). If you omit it, translate to camelCase yourself.
- `longs: String` means you handle `message_id` etc. as strings. To derive a timestamp from a
  Snowflake, do it in BigInt (see [§8.3](#83-snowflake-ids)).

### 1.5 The `google.protobuf.Struct` friction — read before choosing RPCs

The modern RPCs carry their JSON payload in a **`google.protobuf.Struct data`** field
(proto imports `google/protobuf/struct.proto`, line 3). **`@grpc/proto-loader` does NOT
transparently convert `Struct` to/from a plain JS object.** A decoded `Struct` arrives as the
nested `{ fields: { key: { kind, ... } } }` wire form, and to send one you must build that form.
You have two options:

1. **Convert Struct yourself** (recommended, matches the reference client). Implement two small
   helpers `jsToStruct(obj)` / `structToJs(struct)`, or reuse `google-protobuf`'s
   `google.protobuf.Struct` well-known-type helpers (`Struct.fromJavaScript` /
   `struct.toJavaScript`). The Python side does exactly this via
   `json_format.ParseDict(dict, Struct())` on send (`device_agent.py:542-543`) and
   `MessageToDict(struct)` on receive (`message.py:72`, `aggregate.py:48`).
2. **Use the legacy string-payload RPCs** (`WriteToChannel` / `GetChannelSubscription`), whose
   payload is a plain **JSON `string`** you `JSON.stringify` / `JSON.parse` — zero Struct
   marshalling. This is tempting for JS ergonomics but the reference client has abandoned this
   path; treat it as fallback only. See [§2](#2-the-two-eras-critical).

**Decision for this project:** implement the Struct helpers and use the modern RPCs. It keeps
`@doover/nodered-core` on the same contract the platform actively maintains and matches the event
stream (which is Struct-only — there is no legacy string variant of `ChannelEventSubscription`).

---

## 2. The two eras (critical)

The proto contains two overlapping generations of channel API. `PLAN.md §2.1` references the
older one; the reference client uses the newer one. Do not mix them per-channel.

| Concern | Legacy (avoid) | Modern (**use this**) |
|---|---|---|
| Publish persisted msg | `WriteToChannel` (proto :15) | `CreateMessage` (proto :20) |
| Publish "current value" | `WriteToChannel` w/ `save_log=false` | `UpdateAggregate` (proto :22) |
| Publish ephemeral/live | — | `SendOneShotMessage` (proto :27) |
| Subscribe | `GetChannelSubscription` (proto :13) | `ChannelEventSubscription` (proto :14) |
| Read current value | `GetAggregate` (proto :18) | `GetAggregate` (proto :18) — shared |
| Payload encoding | `string` (JSON text) | `google.protobuf.Struct` |
| Used by reference client? | **No** | **Yes** |

`GetAggregate` and `TestComms` are shared across both eras.

The legacy `ChannelWriteRequest` (proto :101-108) and `ChannelSubscriptionResponse`
(proto :95-99) are documented in [§9](#9-legacy-rpcs-reference-only) for completeness only.

---

## 3. Publishing

There are three distinct publish semantics. Choosing the wrong one is the classic Doover
footgun (message vs aggregate vs one-shot). Map them to the palette nodes as noted.

### 3.1 `UpdateAggregate` — set the channel's "current value" (the default publish)

This is what most people mean by "publish to a channel": update the channel's single
merged **aggregate** (its live state), optionally logging a historical datapoint.

- RPC: `UpdateAggregate (UpdateAggregateRequest) returns (UpdateAggregateResponse)` (proto :22).
- Request `UpdateAggregateRequest` (proto :262-273):
  | field | # | type | meaning |
  |---|---|---|---|
  | `header` | 1 | `RequestHeader` | app_id (reference client omits — see §1.3) |
  | `channel_name` | 2 | `string` | target channel |
  | `data` | 4 | `Struct` | JSON object payload (**top level MUST be an object**) |
  | `files` | 5 | `repeated File` | inline file attachments (bytes) |
  | `clear_attachments` | 6 | `optional bool` | drop existing attachments first |
  | `replace_data` | 7 | `optional bool` | **false ⇒ deep-merge** into existing aggregate; true ⇒ replace wholesale |
  | `max_age_secs` | 8 | `float` | see below |
  | `save_log` | 9 | `bool` | if true, also writes a logged historical datapoint |
- Response `UpdateAggregateResponse` (proto :275-278): `response_header`, `aggregate`
  (the full merged `Aggregate` after the write — see [§5](#5-aggregate-shape)).
- **Merge semantics:** default (`replace_data=false`) deep-merges `data` into the existing
  aggregate. This is how partial updates and the tag layer work — you send only the keys you
  changed. Set `null` for a key to delete it (the UI-schema clear at `application.py:1169` sends
  `{"state":{"children":{app_key: None}}}` to remove a subtree).
- **`max_age_secs` (footgun):** it is the max age before the aggregate is pushed to cloud, i.e.
  a debounce/coalescing window, **not** a TTL on the data. `max_age_secs = -1` forces an
  **immediate** cloud publish (used for UI schema, `application.py:1170,1175`). The reference
  `update_channel_aggregate` passes `max_age_secs=None` by default (`device_agent.py:607,620`);
  proto-wire it as the float field — send `-1` when you need an instant push, otherwise a small
  positive number (or let it default) to batch.
- **`save_log`:** the aggregate always reflects current state; `save_log=true` additionally
  records a point in channel history. This is the "record_log"/"log this write" option in the
  `channel out` / `tag out` nodes (`PLAN.md §3.1, §3.2`). Reference client's
  `update_channel_aggregate` does not expose `save_log` in its signature, but the field exists
  (proto :273) — set it directly.

Node mapping: `channel out` (default mode), `tag out`, `aggregate`-style current-value writes.

### 3.2 `CreateMessage` — append a persisted message (event/log entry)

Use when every write is a discrete historical record (activity log, event), not a mutable
current value.

- RPC: `CreateMessage (CreateMessageRequest) returns (CreateMessageResponse)` (proto :20).
- Request `CreateMessageRequest` (proto :226-233):
  | field | # | type | meaning |
  |---|---|---|---|
  | `header` | 1 | `RequestHeader` | app_id (reference client **sets** this) |
  | `channel_name` | 2 | `string` | target channel |
  | `data` | 3 | `Struct` | JSON object payload |
  | `files` | 4 | `repeated File` | attachments |
  | `timestamp` | 5 | `uint64` | **epoch milliseconds** |
- Response `CreateMessageResponse` (proto :235-238): `response_header`, `message_id` (`uint64`,
  the new Snowflake — decode as string, see §1.4).
- Reference client `create_message` (`device_agent.py:534-555`): validates the payload
  ([§8.1](#81-payload-validation-rules)), converts dict→Struct, defaults `timestamp` to
  **now in ms** (`int(datetime.now(utc).timestamp()*1000)`, `:546`), always sets the header.
- **Every `CreateMessage` is persisted and logged** — there is no `save_log` flag because a
  message *is* a log entry. Do not use `CreateMessage` for high-rate current values; that is
  what the aggregate (§3.1) or one-shot (§3.3) are for.

Node mapping: `channel out` (message mode), `activity` log node.

### 3.3 `SendOneShotMessage` — ephemeral live value (not persisted)

For high-rate "live" values (video-adjacent telemetry, cursor-style updates) that should reach
live subscribers but never be stored or update the aggregate.

- RPC: `SendOneShotMessage (SendOneShotMessageRequest) returns (SendOneShotMessageResponse)` (proto :27).
- Request `SendOneShotMessageRequest` (proto :313-318):
  | field | # | type | meaning |
  |---|---|---|---|
  | `header` | 1 | `RequestHeader` | app_id (reference client **sets** this) |
  | `channel_name` | 2 | `string` | target channel |
  | `data` | 3 | `Struct` | JSON object payload |
  | `timestamp` | 4 | `optional uint64` | epoch ms; **only sent if provided** |
- Response `SendOneShotMessageResponse` (proto :320-322): `response_header` only — no id, no body.
- Reference client `send_oneshot_message` (`device_agent.py:557-570`): converts dict→Struct,
  sets header, and sets `timestamp` **only if the caller passed one** (`:568-569`) — unlike
  `CreateMessage` it does not default to now.
- One-shots do **not** update the aggregate and do **not** appear in history. A subscriber that
  connects later will never see them (no replay). Arriving one-shots surface on the subscription
  stream as `event_name == "OneShotMessage"` (see [§4](#4-subscribing)).

Node mapping: `tag out` with **live** option; `channel out` one-shot mode (`PLAN.md §3.1, §3.2`).

### 3.4 Publish decision table

| You want… | RPC | Persisted? | Updates aggregate? | Seen by late subscriber? |
|---|---|---|---|---|
| Current value / dashboard number | `UpdateAggregate` (`save_log=false`) | no | **yes** | yes (via `GetAggregate`) |
| Current value + history point | `UpdateAggregate` (`save_log=true`) | yes | **yes** | yes |
| Discrete event / log record | `CreateMessage` | yes | no | yes (via `GetMessages`) |
| High-rate live tick | `SendOneShotMessage` | no | no | **no** |

---

## 4. Subscribing — `ChannelEventSubscription` (server-streaming)

This is the modern subscription used by the reference client
(`stream_channel_events`, `device_agent.py:306-357`). It is a single **server-streaming** RPC:
the client sends one request, the server streams events until the channel closes or errors.

- RPC: `ChannelEventSubscription (ChannelEventSubscriptionRequest) returns (stream ChannelEventSubscriptionResponse)` (proto :14).
- Request `ChannelEventSubscriptionRequest` (proto :280-284):
  `header` (2, `RequestHeader`), `channel_name` (1, `string`). Reference client sends only
  `channel_name` (`device_agent.py:311-313`).
- Streamed `ChannelEventSubscriptionResponse` (proto :286-291):
  | field | # | type | meaning |
  |---|---|---|---|
  | `response_header` | 1 | `ResponseHeader` | check `.success` on **every** frame |
  | `event_name` | 2 | `string` | discriminator (see below) |
  | `channel_name` | 3 | `string` | echoes the channel |
  | `data` | 4 | `Struct` | event payload; **shape depends on `event_name`** |

### 4.1 Message framing & the `event_name` discriminator

Each stream frame is one event. Switch on `event_name` (`device_agent.py:330-346`):

| `event_name` | `data` (Struct) shape | JS meaning |
|---|---|---|
| `"MessageCreate"` | a **Message** dict: `{ id, author_id, channel:{agent_id,name}, data:{…}, attachments:[…] }` | a persisted message was appended |
| `"MessageUpdate"` | `{ channel, author_id, organisation_id, message:{…Message…}, request_data:{…} }` | an existing message was edited |
| `"AggregateUpdate"` | `{ author_id, channel, aggregate:{data,attachments,last_updated}, request_data:{…}, organisation_id }` | the channel aggregate changed |
| `"OneShotMessage"` | same as `MessageCreate` (a Message dict) | an ephemeral one-shot arrived |

Field-shape references: `Message.from_dict` (`message.py:47-55`),
`MessageUpdateEvent.from_dict` (`events.py:103-111`),
`AggregateUpdateEvent.from_dict` (`events.py:145-153`),
`OneShotMessage` is a subclass of `MessageCreateEvent` (`events.py:64-67`).

- The actual **user payload** you care about is almost always `data.data` (for message events:
  `event.data.data`) or `data.aggregate.data` (for aggregate updates). The outer `data` is the
  event envelope; the inner `data` is the JSON object the publisher sent.
- `event_name` values not in the table are ignored by the reference client (the `match` has no
  default, `device_agent.py:330`). Ignore unknown event names; do not crash.
- **Every frame carries a `response_header`. If `response_header.success == false`, treat it as
  a stream error and reconnect** (`device_agent.py:325-328` raises `RuntimeError` on
  `not success`).

### 4.2 Initial sync — you MUST seed the aggregate yourself

**The stream does NOT deliver the current state on subscribe.** It only carries live events
from the moment you connect. The reference client synthesises initial state
(`_run_channel_stream`, `device_agent.py:230-265`):

1. Call `GetAggregate(channel_name)` to fetch current state (`fetch_channel_aggregate`, `:237`).
2. If the channel doesn't exist (`NotFoundError`), create it with an empty aggregate via
   `UpdateAggregate(channel, {})` (`:243-248`).
3. Mark the channel **synced** (`_synced_channels[channel] = True`, `:252`).
4. Fire a **client-synthesised `ChannelSyncEvent`** carrying that aggregate to subscribers
   (`:254-265`) — this is how deliver-current-value-on-connect
   (`channel in` "emit aggregate on connect", `tag in` "emit current value on deploy") works.
5. *Then* open the `ChannelEventSubscription` stream and forward live events.

> **`ChannelSyncEvent` is not a wire event.** There is no `"ChannelSync"` `event_name` on the
> stream. It is entirely client-side: you emit it after your own `GetAggregate` seed. `@doover/
> nodered-core` should do the same — do the `GetAggregate` first, emit an initial/"sync"
> callback, then attach the live stream.

### 4.3 Aggregate cache & channel-sync semantics

The reference client keeps a per-channel cache and a synced flag:

- On each `AggregateUpdate` event it overwrites its cached aggregate, sets
  `_synced_channels[channel]=True`, and records `last_channel_message_ts[channel]=now`
  (`device_agent.py:276-281`).
- `is_channel_synced(channel)` (`:378-399`) returns true only if the channel has a callback
  registered **and** has been seeded/updated at least once. It is described as "only really
  useful for timing during the startup process" — during normal operation it is always true
  while the DDA is up.
- `fetch_channel_aggregate` returns the **cached** aggregate if the channel is subscribed,
  otherwise makes a live `GetAggregate` call (`:462-470`). So once subscribed, reads are free
  and always current. Replicate this cache in `@doover/nodered-core` so `aggregate get` and
  `tag get` on a subscribed channel don't hit gRPC.

### 4.4 Reconnect & backoff semantics (replicate exactly)

Two nested retry layers in the reference client:

1. **Transport reconnect** (`stream_channel_events`, `device_agent.py:306-357`): wraps the whole
   subscribe-and-read loop. On any exception it logs, sleeps `backoff`, then
   `backoff = min(backoff*2, time_between_connection_attempts)` — i.e. **exponential backoff
   starting at 1 s, doubling, capped at 10 s** (`time_between_connection_attempts=10`,
   `device_agent.py:112`). `backoff` is **reset to 1** on every successful connect
   (`:318`). `StopAsyncIteration` (server ended the stream cleanly) breaks the inner read loop
   and reconnects.
2. **Task-crash restart** (`_run_channel_stream`, `device_agent.py:272-304`): an outer
   `while True` around the event-dispatch loop so that an uncaught error in a *callback* or the
   dispatch body doesn't kill the subscription task — it logs, `sleep(1)`, and re-enters. The
   code comment (`:267-271`) is explicit that without this, a subscription silently dies until
   process restart.

**For JS:** wrap the `@grpc/grpc-js` streaming call so that `'error'` and `'end'` events both
trigger a reconnect with the same 1→10 s capped exponential backoff, resetting the backoff once
`'data'` (or `'metadata'`) confirms a live stream. Never let a stream error be terminal. Surface
the connected/reconnecting state as the node status dot (`ConnectionStatus`, `PLAN.md §2.1`).

### 4.5 Multiplexing callbacks (project requirement)

The reference client runs **one stream per channel** and fans out to many registered callbacks
(`_event_callbacks: dict[channel, list[(callback, EventSubscription)]]`, `device_agent.py:127`;
registration `add_event_callback`, `:183-214`; `_ensure_stream` guarantees a single task per
channel, `:176-181`). Each callback carries an `EventSubscription` flag-set
(`message_create | message_update | aggregate_update | oneshot_message | channel_sync`,
`events.py:10-22`) and only receives matching event types (`:287-296`). `@doover/nodered-core`
must do the same single-stream-many-subscribers multiplex — and this is precisely where the
PLAN wants us to fix the pydoover *tag*-layer footgun (`PLAN.md §2.1`: a second
`subscribe_to_tag` silently replacing the first). Multiplex at both the channel-event layer and
the tag layer.

---

## 5. Aggregate shape

### 5.1 `GetAggregate` — read current value

- RPC: `GetAggregate (GetAggregateRequest) returns (GetAggregateResponse)` (proto :18).
- Request `GetAggregateRequest` (proto :293-296): `header` (1), `channel_name` (2).
- Response `GetAggregateResponse` (proto :298-301): `response_header`, `aggregate`.
- **404 handling:** if the channel doesn't exist the response comes back with
  `response_header.success=false` and `response_code=404`, which the base client turns into a
  `NotFoundError` (`grpc_interface.py:58-59`). The reference subscription flow catches this and
  creates the channel (`device_agent.py:239-248`). For a bare `aggregate get` node, surface
  "channel not found" rather than a generic error.

### 5.2 `Aggregate` message (proto :256-260)

| field | # | type | meaning |
|---|---|---|---|
| `data` | 1 | `Struct` | the merged current-value JSON object |
| `attachments` | 2 | `repeated Attachment` | file refs (url-based, see §6) |
| `last_updated` | 3 | `optional uint64` | **epoch milliseconds** of last update |

Decode (`Aggregate.from_proto`, `aggregate.py:46-52`): `data` via `MessageToDict` (→ plain
object), `last_updated` divided by 1000 → seconds → UTC datetime. In JS: `Number(last_updated)`
is safe only if you kept it as string then `parseInt`; treat it as ms since epoch
(`new Date(Number(last_updated))`).

---

## 6. Messages, attachments, and file transfer (supporting RPCs)

These back `channel in` history reads and any attachment handling. Lower priority for Phase 0/1
but part of the contract.

- `GetMessage` (proto :23, req :201-205, resp :207-210): fetch one message by `message_id`
  (`uint64`). Returns a `Message`.
- `GetMessages` (proto :24, req :212-219, resp :221-224): list with `before`/`after`
  (Snowflake cursors, `optional uint64`), `limit` (`optional uint32`), and `field_names`
  (`repeated string`, project only some fields). Reference `list_messages`
  (`device_agent.py:499-531`) converts `datetime` cursors to Snowflakes via
  `generate_snowflake_id_at`.
- `UpdateMessage` (proto :21, req :240-249, resp :251-254): edit an existing message; supports
  `replace_data` and `clear_attachments` like `UpdateAggregate`. Note `message_id` here is a
  **`string`** (proto :243), unlike `CreateMessage`'s `uint64` result — the reference client
  stringifies it (`device_agent.py:590`).
- `FetchAttachment` (proto :25, req :303-306, resp :308-311): resolve an `Attachment` (metadata
  with a `url`) into a `File` (actual `bytes`).

### 6.1 `Message` (proto :193-199)

`message_id` (uint64), `author_id` (uint64), `channel` (`ChannelID{agent_id uint64, name string}`,
proto :188-191), `data` (Struct), `attachments` (repeated `Attachment`).

### 6.2 `File` vs `Attachment`

- `File` (proto :174-179): `filename`, `content_type`, **`bytes data`**, `size_bytes` — inline
  content, used when **sending** files in `CreateMessage`/`UpdateAggregate`/`UpdateMessage`.
- `Attachment` (proto :181-186): `filename`, `content_type`, `size_bytes`, **`url`** — a
  reference returned on reads; dereference with `FetchAttachment` to get the `File` bytes.

---

## 7. Tags ride on the aggregate

Not a separate RPC — tags are a convenience layer over the **`tag_values`** channel aggregate
(`PLAN.md §2.1`; reference tag layer in `application.py`). Key facts the transport layer must
honour so `@doover/nodered-core` can rebuild the tag layer on top of `DooverTransport`:

- Tag reads/writes are aggregate reads/writes on the single channel **`tag_values`**.
- **Namespacing is inside the payload, not the header.** Per-app tags live under the app key,
  global tags under a global namespace; keys are nested paths. `set_tag` deep-merges via
  `UpdateAggregate(replace_data=false)` (see the diff/merge at `application.py:1065-1069`).
- **`only_if_changed`** (default true) — diff against current cache, only write changed keys
  (`application.py:983-995`). This is your rate-limit against hammering the aggregate.
- **`log`** on `set_tag` (`application.py:961,985-987`) → maps to `save_log=true` on the
  underlying `UpdateAggregate`: record a history point in addition to the current value.
- **`live` tags** are streamed via `SendOneShotMessage` rather than aggregate writes
  (`PLAN.md §2.1`, live-tag keys registered at `application.py:1156`).
- Tag change-detection on the read side comes from `AggregateUpdate` events on `tag_values`:
  diff new aggregate vs cached to find which tags changed (this is what drives `tag in`
  only-on-change).

Key/payload constraints are enforced by `validate_payload` — see [§8.1](#81-payload-validation-rules).

---

## 8. Encoding, validation, and other footguns

### 8.1 Payload validation rules

`validate_payload` (`device_agent.py:45-78`) is run before every `CreateMessage`,
`UpdateMessage`, and `UpdateAggregate` (`:541,582,609`). Enforce the same in JS to fail fast
with good errors instead of opaque gRPC failures:

- **Top level must be an object/dict** (`:54-55`). You cannot publish a bare array, string, or
  number as a channel payload — wrap it (`{ value: 42 }`).
- **Keys must be strings matching `^[a-zA-Z0-9_-]+$`** (`_VALID_KEY_RE`, `:41`, checked `:65`).
  No dots, spaces, slashes, or unicode in keys. (Note: tag *paths* use dots at the API surface
  but are split into nested objects before hitting the wire — the on-wire keys are still
  `[A-Za-z0-9_-]+`.)
- **Values** may be object, array, string, number, boolean, or null (`_SCALAR_TYPES`, `:42`;
  arrays and nested dicts recurse, `:71-78`). Anything else (Date, Buffer, function, undefined,
  BigInt, NaN/Infinity) is invalid — convert first. `undefined` object properties must be
  dropped, not sent.

### 8.2 Timestamps are epoch **milliseconds**

Every timestamp field (`CreateMessageRequest.timestamp` proto :232,
`SendOneShotMessageRequest.timestamp` :317, `Aggregate.last_updated` :259) is **ms since epoch
as uint64**. The reference client multiplies `datetime.timestamp()` (seconds) by 1000 and casts
to int (`device_agent.py:546,569`; `aggregate.py:64`). In JS `Date.now()` is already ms — pass
it directly (as a string if `longs:String`). Do **not** send seconds.

### 8.3 Snowflake IDs

`message_id`, `author_id`, `agent_id` are 64-bit Snowflake IDs. They exceed `Number.MAX_SAFE_INTEGER`
— keep them as strings (`longs:String`). The creation time is encoded in the high bits; pydoover
derives it with `get_datetime_from_snowflake` (`message.py:44-45`). If you need a message's
timestamp, either read it from the message's own `data`/context or port the Snowflake epoch math
using `BigInt` — never round-trip the id through `Number`.

### 8.4 `ResponseHeader` and error handling (proto :34-40)

```proto
message ResponseHeader {
  bool success = 1;
  bool cloud_synced = 2;   // device is currently online to the cloud
  bool cloud_ready = 5;
  optional int32 response_code = 3;
  optional string response_message = 4;
}
```

- **`success`** — check on every unary response *and every stream frame*. The base client raises
  when false (`grpc_interface.py:50-61`): `response_code == 404` → `NotFoundError`, otherwise
  `HTTPError(code, message)` with `code` defaulting to 500 and `message` from `response_message`
  (falls back through `message`/`response_message`/"Unknown error").
- **`cloud_synced`** drives online/offline state. The reference client maps it to
  `is_dda_online` / `has_dda_been_online` (`update_dda_status`, `device_agent.py:364-376`):
  `success=true` ⇒ DDA reachable (`is_dda_available`); `cloud_synced=true` ⇒ DDA is online to the
  cloud. Use these to drive the node status dots (`PLAN.md §6`: green/yellow/red).
  **Important:** `cloud_synced=false` does **not** mean the write failed — the DDA accepts writes
  while offline and syncs later. Only `success=false` is a failure. `cloud_ready` is an
  additional readiness flag; the reference client does not branch on it — treat truthy as "cloud
  path healthy", don't gate writes on it.

### 8.5 Availability & health — waiting for the DDA

- **Health check** uses the standard **gRPC Health service**, not a DDA method:
  `grpc.health.v1.Health/Check` with `HealthCheckRequest{ service: "doover.DeviceAgent" }`
  (`grpc_interface.py:65-80`). Note the health *service name string* is **`doover.DeviceAgent`**
  (`device_agent.py:113`) — different from the gRPC service path `device_agent.deviceAgent`.
  `SERVING` ⇒ healthy. Vendored proto: use `grpc_health_v1` / the health proto; if you don't want
  the health proto, fall back to `TestComms` as a liveness probe.
- The subscription flow calls `wait_until_healthy()` **before** seeding/streaming
  (`device_agent.py:232`). Replicate: don't open a subscription until the DDA answers a health
  (or `TestComms`) check, then let the backoff loop take over.
- **Known upstream bug — do not copy it:** `DeviceAgentInterface.wait_until_healthy`
  (`device_agent.py:152-174`) computes `backoff = min(backoff*2, 1)`, which pins the backoff at
  **1 second forever** (the cap should be larger). Implement a real capped exponential backoff in
  JS (e.g. 1→2→4→…→10 s). The base-class `wait_until_healthy` (`grpc_interface.py:82-88`) just
  polls at a fixed interval and is fine.
- **DDA-unavailable behaviour:** the base `make_request` wraps every failure in a `DooverAPIError`
  after logging (`grpc_interface.py:36-42`) with the 7 s deadline. There is **no built-in retry on
  unary calls** — one attempt, then raise. Retry/backoff exists only on the *streaming* path
  (§4.4). For unary node operations, mirror this: single attempt with a deadline, surface the
  error to the node, reflect disconnected status; queue-or-fail is a node-level policy
  (`PLAN.md §6`: v1 = fail + status, not infinite queue).

### 8.6 `TestComms` — echo / liveness (proto :9)

- Request `TestCommsRequest` (proto :60-63): `header` (2), `message` (1, `string`).
- Response `TestCommsResponse` (proto :65-68): `response_header`, `response` (`string`).
- A trivial round-trip to prove the socket and app identity work. Use it as a cheap liveness
  probe on the connection config node ("This device (local)") and when the health proto isn't
  vendored.

### 8.7 redb store growth (device-side)

Not a gRPC field, but a transport-adjacent footgun from `PLAN.md §5.3`: the DDA's redb store has
no compression and never shrinks past its high-water mark. Don't `save_log=true` on every write
of large payloads (e.g. flows JSON). Prefer `UpdateAggregate` with a sensible `max_age_secs` and
log sparingly. This informs the default of the `record_log`/`log` options on the output nodes.

---

## 9. Legacy RPCs (reference only — do not build on these)

Documented so you recognise them and can choose the string-payload path if Struct marshalling
proves untenable. The reference client uses neither.

### 9.1 `WriteToChannel` (proto :15)

- Request `ChannelWriteRequest` (proto :101-108):
  | field | # | type | meaning |
  |---|---|---|---|
  | `header` | 5 | `RequestHeader` | app_id |
  | `channel_name` | 1 | `string` | target |
  | `message_payload` | 2 | `string` | **JSON text** (`JSON.stringify` your object) |
  | `save_log` | 3 | `optional bool` | record history point |
  | `max_age` | 4 | `optional int32` | max age **seconds** (int) |
  | `max_age_f` | 6 | `optional float` | max age seconds (float, higher precision) |
- Response `ChannelWriteResponse` (proto :114-117): `response_header`, `message_id` (`string`).
- Note `max_age` lives on the *write* here (as int seconds or the float `max_age_f`), whereas the
  modern path puts `max_age_secs` (float) on `UpdateAggregate`. Same concept, different field.
- **The one genuine advantage:** payload is a plain JSON string — no `Struct` conversion. If you
  adopt this path, `channel_name` + `JSON.stringify(payload)` + `save_log` is the whole write.

### 9.2 `GetChannelSubscription` (proto :13)

- Request `ChannelSubscriptionRequest` (proto :90-93): `header` (2), `channel_name` (1).
- Streamed `ChannelSubscriptionResponse` (proto :95-99): `response_header`, `channel`
  (`ChannelDetails{channel_name, optional aggregate}` proto :49-52 — where `aggregate` is a
  **JSON string**), `message` (`MessageDetails{message_id, channel_name, payload, timestamp}`
  proto :42-47 — where `payload` is a **JSON string**).
- Simpler wire shape (everything is JSON strings, no Struct, no typed event discriminator) but it
  gives you only message + aggregate, not the one-shot / message-update / typed-event richness of
  `ChannelEventSubscription`, and it is not what the platform exercises. **Prefer
  `ChannelEventSubscription`.**

### 9.3 Other RPCs present in the proto but out of scope

`ChannelEventSubscription` is documented in §4. `GetTurnCredential` (proto :19, WebRTC TURN creds
for camera nodes), `GetDebugInfo` (proto :16, DDA internal state — `wss_connected`, pending
messages, channel sync timestamps; useful for a diagnostics node later), and the commented-out
`GetChannelDetails`/`GetTempAPIToken` (proto :11,17) are not needed for the transport layer.

---

## 10. Quick implementation checklist for `LocalTransport`

1. Load `device_agent.proto` with `{ keepCase:true, longs:String, enums:String, defaults:true, oneofs:true }`; client = `pkg.device_agent.deviceAgent`; insecure creds; endpoint `DDA_URI` (default `localhost:50051`).
2. Implement `jsToStruct` / `structToJs` for `google.protobuf.Struct`. Validate payloads per §8.1.
3. Always set `header.app_id = APP_KEY` on every request.
4. `publish` → `UpdateAggregate` (merge; `save_log` from `recordLog`; `max_age_secs` from `maxAge`, `-1` for instant).
5. `sendOneShot` → `SendOneShotMessage`. Message/log semantics → `CreateMessage`.
6. `getAggregate` → `GetAggregate`; handle `success=false`+`404` as not-found; serve from subscription cache when available.
7. `subscribe` → `GetAggregate` seed → emit synthetic sync callback → open `ChannelEventSubscription`; switch on `event_name`; extract inner `data.data` / `data.aggregate.data`; multiplex many callbacks over one stream per channel; reconnect with 1→10 s capped exponential backoff, resetting on connect; never let a stream error be terminal.
8. Drive `ConnectionStatus` from `success` (available) and `cloud_synced` (online); reads/writes succeed even when `cloud_synced=false`.
9. Health-gate startup with `grpc.health.v1.Health/Check` (service `"doover.DeviceAgent"`) or `TestComms`; use a *real* capped backoff (not pydoover's `min(x*2,1)` bug).
10. Unary calls: one attempt, ~7 s deadline, surface errors — no auto-retry (retry only on streams).

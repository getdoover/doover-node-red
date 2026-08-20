# dda-agent local web API (port 49100) — contract reference

> **Current local transport:** the updated DDA mounts its full protobuf service
> as gRPC-Web at `https://<device>:49100/grpc`. The palette now uses that mount
> through `GrpcWebTransport`; the REST/WSS surface documented below remains
> useful for widgets and compatibility, but is no longer the palette backend.

Authoritative source: **`spaneng/doover-device-agent`** (private, Rust). Read via
the GitHub API, not cloned into this repo. Cross-checked against
`spaneng/pydoover` (env-var contract) and the local `doover-js` source clone
(capability list).

This documents the **second** local interface the dda-agent exposes. The agent
serves two sockets:

| Interface | Port | Protocol | Status for this project |
|-----------|------|----------|-------------------------|
| gRPC device-agent service | `50051` (`DEFAULT_PORT`) | gRPC/HTTP2, plaintext | Legacy path, parked — see `grpc-contract.md` |
| Local web server | `49100` (`DEFAULT_WEB_PORT`) | **HTTPS + WSS** (self-signed TLS) | This document |

> **Headline finding — read before relying on doover-js.** The dda-agent's web
> API is the legacy "channel-viewer" surface (a faithful Rust port of
> `http_wss_server.py`). Its REST paths (`/ch/v1/agent/...`) and its WSS wire
> protocol (`UI_SUBSCRIBE_CHANNEL` / `CHANNEL_SUBSCRIPTION_UPDATE`) do **not**
> match what `doover-js` `LocalAgentClient` sends. `LocalAgentClient` speaks the
> *cloud* Doover-Data REST + gateway contract (`/agents/...`, opcode frames).
> As shipped, **`LocalAgentClient` is not wire-compatible with the current
> dda-agent web server.** See [§7 Capability gaps](#7-capability-gaps-vs-doover-js-localagentclient).
> The on-device smoke test must settle whether we adapt our transport to the
> `/ch/v1` protocol, or wait on a DDA-side cloud-compatible API.

Source citations use `<repo>:<path>:<line>` where `<repo>` is
`doover-device-agent` unless noted.

---

## 1. Where the port and server come from

- `DEFAULT_WEB_PORT = 49100` — `dda-agent/src/config/resolve.rs:28`.
- Resolved into `Config.web_port` with precedence **CLI `--web-port` > env
  `WEB_PORT` > config-file `web_port` > 49100** — `resolve.rs:194`.
- The server only runs when `run_web_server` is true. That field defaults
  **true** (`resolve.rs:214`, `resolve.rs:86` CLI help "Defaults to True").
  Precedence: CLI `--run-web-server` (store_true, can only force on) > env
  `RUN_WEB_SERVER` (true iff exactly `"1"`) > config `run_web_server`
  (Python-truthiness) > `true`. Confirmed default-true by unit test
  `resolve.rs:426`.
- Wired in `dda-agent/src/main.rs:262-274`: `if cfg.run_web_server { web::spawn(cfg.web_port, cfg.tls_certfile, cfg.tls_keyfile, WebDeps{...}) }`.
- The server module is `dda-agent/src/web/mod.rs` (single file, ~533 lines).
- Black-box coverage: `tests_bb/test_local_http_wss.py` (LW-01 … LW-10) — the
  request/response shapes below are taken from these tests plus the handler
  source.

---

## 2. Bind address, TLS, CORS, auth

All from `dda-agent/src/web/mod.rs:74-151` and the module doc-comment
(`mod.rs:1-18`).

- **Bind address: `0.0.0.0:<web_port>`** — `mod.rs:118`
  (`SocketAddr::from(([0,0,0,0], port))`). Listens on **all interfaces**, not
  loopback-only. The comment pins this: *"0.0.0.0 like Python's uvicorn
  ('firewall should handle it')"*. Implications:
  - Reachable in-container via `https://localhost:49100` / `127.0.0.1:49100`.
  - Reachable from **other containers on the device** and from the **LAN**
    (subject to host firewall). Combined with no auth (below), anything on the
    device's network can read/publish channels. Note for our app: do not expose
    this beyond the device.
- **TLS is mandatory.** Server is `axum_server::bind_rustls` with a self-signed
  cert/key (`mod.rs:80-90, 120`). Default cert files: `static/localhost.crt` /
  `static/localhost.key` relative to CWD for source runs, `/app/static/...` in
  the Docker image (`mod.rs:54-64`). Overridable via `--tls-certfile` /
  `--tls-keyfile` / env `TLS_CERTFILE` / `TLS_KEYFILE` (`resolve.rs:215-216`).
  → Clients **must** use `https://` and `wss://`, and must **disable/relax cert
  verification** or trust the packaged self-signed cert. The black-box tests use
  `ssl=False` (`test_local_http_wss.py:74, 318`).
- **Auth: NONE (confirmed).** Module doc-comment: *"CORS `*`, no auth — ruling
  #10 keeps that ('firewall should handle it')"* (`mod.rs:18`). No auth
  middleware anywhere in the router (`mod.rs:92-115`). No token/header is
  checked on any route. This matches `LocalAgentClient`'s own note that its
  `auth` field is *"Reserved for a future LAN auth blob — ignored in v1"*
  (`doover-js` `src/client/local-agent-client.ts:43-44`).
- **CORS: fully open.** `access-control-allow-origin: *`,
  `access-control-allow-credentials: true`, methods `*`, headers `*`; `OPTIONS`
  short-circuits 200 (`mod.rs:126-151`).

---

## 3. HTTP endpoints (channels / aggregates / messages)

Router table: `dda-agent/src/web/mod.rs:92-113`. `{agent_id}` is a path
parameter but is **ignored** by every handler (single-agent device; the agent
serves its own channels regardless of the id passed) — `mod.rs:204, 230, 372`
all bind it as `_agent_id`.

### 3.1 `GET /healthcheck`
- Response `200`: `{"status": "ok"}` (`mod.rs:153-155`). Test LW-01.
- Used by clients to poll readiness — the web server binds asynchronously after
  the broker, so gRPC-ready does not imply web-ready (`test_local_http_wss.py:50-63`).

### 3.2 `GET /ch/v1/agent/{agent_id}` — list active channels
- Handler `get_all_channels` (`mod.rs:203-222`).
- Returns **only channels that are ACTIVE-tracked**, i.e. those with a live
  subscription. Publishing to a channel does **not** activate it; subscribing
  does. `deployment_config` is always active from startup (test LW-02,
  `test_local_http_wss.py:120-146`).
- Response `200`:
  ```json
  {
    "name": "local-dda",
    "channels": [
      { "channel": "<name>", "name": "<name>", "type": "channel", "agent": "local-dda" }
    ]
  }
  ```
- `500`: `{"detail": "Internal Server Error"}` if the broker snapshot fails.

### 3.3 `GET /ch/v1/agent/{agent_id}/{channel_name}/aggregate` — read aggregate
- Handler `get_channel_aggregate` (`mod.rs:228-255`), resolver
  `resolve_channel_aggregate` (`mod.rs:257-277`).
- Resolution order: if the channel is active-tracked **or** the cloud WSS is
  down → serve the cached aggregate from local state. Otherwise fetch from the
  cloud REST client — **which auto-creates unknown channels** (a `NotFoundError`
  triggers a `PUT {}` upstream). Pinned as "LW-03" behaviour (`mod.rs:224-227`,
  test LW-03 `test_local_http_wss.py:149-177`).
- Response `200`:
  ```json
  {
    "channel": "<name>",
    "aggregate": {
      "payload": { /* the aggregate data (arbitrary JSON object) */ },
      "attachments": [ /* array of attachment metadata objects */ ],
      "last_updated": <number|null>
    }
  }
  ```
  `payload` is the channel-viewer compatibility field carrying the aggregate
  `data`. An unknown channel served via the cloud returns `200` with
  `"payload": {}` (auto-created), **not** 404.
- `404`: `{"detail": "Channel not found"}` — only reachable when the WSS is down
  **and** nothing is cached (`mod.rs:249-253`).
- `500`: `{"detail": "Internal Server Error"}`.

### 3.4 `POST /ch/v1/agent/{agent_id}/{channel_name}` — publish / patch aggregate
- Handler `publish_to_channel` (`mod.rs:370-423`). Tests LW-03/04/05/06.
- Request body (`ChannelWriteRequest`):
  ```json
  {
    "msg":         { /* object */ }  |  "<string>",
    "max_age":     <int, optional>,
    "save_log":    <bool, optional>,
    "replace_keys": ["<key>", ...]   /* optional */
  }
  ```
  - `msg` **required**; object → used as-is; string → `JSON.parse`d, and on
    parse failure wrapped as `{"value": "<string>"}` (`mod.rs:376-389`, test
    LW-05). Any other type → `422 {"detail": "msg must be a dict or string"}`.
  - `max_age`: **falsy (absent, null, or `0`) falls through to the per-channel
    config default** `runtime.values().get_max_age(channel)` (`mod.rs:392-395`;
    Python parity note "None AND 0 both fall through"). Otherwise the given
    integer (seconds).
  - `save_log`: Python-truthy (`mod.rs:396-399`). When true the cloud write
    carries `log_update: true`; multiple posts inside one `max_age` window
    coalesce into a single cloud write, and `save_log` is OR'd across the batch
    (test LW-06 `test_local_http_wss.py:293-311`).
  - `replace_keys`: optional array of top-level keys to replace rather than
    merge (`mod.rs:400-404`).
  - The `app_key` header is **accepted but unused** (Python parity, default
    `"http_server"`) — `mod.rs:368-369`.
- **Semantics: this is a merge/patch into the aggregate, not a replace.** The
  handler calls `update_aggregate` with `replace_data: false`,
  `clear_attachments: false` (`mod.rs:406-418`). It is the write-half of
  `GetAggregate`, closest to an aggregate **PATCH**. There is **no** replace
  (PUT) route and **no** message-post route.
- Response `200`: `{"status": "success"}` (`mod.rs:422`).
- `422`: `{"detail": "msg must be a dict or string"}`; `500` on broker error.

### 3.5 `GET /_ws_renew` — WSS renewal (test seam, do NOT call in prod)
- Handler `wss_renew` (`mod.rs:157-160`). Response `200 {"status": "ok"}`.
- Triggers a cloud-WSS renewal. **Known bug RC-08: calling it currently causes a
  reconnect storm** — the black-box suite calls it only as the last action of a
  dedicated agent (`test_local_http_wss.py:5-8, 373-381`). Our transport must
  never poll this.

### 3.6 Widget routes (not part of the data transport — noted for completeness)
`mod.rs:95-103`. Serve an embedded channel-viewer web UI and an authenticated
attachment proxy. Not used by nodered-core, but they share the port:
- `GET /widget`, `/widget/`, `/widget/{channel_name}` → HTML.
- `GET /widget/widget.js`, `/widget/widget.css` → static bundle.
- `GET /widget/api/channels/{channel_name}/attachments/{attachment_index}` →
  raw attachment bytes, downloaded server-side with the DDA's own credentials so
  the browser never sees device creds (`mod.rs:282-366`, tests LW-03b/c/d).

---

## 4. WSS gateway protocol (`GET /ws`)

Upgrade handler `ws_upgrade` → `wss_endpoint` (`mod.rs:435-494`), stream task
`recv_update` (`mod.rs:499-533`). URL: `wss://<host>:49100/ws`. Tests LW-07/08/09.

### 4.1 Subscribe frame (client → server)
```json
{ "UI_SUBSCRIBE_CHANNEL": [ { "CHANNEL_NAME": "<name>" } ] }
```
- Only the **first** element of the array is read (`mod.rs:468-473`).
- **One active subscription per socket.** Each subscribe **replaces** (aborts)
  the prior stream task (`mod.rs:479-486`, test LW-08). To watch N channels you
  need N sockets.
- Frames that are valid JSON but don't match this shape (wrong key, empty array)
  are logged and **ignored**; the connection stays open (`mod.rs:474-477`, test
  LW-09).
- **Invalid JSON closes the connection** (Python parity: json.loads raises →
  close 1011) — `mod.rs:462-466`.

### 4.2 Update frame (server → client)
Emitted by `recv_update` for every diff the broker's data-listener produces
(`mod.rs:509-527`):
```json
{
  "TYPE": "CHANNEL_SUBSCRIPTION_UPDATE",
  "update": {
    "channel":       "<name>",
    "channel_name":  "<name>",
    "channel_owner": "local-dda",
    "type":          "base",
    "agent":         "unkown",
    "agent_name":    "unkown",
    "payload":       { /* the DIFF delivered to listeners, NOT the full aggregate */ },
    "message":       "<uuid4 string>",
    "timestamp":     <float epoch seconds>
  }
}
```
- **`payload` is the diff, not the full aggregate** (test LW-07 asserts
  `update.payload == the_published_payload`, `test_local_http_wss.py:330`). A
  consumer that needs full state must seed from `GET .../aggregate` then apply
  diffs.
- `"agent": "unkown"` / `"agent_name": "unkown"` — the **typo is intentional and
  pinned** (LW-07, `mod.rs:518-519`, `test_local_http_wss.py:328-329`). Do not
  match on it expecting `"unknown"`.
- `message` is a fresh uuid4 per frame; `timestamp` is float epoch seconds.

### 4.3 Ping / keepalive
- **No application-level ping/keepalive frames.** WebSocket protocol ping/pong is
  handled automatically by the axum/tungstenite library
  (`mod.rs:460` "ping/pong are answered by the library"). There is no
  heartbeat JSON frame to send or expect.

### 4.4 What the WSS does NOT do
- **No publish over WS** — writes are HTTP `POST` only (§3.4).
- **No one-shot message frame** — there is no inbound op that emits a one-shot,
  and no `oneShot`/`OneShotMessage` frame type. (Contrast doover-js
  `sendOneShotMessage` op 15, §7.)
- **No unsubscribe/sync ops** — you unsubscribe by re-subscribing to another
  channel or closing the socket.

---

## 5. Reachability from an app container on the device

- The gRPC contract reaches the agent via `DDA_URI` default `localhost:50051`
  (`pydoover/pydoover/docker/application.py:1272`,
  `pydoover/docs/51-Device-Agent-Interface.md`). Since the app container reaches
  gRPC on `localhost`, the dda web server on the same host is reachable at
  **`https://localhost:49100`** by the same network arrangement.
  - **UNVERIFIED (smoke test):** whether the app container shares the DDA's
    network namespace (so `localhost:49100` resolves to the agent) or reaches it
    via a compose service name (e.g. `device_agent:50051` in the pydoover docs,
    `pydoover/docs/01-Getting-Started.md:136`). If the latter, the web URL is
    `https://device_agent:49100`. Because the web server binds `0.0.0.0` it will
    answer on whatever host resolves; only the hostname is in question.
  - TLS caveat applies: the app must use `https://` and accept the self-signed
    cert.

---

## 6. Env-var contract for the web port — NONE EXISTS (recommend one)

**Confirmed absent.** pydoover's app runner injects/reads only:

| Interface | Env var | Default | Source |
|-----------|---------|---------|--------|
| Device agent (gRPC) | `DDA_URI` | `localhost:50051` | `pydoover/pydoover/docker/application.py:1272` |
| Platform (gRPC) | `PLT_URI` | `localhost:50053` | `application.py:1273` |
| Modbus (gRPC) | `MODBUS_URI` | `localhost:50054` | `application.py:1274` |

A repo-wide search of `pydoover` for `WEB_PORT` / `49100` / a web-URI env var
returns **nothing** — there is **no** app-facing env var for the dda web port.
On the agent side the only knob is `WEB_PORT` / `--web-port`
(`resolve.rs:194`), which configures the *server*, not any *client* discovery.

**Recommendation for this project.** Our supervisor should define and inject a
standard variable, since the app base image will not. Unlike `DDA_URI` (a bare
`host:port` for gRPC), the web endpoint needs a scheme (`https`), so use a full
URL:

```
DDA_WEB_URI = https://localhost:49100
```

- Name chosen to sit alongside `DDA_URI` and read as "the DDA's web URI".
- Our `nodered-core` LocalTransport reads `DDA_WEB_URI` (fallback
  `https://localhost:49100`), and the supervisor sets it in the app container
  env. Document that it is a full `https://host:port` URL, not a host:port pair.
- If a future dda-agent or `doover_device_base` standardises a different name,
  switch to it — flagged as a follow-up. (**UNVERIFIED:** whether
  `spaneng/doover_device_base` injects anything web-related; not checked here —
  Open Question #1 in PLAN.md already tracks the base-image env contract.)

---

## 7. Capability gaps vs doover-js `LocalAgentClient`

Cross-checked against the local `doover-js` clone at
`/Users/tomwyatt/doover-apps/doover-js` — **note this clone is v0.6.5**
(`package.json` version `0.6.5`, git tag `0.6.5`); the project targets installed
**0.7.1**, which is not present in this repo's `node_modules`. The capability
list and API route templates below should be **re-verified against the 0.7.1
dist** during the smoke test, though they are very unlikely to have changed.

`LocalAgentClient` advertises these capabilities
(`src/client/local-agent-client.ts:47-60`):
```
agents.list, channels.list, channels.get,
aggregates.get, aggregates.put, aggregates.patch,
messages.list, messages.post, messages.put,
gateway.subscribe, gateway.realtime, gateway.oneShot
```
It implements them by pointing the **cloud** `RestClient` / `GatewayClient` at
`config.baseUrl` with no auth (`local-agent-client.ts:112-127`) and calling the
standard cloud sub-clients. Those sub-clients use **cloud Doover-Data routes**:

| doover-js call | HTTP path it issues | dda-agent route that exists |
|----------------|---------------------|-----------------------------|
| `agents.listAgents()` | `GET /agents/` (`apis/agents-api.ts:172`) | — **none** |
| `channels.listChannels()` | `GET /agents/{id}/channels` (`channels-api.ts:37`) | `GET /ch/v1/agent/{id}` (different path & body) |
| `channels.getChannel()` | `GET /agents/{id}/channels/{ch}` (`channels-api.ts:51`) | — none (only `.../aggregate`) |
| `aggregates.getAggregate()` | `GET /agents/{id}/channels/{ch}/aggregate` (`aggregates-api.ts:22`) | `GET /ch/v1/agent/{id}/{ch}/aggregate` (different path & body) |
| `aggregates.putAggregate()` | `PUT /agents/{id}/channels/{ch}/aggregate` (`aggregates-api.ts:59`) | — none (no PUT/replace) |
| `aggregates.patchAggregate()` | `PATCH /agents/{id}/channels/{ch}/aggregate` (`aggregates-api.ts:98`) | closest is `POST /ch/v1/agent/{id}/{ch}` (merge) but different verb & path |
| `messages.listMessages()` / `postMessage()` / `putMessage()` | `.../channels/{ch}/messages...` (`messages-api.ts:81,108,197`) | — **none** (no message endpoints at all) |

**Gateway (WSS) mismatch is total.** doover-js `GatewayClient` uses a
Discord-style opcode protocol (`src/gateway/gateway-client.ts`):
subscribe `{op:12, d:{channel, organisation_id, diff_only}}` (line 176),
unsubscribe `op:13` (191), syncChannel `op:14` (267),
one-shot `{op:15, d:{channel, data}}` (280); inbound typed events
`OneShotMessage` / `messageCreate` / `aggregateUpdate` / `channelSync`
(gateway-client.ts:351-413, `types.ts:93-95`). The dda-agent `/ws` speaks
`{"UI_SUBSCRIBE_CHANNEL":[{"CHANNEL_NAME":...}]}` → `CHANNEL_SUBSCRIPTION_UPDATE`
(§4). None of the doover-js opcodes have a handler; `gateway.oneShot` has **no
server-side path at all**.

**Protocol mismatch.** `LocalAgentClientConfig` documents
`baseUrl` as `"http://192.168.0.7:49100"` (`local-agent-client.ts:31`) — plain
**http**. The real server is **https** with a self-signed cert (§2). A plain-http
client will not connect; an https client must relax cert verification.

### Bottom line
The doover-js `LocalAgentClient` does not match the DDA's compatibility
REST/WSS routes. This is now resolved for the palette by using the DDA's full
gRPC-Web service at `/grpc`, rather than adapting the narrower `/ch/v1` API.

The overlap that **is** actually served by the DDA today is narrow:
- read a channel aggregate — `GET /ch/v1/agent/{id}/{ch}/aggregate`
- merge/patch a channel aggregate — `POST /ch/v1/agent/{id}/{ch}`
- list active channels — `GET /ch/v1/agent/{id}`
- subscribe to per-channel diffs — `WS /ws` with `UI_SUBSCRIBE_CHANNEL`
- healthcheck — `GET /healthcheck`

That set maps cleanly onto our `DooverTransport` interface
(`getAggregate`, `publish`, `subscribe`) **if** we implement a thin adapter that
speaks the `/ch/v1` + `UI_SUBSCRIBE_CHANNEL` protocol directly — but it does
**not** give us `messages`, one-shot, aggregate-replace, or agent enumeration.

### Resolution
`GrpcWebTransport` calls `TestComms`, `GetAggregate`, `UpdateAggregate`,
`ChannelEventSubscription`, `CreateMessage`, and `SendOneShotMessage` through
the `/grpc` mount. This preserves aggregate writes, server-streaming events,
one-shots and messages without depending on the compatibility REST routes.

---

## 8. Quick endpoint index

| Method | Path | Purpose | §  |
|--------|------|---------|----|
| GET | `/healthcheck` | readiness → `{"status":"ok"}` | 3.1 |
| GET | `/ch/v1/agent/{agent_id}` | list active channels | 3.2 |
| GET | `/ch/v1/agent/{agent_id}/{channel}/aggregate` | read aggregate | 3.3 |
| POST | `/ch/v1/agent/{agent_id}/{channel}` | publish/merge aggregate | 3.4 |
| GET | `/_ws_renew` | WSS renew (test seam; storms — avoid) | 3.5 |
| GET | `/widget`, `/widget/...` | embedded viewer UI + attachment proxy | 3.6 |
| WS | `/ws` | subscribe to channel diffs | 4 |

All on `https://` / `wss://`, bind `0.0.0.0:49100`, no auth, CORS `*`,
self-signed TLS.

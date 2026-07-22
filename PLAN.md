# Doover × Node-RED — Project Plan

Bring Node-RED into the Doover ecosystem as a first-class citizen: a Doover device
app that runs the Node-RED runtime on a Doovit, plus a family of Doover nodes
(palette package) that work both **on a Doover device** and **anywhere else**
(remote Node-RED talking to the Doover cloud). Optimised for end-customer ease of
use: zero-config on a Doovit, dropdown-driven configuration everywhere, and a
ten-minute path from "install app" to "flow visible in the Doover UI".

---

## 1. Product principles

1. **Zero-config on a Doovit.** Drop a Doover node onto the canvas inside the
   Doover-NodeRED app and it just works — the local device agent connection is
   auto-detected from the container environment. No credentials, no endpoints.
2. **Pick, don't type.** Node edit dialogs populate dropdowns live from the
   connection: existing tag names, app keys, channel names. Customers should
   never have to spell `cu_grainsafe_monitor` correctly by hand.
3. **The Doover UI is the dashboard.** Flows surface values and controls through
   Doover UI nodes, not node-red-dashboard. One UI per device.
4. **Same nodes everywhere.** The identical palette works on-device (gRPC to the
   local device agent) and off-device (REST + WebSocket to the Doover cloud).
   The only difference is which connection config node a flow references.
5. **Safe by default.** Editor access authenticates against Doover (no shared
   passwords on public tunnel endpoints); output nodes expose the
   schedule/auto-revert safety patterns the platform already has.

---

## 2. Architecture overview

```
                        ┌────────────────────────────────────────────┐
                        │  Node-RED runtime (container / anywhere)   │
                        │                                            │
  Palette nodes ───────►│  node-red-contrib-doover                   │
                        │        │                                   │
                        │        ▼                                   │
                        │  @doover/nodered-core (transport layer)    │
                        │   ├── LocalTransport (gRPC, on-device)     │
                        │   └── CloudTransport (REST + WSS, remote)  │
                        └────────┬──────────────────────┬────────────┘
                                 │                      │
                    device agent gRPC socket      api.doover.com
                    (dda-agent, same Doovit)      (+ gateway WSS)
```

### 2.1 The transport layer (`@doover/nodered-core`)

A plain JS/TS library, independent of Node-RED, exposing one interface with two
implementations:

```ts
interface DooverTransport {
  // channels
  publish(channel: string, payload: unknown, opts?: {recordLog?: boolean, maxAge?: number}): Promise<void>
  subscribe(channel: string, cb: (msg) => void): Unsubscribe
  getAggregate(channel: string): Promise<unknown>
  sendOneShot(channel: string, payload: unknown): Promise<void>
  // identity
  agentId(): string
  appKey(): string | null      // null on cloud transport unless configured
  status(): ConnectionStatus   // drives node status dots
}
```

- **LocalTransport** — gRPC to the device agent using `@grpc/proto-loader`
  loading the `.proto` files at runtime (no codegen build step). Protos are
  vendored from `pydoover/protos/` (`device_agent.proto`, `platform_iface.proto`,
  `modbus_iface.proto`). Uses `GetChannelSubscription` (server-streaming) for
  subscriptions, `WriteToChannel`/`CreateMessage` for publishes, `GetAggregate`,
  `SendOneShotMessage` for live values. Endpoint/app-key discovered from the same
  env vars `doover-app-run` injects for pydoover apps (verify names against
  `spaneng/doover_device_base` — see Open Questions).
- **CloudTransport** — wraps/reuses `doover-js` (`RestClient`, `GatewayClient`,
  token auth with auto-refresh). Configured with an API endpoint, credentials,
  and a target **agent id**. This is also how an on-Doovit flow talks to a
  *different* device: add a second connection config node pointing at the cloud.

**Tags ride on channels.** In pydoover, tags are a convenience layer over the
`tag_values` channel aggregate: namespaced by app key (plus a global namespace),
nested key paths, diff-based change detection, and `live=True` tags streamed as
one-shot messages. The tag layer in `@doover/nodered-core` re-implements exactly
that on top of `DooverTransport` — one implementation serves both local and
cloud transports for free. (One improvement over pydoover: our subscription layer
multiplexes many callbacks per tag, avoiding the known pydoover footgun where a
second `subscribe_to_tag` silently replaces the first.)

### 2.2 The connection config node

Node-RED convention (cf. `mqtt-broker`): a shared **config node** every Doover
node references.

- **`doover-connection`** with a type selector:
  - **This device (local)** — default; auto-detected. Shows agent id + app key
    read-only. Zero fields to fill in.
  - **Doover Cloud** — API base URL (default `https://api.doover.com`),
    credential (long-lived token pasted in, or username/password against the
    auth server — see Open Questions), and an **agent picker** (dropdown fetched
    from the API, not a raw id field).
- On-device, the app pre-seeds a "Local Device" connection config in the default
  flow file so new users never even open it.
- Every message node shows a connection selector defaulting to the local
  connection when one exists.

Editor dropdowns (tag names, channels, app keys, agents) are served by small
admin HTTP endpoints the nodes register on the Node-RED runtime
(`RED.httpAdmin.get('/doover/tags', ...)`), which proxy through the selected
transport. This is standard Node-RED practice and is the backbone of the
"pick, don't type" principle.

---

## 3. The palette — `node-red-contrib-doover`

One npm package, published under the getdoover org, keyword `node-red` so it
appears in the Palette Manager and the Node-RED Flow Library. Nodes below in
build order.

### 3.1 Tag nodes (headline feature)

| Node | Direction | Behaviour |
|------|-----------|-----------|
| `doover tag in` | source | Emits a message when a tag changes. Scope selector: **this app** / **another app** (app-key dropdown) / **global**. Supports nested key paths (`battery.voltage` dot-notation → KeyPath). Options: emit current value on deploy/connect; only-on-change (default) vs every write. Output: `msg.payload` = value, `msg.topic` = `<app_key>/<tag>`, `msg.doover` = {agentId, appKey, tag, prev}. |
| `doover tag get` | mid-flow | Input triggers a read; sets `msg.payload` (configurable target property so it can enrich rather than clobber). Tag name can come from config **or** `msg.topic` for dynamic lookups. Option: default value if unset. |
| `doover tag out` | sink | Writes `msg.payload` to a tag. Scope selector as above. Options: **log** this write (record in history), **live** (stream as one-shot for high-rate values — with a rate-limit guard), batch mode (payload is an object → `set_tags` atomic multi-write). |

Tag typing: follow the platform's boolean/number/string types; the node coerces
predictably (configurable strict mode that errors instead of coercing).

### 3.2 Channel nodes

| Node | Behaviour |
|------|-----------|
| `doover channel in` | Subscribe to a named channel; emits each message. Option: emit aggregate on connect. Channel-name field with typeahead from existing channels. |
| `doover channel out` | Publish `msg.payload`. Options: `record_log`, `max_age`, one-shot mode. |
| `doover aggregate get` | Mid-flow: fetch a channel's aggregate into `msg.payload`. |

These are the foundation — the tag layer, UI nodes, and notify node are all
built on them internally.

### 3.3 Notification & activity nodes

| Node | Behaviour |
|------|-----------|
| `doover notify` | Publishes to `significantEvent` → user notification/alert banner. `msg.payload` = message text; option to also record an activity-log entry. Trivial to build, high demo value. |
| `doover activity` | Records an activity-log entry without notifying. |

### 3.4 Doover UI nodes

The device app declares a Container ("Node-RED" submodule) in the device's UI;
UI nodes populate elements inside it by name. Writes go through the `ui_state`
channel, user interactions come back via `ui_cmds` — same contract pydoover's
UIManager uses.

| Node | Behaviour |
|------|-----------|
| `doover ui variable` | Sink: displays `msg.payload` as a numeric/text/bool variable. Config: display name, type, precision, colour ranges (the same ranges schema the platform UI supports). |
| `doover ui input` | Source: emits when a user changes a slider / text input / select / float input in the Doover UI. Config mirrors the pydoover interaction types. |
| `doover ui button` | Source: emits when a user presses an action button. **The killer feature** — wire a Doover UI button to arbitrary flow logic. |

Design note: element declaration (what exists in the UI) is derived from the
deployed flow — on deploy, the plugin walks the flow's UI nodes and publishes the
merged element schema, so the Doover UI always matches the flow with no separate
declaration step. Removing a UI node removes the element.

UI nodes are **local-connection only** in v1 (they assume the app's UI
container). Remote-UI support is a later decision.

### 3.5 Platform I/O nodes (Doovit hardware — local transport only)

| Node | Behaviour |
|------|-----------|
| `doovit digital in` | Streams DI changes (and pulse-counter mode via `startPulseCounter`). |
| `doovit analog in` | Polls/streams AI values. |
| `doovit digital out` | Sets DO. **Exposes `scheduleDO`** as a first-class "auto-revert after N seconds" option, on by default for new nodes — Node-RED users won't think about what a crashed flow does to a relay; the platform already solved this. |
| `doovit analog out` | Sets AO, same schedule/auto-revert option. |
| `doovit system` | Mid-flow/source: input voltage, temperature, system power, location. |

### 3.6 What we deliberately don't build

- **MQTT, HTTP, serial, email, generic Modbus, Postgres, …** — the existing
  Node-RED ecosystem covers these; that ecosystem *is* the reason to embed
  Node-RED at all.
- **node-red-dashboard integration** — actively discouraged in docs; the Doover
  UI nodes are the answer.
- **Doover Modbus nodes** — deferred. Only needed if a flow must share an
  arbitrated bus with other Doover apps via `modbus_iface`; otherwise customers
  use `node-red-contrib-modbus` directly. Revisit on first real demand.

---

## 4. The device app (Doover-NodeRED App)

A standard Doover app repo (structure per `app-template`), image based on the
official `nodered/node-red` image merged with the Doover device base
conventions (labels `com.doover.app`/`com.doover.managed`, healthcheck —
Node-RED's `/` or admin API serves as the healthcheck target).

### 4.1 Container contents

- Node-RED runtime, pinned LTS version.
- **Pre-installed**: `node-red-contrib-doover`, the Doover editor theme, the
  adminAuth plugin, the storage module. On-device customers install nothing.
- A thin **supervisor** (small Node or Python process — Python/pydoover keeps it
  consistent with every other app) that:
  - materialises `settings.js` from the app's deployment config,
  - declares the app's UI (status variables + the Node-RED UI container +
    "Open Editor" affordance),
  - manages the editor tunnel (create/activate on demand, publish the current
    endpoint to a tag so the UI can render the link),
  - reports runtime health (flows running / stopped / error, deploy count,
    memory) as tags.

### 4.2 App config schema (deployment config)

| Setting | Default | Purpose |
|---------|---------|---------|
| `editor_enabled` | true | Disable entirely for locked-down production devices. |
| `editor_access` | "doover-auth" | Or "local-only" (no tunnel). |
| `extra_palette_packages` | [] | npm package names to install at start (with a note that installs need connectivity + add boot time). |
| `flows_sync_enabled` | true | Channel-backed flow storage (see 5.3). |
| `flow_package` | none | Pinned flow package `name@version` (or "latest") — fleet mode; see 5.4. |
| `credential_secret` | generated | Encryption key for flow credentials; shared across a fleet to make packages portable. |
| `flow_env` | {} | Key/values exposed to flows as env vars — per-device values referenced from shared packages. |
| `memory_limit_mb` | TBD | Container memory cap. |
| `timezone` | device tz | Node-RED scheduling nodes care. |

### 4.3 Doover UI for the app

- Status variables: runtime state, last deploy time/author, flow error count.
- **"Open Editor" action**: activates the tunnel (activation is also the
  reliable liveness probe — `is_active` alone can't be trusted), waits for the
  endpoint, surfaces the link. A `RemoteComponent` widget can later smooth this
  into an embedded iframe experience; the link-out version ships first.
- **"Save flow package" action**: snapshots the running project as a named,
  versioned package for fleet distribution (see 5.4); shows the currently
  applied package/version and a drift indicator in fleet mode.
- The "Node-RED" UI container that flow UI nodes populate (3.4).

### 4.4 Editor access & auth

- Tunnel: Doover tunnel to `localhost:1880`, https protocol (same pattern as the
  existing Cockpit tunnel).
- **adminAuth plugin (`@doover/node-red-auth`)**: Node-RED's editor auth is
  pluggable (Passport). Strategy validates Doover credentials/tokens against the
  Doover auth server and maps Doover permissions → Node-RED scopes
  (read-only vs full-deploy). This closes the "public ngrok endpoint" hole and
  means one login system. Until it ships, the app falls back to a per-device
  generated admin password surfaced in the app config (never a fixed default).

---

## 5. Editor experience & flow lifecycle

### 5.1 Theme

`@doover/node-red-theme-doover` — Node-RED supports packaged themes; Doover
branding makes the embedded editor feel intentional. ~1 day, do it early, it
disproportionately affects perceived quality.

### 5.2 Examples & subflows

Shipped in the palette package's `examples/` dir (appears in the editor under
Import → Examples), covering:

- Sensor tag → UI variable + threshold alarm → notify
- Doover UI button → DO pulse (with auto-revert)
- Poll external HTTP API → publish channel → visible in Doover UI
- Cross-app: read another app's tag, act on it
- Remote: cloud connection reading another device's tags

This is what makes the first customer demo work in ten minutes — treat the
examples as a product surface, not an afterthought.

### 5.3 Flows-as-config: channel-backed storage

A Node-RED **storage module** (`settings.storageModule`) that persists flows to
a `nodered_flows` channel via the transport layer, with local file fallback for
offline boot:

- Deploy in the editor → flows JSON published to the channel (cloud holds the
  canonical copy, history = versioning for free).
- Device offline during an edit elsewhere → picks up latest aggregate on
  reconnect.
- Flows become part of the device's config surface → **cloning a device via
  app-installs/Solutions carries its Node-RED behaviour**, and fleet-wide flow
  rollout is a channel write.
- Credentials file (`flows_cred.json`) is encrypted by Node-RED; the encryption
  key comes from app config so a cloned/restored device can decrypt.

Watch item: flows JSON can reach hundreds of KB; the dda-agent's redb store has
no compression and never shrinks past its high-water mark, so don't `record_log`
every deploy on the device-side channel cache without thinking about payload
size (publish with sensible `max_age`, log deploys cloud-side).

### 5.4 Flow packages: save/load & fleet distribution

Once a customer has a working Node-RED project on one device, Doover should be
the distribution mechanism to the rest of the fleet. The unit of distribution is
a **flow package**:

```
{
  "name": "pump-station-logic",
  "version": "1.2.0",
  "flows": [...],                 // flows.json content
  "credentials": "<encrypted>",   // flows_cred, encrypted with credentialSecret
  "palette": {"node-red-contrib-modbus": "5.x"},   // extra palette deps + versions
  "meta": {"created_by": ..., "created_at": ..., "source_agent": ...}
}
```

**Save**: a "Save flow package" action in the app's Doover UI (and an editor
menu plugin) snapshots the running project — flows + credentials + the exact
installed palette package versions — and publishes it as a named, versioned
package to a `nodered_packages` channel (channel history = the version archive).

**Load / distribute — through app config.** The app's config schema gains a
`flow_package` field (name + version, or "latest"). The supervisor watches
deployment config; when the ref changes it fetches the package, installs any
missing palette deps at the pinned versions, loads the flows, and reports the
applied package/version back as a tag. Because it's just deployment config,
every existing Doover fleet mechanism works unchanged:

- set it on one device in the admin site,
- clone it with app-installs cloning,
- bake it into a **Solution** config profile — Doover-NodeRED app + config
  pinning `pump-station-logic@1.2.0` = an installable product for a device type,
- roll a fleet forward (or back) by editing one config value.

Config stays a *reference*, not the blob — packages can reach hundreds of KB and
deployment config isn't the place for that (and the redb high-water-mark caveat
applies device-side).

**Two modes, one app**: *dev mode* (no `flow_package` pinned — live channel sync
per deploy, editor on) and *fleet mode* (`flow_package` pinned — device runs
exactly that version; editor optionally disabled; local edits are possible but
flagged as drift in a status tag). This makes "develop on one device, promote to
the fleet" the natural workflow.

**Credentials across a fleet**: Node-RED encrypts `flows_cred.json` with
`credentialSecret`, which we source from app config so a package decrypts on
every device that shares the secret. Docs should push the cleaner pattern for
per-device values: reference environment variables in node config (Node-RED's
`${VAR}` support), with the supervisor mapping selected app-config fields into
the runtime's env — so one package serves devices with differing endpoints/keys.

### 5.5 Centralised editing (explicitly deferred)

A cloud-hosted editor bound to the channel (FlowFuse-style) remains Phase-4+ /
optional. A+5.3 already gives: edit via tunnel against the live device, canonical
copy + propagation via channel. Only build central editing if tunnel friction
proves real with customers.

---

## 6. Running off-Doovit (remote & third-party hosts)

Target personas:

1. **Customer with existing Node-RED** (on-prem server, Home Assistant box,
   industrial PC): installs `node-red-contrib-doover` from the Palette Manager,
   adds a Doover Cloud connection with a token, picks their agent from the
   dropdown — now their existing automation can read/write Doover tags and
   channels. This is an *adoption funnel*, not just a feature.
2. **Doovit flow reaching other devices**: second connection config node (cloud)
   alongside the local one; nodes choose per-instance.
3. **Non-Doovit gateway running the full app** — deferred; the palette-on-
   vanilla-Node-RED story covers most of it without us owning the host.

Cloud transport constraints to design in from day one:

- **Credential provisioning**: customers need an easy way to mint a scoped,
  long-lived API token for a Node-RED install (see Open Questions).
- **Rate limits**: cloud transport should batch/debounce tag writes and warn in
  the node status when throttled. A flow loop that hammers the cloud API is the
  first support ticket waiting to happen.
- **Offline behaviour**: node status dots (green/yellow/red) driven by
  `ConnectionStatus`; queued-write semantics documented honestly (v1: fail +
  status, not infinite queueing).
- Platform I/O and UI nodes are local-only; they error clearly ("requires a
  local Doover device connection") when wired to a cloud connection.

---

## 7. Repo & package layout

The repo (`doover-node-red`, cloned from app-template) keeps the device app at
the root — Doover app CI expects `Dockerfile` + `doover_config.json` there —
with the npm workspaces alongside:

```
doover-node-red/
├── Dockerfile                    # FROM nodered/node-red + doover conventions
├── doover_config.json            # app definition, config schema, ui schema
├── pyproject.toml                # supervisor (pydoover app)
├── src/doover_node_red/          # supervisor: settings templating, tunnel mgmt, UI, health
├── settings/                     # Node-RED settings.js template, theme wiring
├── packages/
│   ├── nodered-core/             # @doover/nodered-core — transport layer, tag layer
│   │   └── protos/               # vendored from pydoover/protos (sync script)
│   ├── node-red-contrib-doover/  # the palette (nodes + editor html + examples)
│   ├── node-red-auth-doover/     # adminAuth Passport strategy (Phase 2)
│   ├── node-red-theme-doover/    # editor theme (Phase 2)
│   └── node-red-storage-doover/  # channel-backed storage module (Phase 3)
├── examples/                     # importable example flows (also shipped in palette pkg)
├── docs/
└── .github/workflows/            # CI: test, build multi-arch image, npm publish
```

Env-var contract (verified in `pydoover/docker/application.py`): `APP_KEY`,
`DDA_URI` (default `localhost:50051`), `PLT_URI` (`localhost:50053`),
`MODBUS_URI` (`localhost:50054`). LocalTransport reads exactly these.

- Palette package name `node-red-contrib-doover` (unscoped) for Palette-Manager
  discoverability; supporting packages scoped `@doover/*`.
- Publish flow: npm (getdoover org) → Node-RED Flow Library auto-indexes via the
  `node-red` keyword. App image via the standard app CI to
  `ghcr.io/getdoover/doover-nodered`, `--platform linux/amd64,linux/arm64`.
- Protos vendored with a `sync-protos` script + CI check against pydoover, so
  the JS transport can't silently drift from the platform contract.

---

## 8. Phases

**Phase 0 — Foundations (repo scaffold + transport)**
Monorepo scaffold, CI skeleton, `@doover/nodered-core` with LocalTransport
(gRPC: publish, subscribe, aggregate, one-shot) + the tag layer over it, tested
against a real Doovit / the app-template simulator.

**Phase 1 — MVP (demoable on a Doovit)**
Connection config node (local only), `tag in/get/out`, `channel in/out`,
`aggregate get`, `notify`. Device app: Dockerfile, supervisor v1 (settings,
health tags, UI status), tunnel + "Open Editor" action, palette pre-installed,
generated admin password. Two example flows.
*Exit: install app on a Doovit from the app store, open editor, wire a tag to a
notification, see it in the Doover UI — no config typed anywhere.*

**Phase 2 — Ease-of-use & UI**
Editor dropdowns/typeahead (tags, app keys, channels) via admin endpoints.
Doover UI nodes (variable, input, button) with deploy-driven element schema.
Theme. adminAuth plugin replacing the generated password. Full example set.
*Exit: a non-programmer customer builds "button → relay pulse → notify" without
reading docs.*

**Phase 3 — Cloud & fleet**
CloudTransport (reuse doover-js), cloud connection config node with agent
picker, token provisioning story, rate-limit guards. Channel-backed storage
module (flows sync). **Flow packages**: save action, `flow_package` config
field, supervisor apply-loop, dev/fleet modes, Solutions integration. Publish
palette to npm / Flow Library for the standalone-Node-RED audience.
*Exit: develop a project on one device, save it as a package, and roll it to a
second device by setting one config value; an existing non-Doover Node-RED
install can drive a Doover device.*

**Phase 4 — Hardware & polish**
Platform I/O nodes with auto-revert defaults, `doovit system` node, RemoteComponent
embedded-editor widget, docs site, doover-facts entries, Modbus decision.

---

## 9. Open questions (for Tom / to verify early in Phase 0)

1. **Env var contract**: exact variable names `doover-app-run` /
   `doover_device_base` inject for the device-agent gRPC endpoint and app key —
   read from `spaneng/doover_device_base` so LocalTransport matches precisely.
2. **Auth server flow for CloudTransport**: what's the sanctioned way to mint a
   long-lived scoped token for a third-party integration (doover-js shows
   token+refresh against an auth server — is there a "create API token" UX
   customers can self-serve)?
3. **UI schema from a device app at runtime**: confirm the `ui_state` publish
   contract lets the app add/remove elements dynamically per deploy (pydoover's
   UIManager suggests yes; verify the customer-site renders schema changes
   without an app restart).
4. **Doovit memory budget**: Node-RED runtime is typically ~120–250 MB RSS.
   Confirm acceptable per-app footprint on a CM4 alongside typical app loads,
   and set the default `memory_limit_mb` accordingly.
5. **App naming**: "Node-RED" is a trademark of the OpenJS Foundation — check
   naming/branding rules for the app store listing ("Node-RED for Doover" style
   naming is generally the safe pattern).
6. **Tunnel protocol**: confirm https-type tunnels handle the editor's
   websocket (comms) upgrade cleanly through ngrok (Cockpit precedent suggests
   yes).
7. **Flow package home**: v1 stores packages in a per-agent `nodered_packages`
   channel — good enough for save/load/clone, but org-wide sharing ("install
   this package on any device in my org") may want a proper artifact store or
   an org-level channel. Decide when Solutions integration lands; also confirm
   the config UI can offer a dropdown of saved packages (`format:
   doover-resource-*`-style) rather than a free-text name field.

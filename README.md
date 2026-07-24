# Doover × Node-RED

<img src="https://doover.com/wp-content/uploads/Doover-Logo-Landscape-Navy-padded-small.png" alt="Doover" style="max-width: 300px;">

**Node-RED as a first-class citizen of the Doover IoT platform** — a Doover
device app that runs the Node-RED runtime on a Doovit, plus a family of Doover
nodes (a palette package) that read and write Doover tags, channels,
notifications and UI both **on a Doover device** and **anywhere else** (an
existing Node-RED install talking to the Doover cloud).

The design goal is end-customer ease of use: zero-config on a Doovit,
pick-don't-type configuration (live dropdowns for tags/channels/agents land in
Phase 2 — today the config fields are free-text), and a ten-minute path from
"install the app" to "flow visible in the Doover UI".

> 📋 The authoritative design is in **[`PLAN.md`](PLAN.md)** — product principles,
> the full node list, phases, and open questions. This README is the orientation
> map; `PLAN.md` is the source of truth.

---

## What's in this repo

This is a hybrid repo: a standard Doover Python device app **at the root** (so
Doover app CI finds `Dockerfile` + `doover_config.json` where it expects them),
with the JavaScript palette and transport packages living alongside it as npm
workspaces.

```
doover-node-red/
├── Dockerfile                    # FROM nodered/node-red + Doover conventions
├── doover_config.json            # app definition, config schema, ui schema
├── pyproject.toml                # supervisor (pydoover app)
├── src/                          # supervisor: settings templating, tunnel, UI, health
├── settings/                     # Node-RED settings.js template, theme wiring (TBD)
├── packages/
│   ├── nodered-core/             # @doover/nodered-core — transport + tag layer (no Node-RED dep)
│   │   └── protos/               # vendored from pydoover/protos (sync script)
│   ├── node-red-contrib-doover/  # the palette: nodes + editor HTML + examples
│   ├── node-red-auth-doover/     # adminAuth Passport strategy        (Phase 2)
│   ├── node-red-theme-doover/    # editor theme                        (Phase 2)
│   └── node-red-storage-doover/  # channel-backed flow storage module  (Phase 3)
├── examples/                     # importable example flows (mirrored into the palette pkg)
├── docs/                         # this doc set (see docs/development.md, docs/reference/)
└── .github/workflows/            # CI: lint, test, build multi-arch image, npm publish
```

---

## Architecture at a glance

```
                     ┌────────────────────────────────────────────┐
                     │  Node-RED runtime (container / anywhere)    │
  Palette nodes ────►│  node-red-contrib-doover                    │
                     │        │                                    │
                     │        ▼                                    │
                     │  @doover/nodered-core  (transport layer)    │
                     │   ├── DooverJsLocalTransport (REST+WS, on-device) │
                     │   └── DooverJsCloudTransport (REST+WSS, remote)   │
                     └────────┬──────────────────────┬─────────────┘
                              │                       │
                 dda-agent local web API          api.doover.com
                 127.0.0.1:49100 (same Doovit)    (+ gateway WSS)
```

- **`@doover/nodered-core`** is a plain, Node-RED-independent library exposing one
  `DooverTransport` interface. The shipped default on a Doovit is
  **`DooverJsLocalTransport`** — `doover-js`'s `LocalAgentClient` over the on-device
  dda-agent's local **REST + WebSocket web API** (port 49100, base URL from
  `$DDA_WEB_URI`, default `http://127.0.0.1:49100`). The remote path is
  **`DooverJsCloudTransport`** (REST + WebSocket to the Doover cloud, reusing
  `doover-js`). A legacy gRPC `LocalTransport` (port 50051, protos vendored from
  pydoover) is retained and tested but **parked** — it is not the default. A **tag
  layer** rides on top of either transport — tags are a convenience over the
  `tag_values` channel aggregate, exactly as in pydoover.
- **`node-red-contrib-doover`** is the palette. Every message node references a
  shared **`doover-connection`** config node (à la `mqtt-broker`); the *only*
  difference between on-device and remote is which connection a node points at.
  Same nodes everywhere.
- The **device app** (repo root) is a normal Doover/pydoover app that wraps the
  official `nodered/node-red` image, materialises `settings.js` from deployment
  config, manages the editor tunnel, declares the app's Doover UI, and reports
  runtime health as tags.

See `PLAN.md` §2 for the transport contract and §3 for the full node catalogue.

---

## Quickstart

### On a Doovit (the zero-config path)

1. Install the **Node-RED for Doover** app onto a device from the Doover app store.
   It runs the Node-RED runtime with the Doover palette pre-installed and a
   zero-config local connection to the on-device agent.
2. Open the Node-RED editor. The in-app **Open Editor** action is the intended
   one-click path, but the on-device editor tunnel is still being built — today
   the action posts a "coming in a later phase" notice (config field
   `editor_access` is flagged EXPERIMENTAL). See `PLAN.md` Phase 2 for the tunnel.
3. In the editor, drag a **doover tag in** node onto the canvas. The local
   connection is auto-detected (agent id + app key read from the container env) —
   no credentials, no endpoints. Wire it to a **doover notify** node and **Deploy**.
4. The result is visible in the Doover UI. Try importing one of the
   [`examples/`](examples) flows to go faster.

### Standalone (an existing Node-RED install)

1. In your own Node-RED, open **Manage palette → Install** and add
   `node-red-contrib-doover` (once published).
2. Add a **doover-connection** config node, set its type to **Doover Cloud**, set
   the **API base** (default `https://api.doover.com`), type the **agent id** of
   the target device into the Agent field, and paste a scoped **API token** (stored
   as a Node-RED credential). The Agent field is free-text today; a live agent
   picker is planned Phase-2 polish (`PLAN.md` §2.2).
3. Your existing flows can now read and write Doover tags and channels.

The palette currently ships the messaging nodes only — **doover tag in / get /
out**, **doover channel in / out**, **doover aggregate get**, and **doover
notify** — all of which work over either a local or a cloud connection. Platform
I/O and UI nodes are later phases (`PLAN.md` §3) and are not in the palette yet.

---

## Packages

| Package | Name | Purpose | Phase |
|---------|------|---------|-------|
| `packages/nodered-core` | `@doover/nodered-core` | Transport interface + Local/Cloud transports + tag layer. No Node-RED dependency. | 0 |
| `packages/node-red-contrib-doover` | `node-red-contrib-doover` | The palette — tag / channel / aggregate / notify nodes today; UI + hardware nodes later. Unscoped name for Palette-Manager discoverability. | 1+ |
| `packages/node-red-auth-doover` | `@doover/node-red-auth` | Node-RED adminAuth (Passport) strategy validating Doover credentials. | 2 |
| `packages/node-red-theme-doover` | `@doover/node-red-theme-doover` | Doover editor theme. | 2 |
| `packages/node-red-storage-doover` | `@doover/node-red-storage` | Channel-backed flow storage module (flows-as-config, fleet distribution). | 3 |
| *(repo root)* | `app-template` → *Node-RED for Doover* | The pydoover supervisor + Dockerfile + Doover app config. | 1+ |

The example flows are shipped **twice**: in
[`packages/node-red-contrib-doover/examples/`](packages/node-red-contrib-doover/examples)
(so they appear under Import → Examples in the editor) and mirrored at the repo
root in [`examples/`](examples).

---

## Development setup

Two toolchains, one repo.

**JavaScript (palette + core)** — Node.js 24, npm 11, npm **workspaces**. Plain
CommonJS, no TypeScript, no build step (JSDoc for types).

```bash
npm install            # installs all workspaces + dev deps
npm test               # runs each workspace's tests (node --test / test-helper)
```

**Python (device app supervisor)** — [uv](https://docs.astral.sh/uv/) + pydoover 1.0.

```bash
uv run pytest tests -v          # run the Python test suite
uv run export-config            # regenerate config_schema in doover_config.json
uv run export-ui                # regenerate ui_schema (required to publish)
doover app run                  # run the app + simulator locally via docker-compose
```

The full dev loop — running Node-RED locally with the palette linked, testing
nodes, and the simulator story — is in **[`docs/development.md`](docs/development.md)**.
Reference material for implementers is in
[`docs/reference/`](docs/reference) (Node-RED node conventions, the gRPC contract,
and the tags contract).

---

## Licence

The device app at the repo root carries the standard Doover app-template
**Apache License 2.0** ([`LICENSE`](LICENSE)). The JavaScript workspace packages
declare **MIT** in their `package.json` (per `PLAN.md` §7 and the node-authoring
conventions — the common choice for a publishable Node-RED palette). This split is
intentional; keep new package `license` fields consistent with the package they
live in.

> **Node-RED** is a trademark of the **OpenJS Foundation**. This project embeds and
> integrates with Node-RED but is not endorsed by or affiliated with the OpenJS
> Foundation. App-store and package naming follows the safe "*<X> for Node-RED*" /
> "*Node-RED for <X>*" pattern; see `PLAN.md` §9 (open question 5).

---

## Need help?

- 📧 support@doover.com
- 📖 [Doover Documentation](https://docs.doover.com)
- 📋 [`PLAN.md`](PLAN.md) — the project plan and open questions

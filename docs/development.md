# Development guide

The day-to-day dev loop for this repo. It covers the two toolchains (JavaScript
palette/core and the Python device-app supervisor), how to run a local Node-RED
with the Doover palette linked in, how to run the tests, and where the simulator
story stands.

For the *design* rationale see [`../PLAN.md`](../PLAN.md); for node-authoring
mechanics see [`reference/nodered-conventions.md`](reference/nodered-conventions.md);
for the transport wire contracts see [`reference/grpc-contract.md`](reference/grpc-contract.md)
and [`reference/tags-contract.md`](reference/tags-contract.md).

---

## Prerequisites

- **Node.js 24** and **npm 11** (the JS packages are workspaces of the repo root).
- **[uv](https://docs.astral.sh/uv/)** and Python ≥ 3.11 for the device-app supervisor.
- **Docker + Docker Compose** for the app simulator and image builds.
- The **Doover CLI** (`doover`) for `doover app run` / publish.

All Node packages are plain **CommonJS** — no TypeScript, no build step. Types are
documented with JSDoc. Never add a compile step to a palette package: Node-RED
loads node `.js`/`.html` files as-is.

---

## Repo layout for developers

```
packages/nodered-core/            @doover/nodered-core   (transport + tag layer, no Node-RED dep)
packages/node-red-contrib-doover/ the palette            (nodes/ + examples/)
src/                              pydoover supervisor    (settings, tunnel, UI, health)
simulators/                       docker-compose stack   (device agent + simulator + app)
examples/                        mirrored example flows
```

`node-red-contrib-doover` depends on `@doover/nodered-core` via the workspace, so a
single `npm install` at the root symlinks them together — edits to the core show up
in the palette immediately.

---

## JavaScript dev loop

### Install

```bash
npm install          # from the repo root — installs every workspace + dev deps
```

### Run tests

Each workspace defines its own `test` script; run them all from the root:

```bash
npm test                                   # all workspaces (--if-present)
npm test --workspace @doover/nodered-core  # just the core
npm test --workspace node-red-contrib-doover
```

- `@doover/nodered-core` uses the Node built-in test runner (`node --test`) and the
  in-memory `MockTransport` — no device or network needed.
- The palette nodes are tested with
  [`node-red-node-test-helper`](https://github.com/node-red/node-red-node-test-helper),
  which spins up a real Node-RED runtime in-process. Inject a fake transport through
  the `doover-connection` config node so tests never touch a real device (see
  `reference/nodered-conventions.md` §7). Each node ships a `*_spec.js`.

### Run a local Node-RED with the palette linked

To click around the editor with the Doover nodes loaded, install this palette into
a local Node-RED user directory. The reliable, workspace-friendly way is a **local
install by path** (npm copies/links the package and resolves the
`@doover/nodered-core` workspace dep):

```bash
# one-time: a scratch Node-RED userDir
mkdir -p ~/.node-red-doover-dev

# install Node-RED itself if you don't have it
npm install -g node-red         # or: npx node-red ...

# install the palette (and its workspace core dep) into the scratch userDir
cd ~/.node-red-doover-dev
npm install /Users/<you>/doover-apps/doover-node-red/packages/node-red-contrib-doover

# run Node-RED against that userDir
node-red --userDir ~/.node-red-doover-dev
```

Then open <http://localhost:1880>. The Doover nodes appear under the **Doover**
palette category; import a flow from [`../examples/`](../examples) to try one.

Notes and gotchas:

- **`npm link` alternative.** You can `npm link` the palette instead, but linking a
  workspace package whose dependency (`@doover/nodered-core`) is *also* a workspace
  needs both linked (`npm link` in `packages/nodered-core` first, then
  `npm link @doover/nodered-core` inside the palette). The path-install above avoids
  that dance.
- **Re-install after adding a node file.** Node-RED reads `package.json`'s
  `node-red.nodes` map at load; if you add a new node entry, re-run the install (or
  edit the copy in `node_modules`) and restart Node-RED.
- **Editor changes** (`.html`) require a browser refresh; **runtime changes**
  (`.js`) require a Node-RED restart (or a redeploy for flow logic).
- **Off-device testing** needs a Doover Cloud connection (token + agent) — that path
  arrives with `CloudTransport` in Phase 3. Until then, exercise nodes against the
  `MockTransport` via the test helper, or against a real Doovit (below).

### Linting

CI runs lint + test (`.github/workflows/`). Match the existing style; keep files
CommonJS and JSDoc-typed.

---

## Python device-app dev loop

The supervisor at the repo root is a normal pydoover 1.0 app.

```bash
uv run pytest tests -v          # run the Python test suite
uv run export-config            # regenerate config_schema in doover_config.json
uv run export-ui                # regenerate ui_schema (required before publish)
doover app run                  # run app + simulator locally via docker-compose
doover app publish --profile dv2
```

`export-config` / `export-ui` write generated blocks into `doover_config.json` — do
not hand-edit those blocks. Re-run both after any change to `src/…/app_config.py` or
`app_ui.py`.

The verified env-var contract the supervisor and `LocalTransport` rely on (from
`pydoover/docker/application.py`): `APP_KEY`, `DDA_URI` (default `localhost:50051`),
`PLT_URI` (`localhost:50053`), `MODBUS_URI` (`localhost:50054`).

---

## Testing on a real Doovit

The end-to-end path (`PLAN.md` Phase 1 exit criteria): build and publish the app
image, install it on a Doovit from the app store, open the editor via the tunnel,
wire a tag to a notification, and confirm it in the Doover UI. This is the only way
today to exercise `LocalTransport`'s gRPC against a live device agent end to end.

---

## Simulator story (TBD)

The goal is to run the **full Node-RED palette against a simulated device** so
contributors without a Doovit can develop the on-device path locally. This is not
finished; the current state and the intended shape:

- **Today:** the repo carries the app-template simulator stack under
  `simulators/` (`docker-compose.yml` = device agent + a sample simulator that
  publishes a `random_value` tag + the app). `doover app run` brings it up. Node
  unit tests use `@doover/nodered-core`'s in-memory `MockTransport`, independent of
  any container.
- **Intended:** point a locally-run Node-RED (palette linked, as above) at the
  simulator stack's **device-agent gRPC socket** (`DDA_URI`) so `LocalTransport`
  talks to the simulated agent instead of a real Doovit — giving a full
  editor-to-tags loop on a laptop. The open items are wiring the palette's
  `doover-connection` (local) to the compose network's agent endpoint and seeding a
  representative tag/channel set in the simulator.
- **Decision pending** (see `PLAN.md` Phase 0 / Open Questions): whether the
  simulator is the app-template compose stack extended, or a lighter standalone
  gRPC stub of `device_agent.proto` for pure palette development. Update this
  section once that lands.

Until the simulator loop is complete, prefer: `MockTransport` for unit tests, a
real Doovit for integration, and the local-palette install for editor/UX work.

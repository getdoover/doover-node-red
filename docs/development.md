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
simulators/                       docker-compose stack   (device agent + this app)
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
  `reference/nodered-conventions.md` §7). The palette tests live in
  `packages/node-red-contrib-doover/test/` as `*.test.js` files
  (`channels.test.js`, `tags.test.js`, `notify.test.js`, `connection.test.js`),
  run via `node --test`.

### Differential fuzzer, e2e harness, docker smoke

Three cross-cutting checks live under `tools/` and the palette `test/` dir:

```bash
npm run fuzz:differential            # tools/differential/run.js
bash tools/docker-smoke/run-smoke.sh # build + boot the app image, assert it serves
```

- **`fuzz:differential`** generates seeded cases, runs the ported JS
  (`packages/nodered-core/lib/{diff,tags}.js`) and the pydoover reference
  (`tools/differential/py-driver.py`, spawned via `uv`), and deep-compares them.
  **pydoover is the contract** — every mismatch is a JS-side bug. Narrow a failure
  with `node tools/differential/run.js --target generateDiff --count 200 --verbose`.
- **e2e harness** — a live Node-RED end-to-end harness is being built under
  `packages/node-red-contrib-doover/test/e2e/`. Today it carries helpers
  (`lib/wait.js`, `lib/fake-dda-server.js`, `lib/load-fake-dda.js`) and an
  introspection fixture; there is no runnable `npm run e2e` script yet.
- **docker smoke** — `tools/docker-smoke/run-smoke.sh` builds the app image and
  boots a container with **no** device agent reachable (the production
  "agent unreachable" state), then asserts the container stays up, Node-RED serves
  its admin API, all Doover node types register, the palette survives the `/data`
  volume mount, and shutdown is graceful.

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
- **Off-device testing** works today over the **Doover Cloud** connection:
  `DooverJsCloudTransport` ships (`packages/nodered-core/lib/dooverjs-transport.js`)
  and the `doover-connection` node exposes a **Doover Cloud** type — set the API
  base, the target agent id, and an API token to read/write a remote device. For
  hermetic tests without any device, use the in-memory `MockTransport` via the test
  helper; for the on-device path, use a real Doovit (below).

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

The supervisor passes `APP_KEY`, `AGENT_ID`, `DDA_GRPC_WEB_URI` and
`DDA_WEB_URI` through to the Node-RED child for local transport discovery. The
active default is `GrpcWebTransport`, which uses the DDA's HTTPS gRPC-Web mount
at `https://127.0.0.1:49100/grpc`. `DDA_GRPC_WEB_URI` can override it; a legacy
`DDA_WEB_URI` value is also accepted. `DDA_GRPC_WEB_TLS_VERIFY=true` enables
certificate verification when a trusted device certificate is available.

---

## Testing on a real Doovit

The end-to-end path (`PLAN.md` Phase 1 exit criteria): build and publish the app
image, install it on a Doovit from the app store, reach the editor, wire a tag to a
notification, and confirm it in the Doover UI. This is the way to exercise the
default `GrpcWebTransport` against a live on-device DDA gRPC-Web API end to end.
(The in-app **Open Editor** action is a placeholder pending the editor tunnel
— `PLAN.md` Phase 2 — so editor access on a real device is not yet one-click.)

---

## Simulator story (TBD)

The goal is to run the **full Node-RED palette against a simulated device** so
contributors without a Doovit can develop the on-device path locally. This is not
finished; the current state and the intended shape:

- **Today:** the repo carries the app-template simulator stack under
  `simulators/`. For remote `doover app run <device>`, Compose starts only
  `node_red_application` and uses the DDA already installed on the Doovit. A
  sample simulator that publishes a
  `random_value` tag exists in source at `simulators/sample/` (`main.py`), but it
  is **not** wired in as a compose service yet. Node unit tests use
  `@doover/nodered-core`'s in-memory `MockTransport`, independent of any container.
- **Intended:** add the `simulators/sample/` producer as a compose service so it
  seeds a representative tag set into the agent, and point a locally-run Node-RED
  (palette linked, as above) at the stack's device-agent **gRPC-Web API**
  (`DDA_GRPC_WEB_URI`) so the default `GrpcWebTransport` talks to the simulated
  agent instead of a real Doovit — giving a full editor-to-tags loop on a laptop.
  The open items are wiring the palette's `doover-connection` (local) to the compose
  network's agent endpoint and seeding a representative tag/channel set.
- **Decision pending** (see `PLAN.md` Phase 0 / Open Questions): whether the
  simulator is the app-template compose stack extended, or a lighter standalone
  stub of the dda-agent web API for pure palette development. Update this section
  once that lands.

Until the simulator loop is complete, prefer: `MockTransport` for unit tests, a
real Doovit for integration, and the local-palette install for editor/UX work.

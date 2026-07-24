# Development

**Node-RED for Doover** is a hybrid repo: a pydoover device-app supervisor **at
the repo root** (so Doover app CI finds `Dockerfile` + `doover_config.json` where
it expects them) with the JavaScript palette and transport packages alongside it
as npm workspaces.

This file is the quick orientation for contributors. The **full dev loop** — two
toolchains, running a local Node-RED with the palette linked, the differential
fuzzer, the e2e harness, the docker smoke test, and the simulator story — lives in
**[`docs/development.md`](docs/development.md)**. The authoritative design is
**[`PLAN.md`](PLAN.md)**; implementer reference material is under
[`docs/reference/`](docs/reference).

## Layout

```
README.md              <-- Orientation map
DEVELOPMENT.md         <-- This file
PLAN.md                <-- Authoritative design (source of truth)
pyproject.toml         <-- Python supervisor project (uv)
package.json           <-- npm workspaces root (JS packages)
Dockerfile             <-- FROM nodered/node-red + Doover conventions
doover_config.json     <-- Doover app definition + generated config_schema/ui_schema

src/doover_node_red/   <-- The pydoover supervisor package
  __init__.py          <-- Entry point: run_app(NodeRedApplication())
  application.py       <-- NodeRedApplication (setup, main_loop, UI handlers)
  runner.py            <-- Spawns/supervises the Node-RED child, builds its env,
                           renders settings.js, manages the credential secret
  app_config.py        <-- Config schema (config.Schema)
  app_tags.py          <-- Runtime state tags
  app_ui.py            <-- Doover UI definition

packages/
  nodered-core/            <-- @doover/nodered-core: transport + tag layer (no Node-RED dep)
  node-red-contrib-doover/ <-- the palette: nodes/ + editor HTML + test/ + examples/

settings/                  <-- Node-RED settings.js template (rendered by runner.py)
simulators/                <-- docker-compose stack (device agent + this app)
examples/                  <-- importable example flows (mirrored into the palette pkg)
tools/                     <-- differential fuzzer + docker smoke test
tests/                     <-- pytest suite for the supervisor
```

There is **no `app_state.py`** and no `SampleApplication` — the supervisor is a
single `NodeRedApplication`. The Python package is `src/doover_node_red/`, wired to
the `doover-app-run` / `export-config` / `export-ui` entry points in
`pyproject.toml`.

## Two toolchains

**JavaScript (palette + core)** — Node.js 24, npm 11, npm **workspaces**. Plain
CommonJS, JSDoc for types, **no TypeScript and no build step** (Node-RED loads
`.js`/`.html` as-is).

```bash
npm install                                # installs every workspace + dev deps
npm test                                   # runs each workspace's tests (node --test)
npm test --workspace @doover/nodered-core  # just the core
npm run fuzz:differential                  # diff/tags parity vs the pydoover reference
```

`npm run fuzz:differential` runs `tools/differential/run.js`: it generates seeded
cases, runs the ported JS (`packages/nodered-core/lib/{diff,tags}.js`) and the
pydoover reference (`tools/differential/py-driver.py`, spawned via `uv`), and
deep-compares them. **pydoover is the contract** — any mismatch is a JS-side bug.
A live Node-RED e2e harness is being built under
`packages/node-red-contrib-doover/test/e2e/` (helpers and a fake-DDA server today,
no runnable suite wired yet); the docker smoke test lives at
`tools/docker-smoke/run-smoke.sh`. See [`docs/development.md`](docs/development.md)
for both.

**Python (device-app supervisor)** — [uv](https://docs.astral.sh/uv/) + pydoover
1.0.

```bash
uv run pytest tests -v          # run the Python test suite
uv run export-config            # write config_schema into doover_config.json
uv run export-ui                # write ui_schema into doover_config.json (required to publish)
doover app run                  # run the supervisor + device agent via docker-compose
```

The `config_schema` and `ui_schema` blocks in `doover_config.json` are generated
from `app_config.py` / `app_ui.py`. **Do not hand-edit them.** Re-run both
`export-config` and `export-ui` after any change and commit the result — the app
fails to publish if `ui_schema` is missing.

### Prerequisites

- **Node.js 24** and **npm 11** (the JS packages are workspaces of the repo root).
- **[uv](https://docs.astral.sh/uv/)** and Python ≥ 3.11 for the supervisor.
- **Docker + Docker Compose** for `doover app run`, the image build, and the smoke test.
- The **Doover CLI** (`doover`) for `doover app run` / `doover app publish`.

## Publishing

```bash
doover app publish --profile dv2
```

Run `export-config` + `export-ui` and commit first — publishing consumes the
generated blocks in `doover_config.json`.

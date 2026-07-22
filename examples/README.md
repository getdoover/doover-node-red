# Example flows

Importable Node-RED flow exports demonstrating the Doover palette
(`node-red-contrib-doover`). These are a **mirror** of the copies shipped inside
the palette package at
[`../packages/node-red-contrib-doover/examples/`](../packages/node-red-contrib-doover/examples);
inside the editor they appear under **Import → Examples → node-red-contrib-doover**.

| File | Pattern (PLAN §5.2) |
|------|---------------------|
| `tag-to-notification.json` | `doover tag in` (battery_voltage) → `switch` threshold → `function` → `doover notify` |
| `cross-app-tag-read.json` | `doover tag in` (another app) → `function` → `doover tag out` (this app) |
| `channel-roundtrip.json` | `inject` → `doover channel out` → *(channel)* → `doover channel in` → `debug` |
| `http-to-doover.json` | `inject` → `http request` (public JSON API) → `function` → `doover tag out` |

To try one: open the Node-RED editor, choose **Import** from the menu, paste the
file contents (or use **Import → Examples** when the palette is installed), then
**Deploy**. Each flow ships a pre-seeded **Local Device** connection so it works
with zero configuration on a Doovit.

> ⚠️ **Property-name assumptions:** these flows were written while the palette
> node files were still placeholders, so node `type` strings and property names
> were derived from `PLAN.md` §3.1–3.3 and `docs/reference/nodered-conventions.md`.
> The authoritative list and per-node caveats live in the package copy's
> [`README.md`](../packages/node-red-contrib-doover/examples/README.md) — reconcile
> against the real node `defaults` once the nodes are implemented.

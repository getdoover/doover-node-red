# Example flows

Importable Node-RED flows that ship with the palette. In the editor they appear
under **Import → Examples → node-red-contrib-doover**. They are also mirrored at
the repo root in [`../../../examples/`](../../../examples) so they can be browsed
without installing the package.

| File | Pattern (PLAN §5.2) |
|------|---------------------|
| `tag-to-notification.json` | `doover tag in` (battery_voltage) → `switch` threshold → `function` → `doover notify` |
| `cross-app-tag-read.json` | `doover tag in` (another app) → `function` → `doover tag out` (this app) |
| `channel-roundtrip.json` | `inject` → `doover channel out` → *(channel)* → `doover channel in` → `debug` |
| `http-to-doover.json` | `inject` → `http request` (public JSON API) → `function` → `doover tag out` |

Each flow ships a pre-seeded **Local Device** `doover-connection` config node, so
on a Doovit it works with zero configuration. Off-device, edit that connection to
type **Doover Cloud**, paste a token, and pick your agent.

## ⚠️ Property-name assumptions (TODO — reconcile with the node builders)

At the time these examples were written the palette node runtime/editor files
(`nodes/tags.js`, `nodes/channels.js`, `nodes/notify.js`,
`nodes/doover-connection.js`) were still **placeholders**. The `type` strings and
property names below were therefore derived from `PLAN.md` §3.1–3.3 and
`docs/reference/nodered-conventions.md`. **When the nodes are implemented, verify
these against the actual `defaults` in each `.html` and update the JSON if they
drift.**

Node type strings (match `package.json` `node-red.nodes` keys — hyphenated):
`doover-connection`, `doover-tag-in`, `doover-tag-get`, `doover-tag-out`,
`doover-channel-in`, `doover-channel-out`, `doover-aggregate-get`,
`doover-notify`. (Note: `nodered-conventions.md` prose sometimes shows
space-separated names like `"doover tag in"`; the authoritative registration name
is TBD by the builders — these examples use the hyphenated package keys.)

Assumed properties per node:

- **doover-connection** (config node): `name`, `mode` (`"local"` | `"cloud"`),
  `apiBase`, `agentId`. Token is a credential (not stored in flow JSON).
- **doover-tag-in**: `connection`, `tag`, `scope` (`"thisApp"` | `"otherApp"` |
  `"global"`), `appKey`, `emitInitial`, `onlyOnChange`.
- **doover-tag-out**: `connection`, `tag`, `scope`, `appKey`, `log`, `live`.
- **doover-channel-in**: `connection`, `channel`, `emitAggregateOnConnect`.
- **doover-channel-out**: `connection`, `channel`, `recordLog`, `maxAge`,
  `oneShot`.
- **doover-notify**: `connection`, `recordActivity`. Message text arrives as
  `msg.payload`.

The `inject`, `switch`, `function`, `debug` and `http request` nodes are stock
Node-RED core nodes and are stable.

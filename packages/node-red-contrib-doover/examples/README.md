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

## Node properties

The examples use the implemented runtime/editor registrations in `nodes/`.

Node type strings (match `package.json` `node-red.nodes` keys — hyphenated):
`doover-connection`, `doover-tag-in`, `doover-tag-get`, `doover-tag-out`,
`doover-channel-in`, `doover-channel-out`, `doover-aggregate-get`,
`doover-message`, `doover-notify`.

Assumed properties per node:

- **doover-connection** (config node): `name`, `dooverType` (`"local"` | `"cloud"`),
  `apiBase`, `agentId`. Token is a credential (not stored in flow JSON).
- **doover-tag-in**: `connection`, `tag`, `scope` (`"thisApp"` | `"otherApp"` |
  `"global"`), `appKey`, `emitInitial`, `onlyOnChange`.
- **doover-tag-out**: `connection`, `tag`, `scope`, `appKey`, `log`, `live`.
- **doover-channel-in**: `connection`, `channel`, `emitAggregateOnConnect`.
- **doover-channel-out**: `connection`, `channel`, `recordLog`, `maxAge`,
  `oneShot`.
- **doover-message**: `connection`, `channel`. It appends `msg.payload` as a
  persisted message without changing the channel aggregate.
- **doover-notify**: `connection`, `message`, `messageType`, `title`,
  `titleType`, `topic`, `topicType`, `severity`, `severityType`, and
  `recordActivity`. The four notification fields default to `msg.payload`,
  `msg.title`, `msg.topic`, and `msg.severity`. Notifications are persisted
  messages and do not change the `notifications` aggregate.

The `inject`, `switch`, `function`, `debug` and `http request` nodes are stock
Node-RED core nodes and are stable.

# Node-RED node-authoring conventions

A reference for implementers who have never written a Node-RED node. It covers
how a node package is structured, how config nodes work, the node lifecycle and
runtime API, the editor-side UX (`defaults`, `typedInput`, admin-endpoint
dropdowns, validation), how to ship examples, and how to test with the official
test helper.

Target: **Node-RED 4.x** (Node.js 24). All runtime files are plain CommonJS
JavaScript — Node-RED does not run a build step over palette packages.

Primary sources: <https://nodered.org/docs/creating-nodes/>. This doc distils the
official docs plus the conventions that `node-red-contrib-*` packages follow in
practice; where the Doover project (`node-red-contrib-doover`) has a specific
convention, it is called out.

---

## 1. Mental model

A **node** is two files that share a type name:

- a **runtime file** (`.js`) — runs in the Node-RED server (Node.js). It receives
  messages, does work, emits messages, and reports status. It never touches the
  browser.
- an **editor file** (`.html`) — runs in the browser (the flow editor). It
  declares the node's appearance (category, colour, icon, label), its editable
  properties (`defaults`), the edit-dialog form, and the help text. It never
  touches Node.js APIs.

The two are bound by a shared **type string** (e.g. `"doover tag in"`). The `.js`
calls `RED.nodes.registerType("doover tag in", …)` and the `.html` calls
`RED.nodes.registerType('doover tag in', {…})` with the same name.

One **package** (one npm module, one `package.json`) can contain many nodes.

---

## 2. Anatomy of a node package

### 2.1 `package.json`

The `node-red` section maps each node's type-name to its runtime `.js` file. The
matching `.html` file is auto-discovered next to the `.js` (same basename). List
every node the package ships.

```json
{
  "name": "node-red-contrib-doover",
  "version": "0.1.0",
  "description": "Doover tags, channels, UI and hardware nodes for Node-RED",
  "keywords": [ "node-red", "doover", "iot" ],
  "license": "MIT",
  "node-red": {
    "version": ">=4.0.0",
    "nodes": {
      "doover-connection": "nodes/connection/connection.js",
      "doover-tag-in":      "nodes/tag/tag-in.js",
      "doover-tag-get":     "nodes/tag/tag-get.js",
      "doover-tag-out":     "nodes/tag/tag-out.js",
      "doover-channel-in":  "nodes/channel/channel-in.js",
      "doover-channel-out": "nodes/channel/channel-out.js",
      "doover-notify":      "nodes/notify/notify.js"
    }
  },
  "dependencies": {
    "@doover/nodered-core": "^0.1.0"
  }
}
```

Notes:

- **`keywords` must include `"node-red"`.** This is what the Node-RED Flow Library
  indexes and what the in-editor Palette Manager searches. The official docs say
  *do not add the `node-red` keyword until the package is stable and working* —
  because adding it triggers Flow Library indexing.
- **Package name:** unscoped `node-red-contrib-doover` for the discoverable
  palette (per PLAN §7); supporting packages are scoped `@doover/*`. Since Jan
  2022, newly published node packages should be scoped OR use the
  `node-red-contrib-`/`node-red-node-` prefix.
- **`node-red.version`** is an optional semver range gating which Node-RED runtime
  will load the package.
- The keys in `nodes` (e.g. `"doover-tag-in"`) are module-internal ids used for
  file discovery; the *type name* a user sees is the string passed to
  `registerType` inside the file. Keep them consistent to avoid confusion.

### 2.2 The runtime `.js` file

Every runtime file exports a single function that receives the `RED` API:

```javascript
// nodes/tag/tag-in.js
module.exports = function (RED) {
  function DooverTagInNode(config) {
    RED.nodes.createNode(this, config);   // MUST be first — wires up base Node
    const node = this;

    node.tag = config.tag;                 // copy config props onto the instance
    node.connection = RED.nodes.getNode(config.connection); // resolve config node

    // ... register listeners, subscribe, etc.
  }

  RED.nodes.registerType("doover tag in", DooverTagInNode);
};
```

`RED.nodes.createNode(this, config)` is mandatory and must run before anything
else — it initialises the base `Node` (event emitter, `id`, `name`, `send`,
`status`, `on`, logging, credentials, context). Skipping it breaks the node.

### 2.3 The editor `.html` file

Three `<script>` blocks, by convention in this order:

```html
<!-- nodes/tag/tag-in.html -->

<!-- 1. Registration: appearance + properties -->
<script type="text/javascript">
  RED.nodes.registerType('doover tag in', {
    category: 'Doover',
    color: '#8ecae6',
    defaults: {
      name:       { value: "" },
      connection: { value: "", type: "doover-connection", required: true },
      tag:        { value: "", required: true },
      scope:      { value: "thisApp" },
      appKey:     { value: "" },
      emitOnConnect: { value: true }
    },
    inputs: 0,             // a source node has no input
    outputs: 1,
    icon: "font-awesome/fa-tag",
    label: function () {
      return this.name || this.tag || "doover tag in";
    },
    paletteLabel: "tag in",
    oneditprepare: function () { /* see §5 */ },
    oneditsave:    function () { /* see §5 */ }
  });
</script>

<!-- 2. Edit dialog template (the form) -->
<script type="text/html" data-template-name="doover tag in">
  <div class="form-row">
    <label for="node-input-connection"><i class="fa fa-globe"></i> Connection</label>
    <input type="text" id="node-input-connection">
  </div>
  <div class="form-row">
    <label for="node-input-tag"><i class="fa fa-tag"></i> Tag</label>
    <input type="text" id="node-input-tag" placeholder="battery.voltage">
  </div>
  <div class="form-row">
    <label for="node-input-name"><i class="fa fa-tag"></i> Name</label>
    <input type="text" id="node-input-name" placeholder="Name">
  </div>
</script>

<!-- 3. Help text (Info sidebar) -->
<script type="text/html" data-help-name="doover tag in">
  <p>Emits a message when a Doover tag changes.</p>
  <h3>Outputs</h3>
  <dl class="message-properties">
    <dt>payload <span class="property-type">any</span></dt>
    <dd>the new tag value</dd>
    <dt>topic <span class="property-type">string</span></dt>
    <dd><code>&lt;app_key&gt;/&lt;tag&gt;</code></dd>
  </dl>
</script>
```

**The link between form and data is the input `id`.** For a `defaults` property
named `tag`, the form input must have `id="node-input-tag"`. Node-RED reads and
writes that input automatically. (Config nodes use `node-config-input-<name>` —
see §3.) Anything not following this id convention you must wire up yourself in
`oneditprepare`/`oneditsave`.

### 2.4 How multiple nodes live in one package

Each node is an independent `.js`/`.html` pair listed in `package.json`'s
`node-red.nodes` map. There is no shared registration file. Common code (the
transport/tag layer) lives in a separate importable module — here
`@doover/nodered-core` — that each runtime file `require`s. Group related pairs
into subdirectories (`nodes/tag/`, `nodes/channel/`) for sanity; the paths in
`package.json` just have to match.

---

## 3. Config nodes

A **config node** holds shared configuration that many nodes reference — the
canonical example is `mqtt-broker`, referenced by every `mqtt in`/`mqtt out`. In
Doover, `doover-connection` is the config node every message node references
(local device connection or cloud connection — PLAN §2.2).

Two things make a node a config node:

1. In the `.html` registration, `category: 'config'`.
2. In the edit-dialog template, inputs use the id prefix
   **`node-config-input-<property>`** (note `-config-`), not `node-input-`.

### 3.1 Defining a config node

```javascript
// nodes/connection/connection.js
module.exports = function (RED) {
  function DooverConnectionNode(config) {
    RED.nodes.createNode(this, config);
    this.mode    = config.mode;      // "local" | "cloud"
    this.apiBase = config.apiBase;
    this.agentId = config.agentId;

    // credentials are on this.credentials (see §3.3)
    const token = this.credentials.token;

    // Build the shared transport once, here, and expose it to referencing nodes.
    this.transport = createTransport(this.mode, {
      apiBase: this.apiBase, agentId: this.agentId, token
    });

    this.on('close', (done) => {           // clean up the shared resource
      this.transport.close().then(() => done(), done);
    });
  }

  RED.nodes.registerType("doover-connection", DooverConnectionNode, {
    credentials: {
      token: { type: "password" }
    }
  });
};
```

```html
<!-- nodes/connection/connection.html -->
<script type="text/javascript">
  RED.nodes.registerType('doover-connection', {
    category: 'config',
    defaults: {
      name:    { value: "" },
      mode:    { value: "local", required: true },
      apiBase: { value: "https://api.doover.com" },
      agentId: { value: "" }
    },
    credentials: {
      token: { type: "password" }
    },
    label: function () {
      return this.name || (this.mode === "local" ? "Local Device" : this.agentId);
    }
  });
</script>

<script type="text/html" data-template-name="doover-connection">
  <div class="form-row">
    <label for="node-config-input-name">Name</label>
    <input type="text" id="node-config-input-name">
  </div>
  <div class="form-row">
    <label for="node-config-input-apiBase">API base</label>
    <input type="text" id="node-config-input-apiBase">
  </div>
  <div class="form-row">
    <label for="node-config-input-token">Token</label>
    <input type="password" id="node-config-input-token">
  </div>
</script>
```

### 3.2 Referencing a config node from another node

In the referencing node's `defaults`, give the property a `type` equal to the
config node's type name:

```javascript
defaults: {
  connection: { value: "", type: "doover-connection", required: true }
}
```

With `type` set, Node-RED automatically turns the `node-input-connection` form
input into a dropdown of available config-node instances plus an **Add new…**
button — you write a plain `<input type="text" id="node-input-connection">` and
the editor upgrades it.

At runtime, resolve the referenced instance with `RED.nodes.getNode`:

```javascript
function DooverTagInNode(config) {
  RED.nodes.createNode(this, config);
  const node = this;
  node.conn = RED.nodes.getNode(config.connection);   // the config-node instance
  if (!node.conn) {
    node.status({ fill: "red", shape: "ring", text: "no connection" });
    return;
  }
  const transport = node.conn.transport;              // shared object from §3.1
  // ...subscribe via transport
}
```

`config.connection` is the config node's **id** (a string); `RED.nodes.getNode`
turns it into the live instance. Guard for `undefined` (the config node may be
disabled or deleted).

### 3.3 Credentials

Credentials are stored separately from the flow (in an encrypted
`flows_cred.json`), never in the flow JSON. Declare them in **both** the runtime
and editor `registerType`, keyed by name with a `type` of `"text"` or
`"password"`:

```javascript
// runtime .js — third argument to registerType
RED.nodes.registerType("doover-connection", DooverConnectionNode, {
  credentials: { token: { type: "password" } }
});
```

```javascript
// editor .html — a credentials block in the definition object
credentials: { token: { type: "password" } }
```

Rules:

- **Form input id is `node-input-token`** (or `node-config-input-token` for a
  config node) — same as a normal property; Node-RED routes it to the credential
  store instead of the flow.
- **Runtime access:** `this.credentials.token`.
- **Editor access is restricted for `password` credentials.** In `oneditprepare`
  you *cannot* read the secret back; instead Node-RED exposes a boolean
  `this.credentials.has_token` so the form can show "already set" state. `text`
  credentials are readable in the editor.
- Credentials are encrypted with `credentialSecret`. For Doover fleet
  portability, that secret is sourced from app config so a package decrypts on
  every device sharing it (PLAN §5.4).

---

## 4. Node lifecycle & runtime API

### 4.1 Registration and construction

- Package loads → `module.exports(RED)` runs once → `RED.nodes.registerType(name,
  Constructor)` registers the type.
- Each deploy → the runtime constructs one instance of `Constructor(config)` per
  node in the flow. `RED.nodes.createNode(this, config)` runs first. Do
  per-instance setup here (copy config, resolve the connection, subscribe).

### 4.2 Handling input (source vs sink vs mid-flow)

Register an input listener with the **Node-RED 1.0+ three-argument signature**
`(msg, send, done)`:

```javascript
function DooverTagOutNode(config) {
  RED.nodes.createNode(this, config);
  const node = this;
  const conn = RED.nodes.getNode(config.connection);

  node.on('input', async function (msg, send, done) {
    try {
      await conn.transport.publishTag(config.tag, msg.payload, {
        log:  config.log,
        live: config.live
      });
      // A sink still calls done(); a pass-through would send(msg) first.
      done();
    } catch (err) {
      // Pass the error to done() so Catch nodes can handle it (1.0+).
      done(err);
    }
  });
}
```

Why the new signature matters:

- **`send`** — use this instead of `node.send(msg)` inside the handler. It lets
  the runtime track message tracing/timeout per message. For a node with
  multiple outputs, pass an array: `send([outMsgA, outMsgB])`.
- **`done()`** — signals the runtime you have finished with this message. Call it
  exactly once. Call `done(err)` on failure — this routes the error to **Catch**
  nodes and marks the message complete. This is essential for correct behaviour
  under the **Complete** node and for async work (DB calls, network I/O).
- A **source node** (e.g. `tag in`) has `inputs: 0` and no `on('input')`; it
  calls `node.send(msg)` from a subscription/timer callback (there is no `done`
  in that context — use `node.send` directly).

Backwards-compat shim (only needed if you must support Node-RED 0.x — 4.x always
supplies `send`/`done`, so this is optional for a 4.x-only package):

```javascript
node.on('input', function (msg, send, done) {
  send = send || function () { node.send.apply(node, arguments); };
  // ...work...
  if (done) { done(); }
});
```

### 4.3 Emitting from a subscription (source nodes)

```javascript
function DooverTagInNode(config) {
  RED.nodes.createNode(this, config);
  const node = this;
  const conn = RED.nodes.getNode(config.connection);

  node.status({ fill: "yellow", shape: "ring", text: "connecting" });

  node.unsubscribe = conn.transport.subscribeTag(config.tag, (value, prev) => {
    node.status({ fill: "green", shape: "dot", text: "connected" });
    node.send({
      payload: value,
      topic: `${conn.appKey()}/${config.tag}`,
      doover: { agentId: conn.agentId(), tag: config.tag, prev }
    });
  });

  node.on('close', function (done) {
    if (node.unsubscribe) node.unsubscribe();
    done();
  });
}
```

### 4.4 Cleanup: `on('close')`

Called on redeploy, flow stop, or node removal. **Always** unsubscribe / clear
timers / close handles here — otherwise a redeploy leaks a subscription per
deploy.

```javascript
// Async cleanup: take the done callback and call it when finished.
node.on('close', function (done) {
  node.timer && clearInterval(node.timer);
  node.stream.end(() => done());     // must call done() within 15s
});
```

Two-argument form distinguishes *removed/disabled* from *restarting*:

```javascript
node.on('close', function (removed, done) {
  if (removed) {
    // node was deleted or disabled — release named/external resources
  } else {
    // node is just being restarted on redeploy
  }
  done();
});
```

The runtime enforces a **15-second timeout** on close; call `done()` or the
runtime force-continues and logs a warning.

### 4.5 Status conventions

`node.status({ fill, shape, text })` draws a coloured badge under the node.
`fill` ∈ `red|green|yellow|blue|grey`; `shape` ∈ `ring|dot`. Doover convention
(mirrors mqtt and PLAN §6 `ConnectionStatus`):

| State | Call |
|-------|------|
| Connected / healthy | `node.status({ fill: "green", shape: "dot", text: "connected" })` |
| Connecting / reconnecting | `node.status({ fill: "yellow", shape: "ring", text: "connecting" })` |
| Disconnected / error | `node.status({ fill: "red", shape: "ring", text: "disconnected" })` |
| Throttled (cloud rate limit) | `node.status({ fill: "yellow", shape: "dot", text: "throttled" })` |
| Momentary activity | `node.status({ fill: "blue", shape: "dot", text: "sent" })` then clear |

`node.status({})` clears it. Convention: **dot = steady state, ring =
transitional/not-ready.** Drive status from the shared connection so every node
on a connection reflects it; a common pattern is for the config node to emit
status changes its referencing nodes subscribe to.

### 4.6 Logging & errors

```javascript
node.log("info message");        // server log
node.warn("shown in debug tab"); // server log + editor Debug sidebar
node.error("problem");           // server log + editor Debug sidebar
node.error("problem", msg);      // pass msg → triggers Catch nodes
node.trace("verbose");           // trace level
node.debug("debug detail");      // debug level
```

Inside an `on('input')` handler prefer `done(err)` over `node.error(err, msg)` —
`done(err)` both reports and completes the message. Use `node.error(err, msg)`
only outside a handler (e.g. in a subscription callback) where there is no
`done`.

### 4.7 Context (optional persistence)

Per-node / per-flow / global key-value store:

```javascript
const ctx = node.context();
ctx.set("lastValue", value);          // node scope
const last = ctx.get("lastValue");
node.context().flow.set("shared", x); // flow scope
node.context().global.get("g");       // global scope
```

---

## 5. Editor UX

Everything here is browser-side, inside the `.html` file's definition object.

### 5.1 `defaults` and validation

Each `defaults` entry: `value` (default), optional `required` (bool), optional
`validate` (fn returning bool), optional `type` (config-node reference).

```javascript
defaults: {
  tag:      { value: "", required: true,
              validate: function (v) { return v.length > 0; } },
  maxAge:   { value: 3600, validate: RED.validators.number() },
  scope:    { value: "thisApp",
              validate: RED.validators.regex(/^(thisApp|otherApp|global)$/) }
}
```

Built-in validators: `RED.validators.number()`, `RED.validators.regex(re)`,
`RED.validators.typedInput("propType")`. A failing `validate` marks the node with
a red triangle and blocks deploy.

### 5.2 `oneditprepare` / `oneditsave`

- `oneditprepare()` — runs just before the dialog opens. Initialise widgets
  (`typedInput`), fetch dropdown data, toggle rows based on other fields.
- `oneditsave()` — runs when the user clicks Done. Read any values you manage
  manually (custom widgets not bound by id) back onto `this.<prop>`.
- Also: `oneditcancel`, `oneditdelete` (config-node delete), `oneditresize`.

### 5.3 `typedInput` widget

`typedInput` gives a value field plus a type selector (string / number / bool /
msg property / flow / global / JSON / custom). Store the chosen **type** in a
companion hidden `defaults` property.

```html
<div class="form-row">
  <label for="node-input-value">Value</label>
  <input type="text" id="node-input-value" style="width:70%">
  <input type="hidden" id="node-input-valueType">
</div>
```

```javascript
defaults: {
  value:     { value: "" },
  valueType: { value: "str" }
},
oneditprepare: function () {
  $("#node-input-value").typedInput({
    type: this.valueType,
    types: ["str", "num", "bool", "json", "msg", "flow", "global"],
    typeField: "#node-input-valueType"
  });
}
```

`typeField` points at the hidden input, so Node-RED persists both value and type
automatically — no `oneditsave` needed for this case. A `typedInput` can also be
a pure dropdown:

```javascript
$("#node-input-scope").typedInput({
  types: [{
    value: "scope",
    options: [
      { value: "thisApp",  label: "This app" },
      { value: "otherApp", label: "Another app" },
      { value: "global",   label: "Global" }
    ]
  }]
});
```

### 5.4 Dropdowns populated from an admin endpoint

This is the backbone of Doover's "pick, don't type" principle (PLAN §2.2): the
editor asks the running server for live data (tag names, app keys, channels,
agents) and offers them as a dropdown.

**Runtime side — register an admin HTTP endpoint** in the node's `.js` (register
it once; guard against re-registration if multiple node files would add the same
route):

```javascript
// in some node's module.exports(RED), or a shared admin.js required by them
RED.httpAdmin.get(
  "/doover/:connId/tags",
  RED.auth.needsPermission("doover.read"),   // enforce editor auth
  async function (req, res) {
    const conn = RED.nodes.getNode(req.params.connId);
    if (!conn) { res.status(404).json([]); return; }
    try {
      const tags = await conn.transport.listTagNames();   // ["battery.voltage", ...]
      res.json(tags);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  }
);
```

`RED.auth.needsPermission(...)` ensures only an authenticated editor session can
hit the endpoint. Namespace the route (`/doover/...`) to avoid collisions with
other palettes.

**Editor side — fetch and fill in `oneditprepare`** with jQuery `$.getJSON`
(jQuery is available in the editor):

```javascript
oneditprepare: function () {
  const connId = $("#node-input-connection").val();
  const current = this.tag;

  function loadTags(connId) {
    const $sel = $("#node-input-tag").empty();
    if (!connId) return;
    $.getJSON("doover/" + connId + "/tags", function (tags) {
      tags.forEach(function (t) {
        $("<option>").val(t).text(t).appendTo($sel);
      });
      $sel.val(current);
    });
  }

  loadTags(connId);
  // Re-fetch when the user switches connection:
  $("#node-input-connection").on("change", function () {
    loadTags($(this).val());
  });
}
```

The admin path is **relative** (no leading slash) so it respects Node-RED's
`httpAdminRoot` when the editor is served under a sub-path (which it is behind the
Doover tunnel). Provide a graceful fallback (allow free text, or fall back to a
plain input) when the server is unreachable or offline.

---

## 6. Packaging polish

### 6.1 Category, colour, icon

- **`category`** groups the node in the palette. Use a single branded category
  `"Doover"` (or subcategories like `"Doover"` for all) so nodes cluster.
- **`color`** is the node's fill. Pick one brand colour and use it across the
  palette for instant recognition; use a distinct shade to separate sub-families
  if desired. Value is any CSS colour (`'#8ecae6'`).
- **`icon`** is either a stock Node-RED icon name, a `font-awesome/fa-*` name, or
  a custom file. Custom icons: ship a `.svg`/`.png` (preferably a white-on-
  transparent SVG, ~20×30 viewport) in an `icons/` directory beside the node and
  reference it by filename (`icon: "doover.svg"`). Node-RED auto-serves an
  `icons/` dir found alongside a node file. Users can override per-instance.

```javascript
{
  category: 'Doover',
  color: '#8ecae6',
  icon: "doover.svg",              // from ./icons/doover.svg
  align: 'left',                   // 'left' for source, 'right' for sink
  paletteLabel: "tag in",          // shorter name shown in the palette
  label: function () { return this.name || this.tag || "doover tag in"; },
  labelStyle: function () { return this.name ? "node_label_italic" : ""; }
}
```

### 6.2 Shipping examples

Put importable flows in an `examples/` directory at the package root, as `.json`
files (each is exported flow JSON). Node-RED surfaces them in the editor under
**Import → Examples → <package name>**. No `package.json` wiring is needed; the
`examples/` directory is discovered automatically.

```
node-red-contrib-doover/
├── package.json
├── nodes/…
├── icons/doover.svg
└── examples/
    ├── tag-to-notify.json
    ├── button-to-relay-pulse.json
    └── http-poll-to-channel.json
```

Per PLAN §5.2, treat examples as a product surface — they are what makes the
ten-minute first-demo work.

### 6.3 Flow Library indexing

Publishing to npm with `"node-red"` in `keywords` makes the package appear in the
in-editor **Palette Manager** search and the online **Flow Library**
(flows.nodered.org). Add the keyword only once the package is stable.

---

## 7. Testing with `node-red-node-test-helper`

`node-red-node-test-helper` spins up a real Node-RED runtime in-process, loads a
flow made of your node(s) plus mock `helper` nodes, and lets you inject and
observe messages.

Install as a dev dependency (with `node-red` itself, which the helper needs):

```bash
npm install --save-dev node-red-node-test-helper node-red mocha should
```

Minimal test (Mocha + `should`), adapted to the lifecycle recommended for
4.x — `helper.init`, `startServer`/`stopServer`, `unload` per test:

```javascript
// test/tag-out_spec.js
const should  = require("should");
const helper  = require("node-red-node-test-helper");
const tagOut  = require("../nodes/tag/tag-out.js");

helper.init(require.resolve("node-red"));

describe("doover tag out node", function () {
  beforeEach(function (done) { helper.startServer(done); });
  afterEach(function (done)  { helper.unload(); helper.stopServer(done); });

  it("should be loaded", function (done) {
    const flow = [{ id: "n1", type: "doover tag out", name: "tag out" }];
    helper.load(tagOut, flow, function () {
      const n1 = helper.getNode("n1");
      try {
        n1.should.have.property("name", "tag out");
        done();
      } catch (err) { done(err); }
    });
  });

  it("should publish payload to the tag", function (done) {
    const flow = [
      { id: "n1", type: "doover tag out", name: "tag out",
        tag: "battery.voltage", wires: [["n2"]] },
      { id: "n2", type: "helper" }
    ];
    helper.load(tagOut, flow, function () {
      const n1 = helper.getNode("n1");
      const n2 = helper.getNode("n2");   // mock sink to observe pass-through
      n2.on("input", function (msg) {
        try {
          msg.should.have.property("payload", 12.4);
          done();
        } catch (err) { done(err); }
      });
      n1.receive({ payload: 12.4 });     // inject a message into n1
    });
  });
});
```

Key APIs:

- `helper.init(require.resolve("node-red"))` — point the helper at the installed
  runtime (call once, module top-level).
- `helper.load(nodeModule, flow, done)` — register the node module(s) (one or an
  array) and start a test flow. `flow` is an array of node configs; a node of
  `type: "helper"` is a built-in mock you wire your node's output to.
- `helper.getNode(id)` — get the live node instance by its flow id.
- `node.receive(msg)` — inject a message as if it arrived on the node's input.
- `n2.on("input", cb)` — observe messages your node emits (assert inside a
  `try/catch` and call `done`/`done(err)`).
- `helper.unload()` then `helper.stopServer(done)` in teardown to reset between
  tests.

For nodes that need a config node, include it in the `flow` array and reference
its id, and pass credentials via a second argument to `helper.load` when needed:
`helper.load([tagOut, connection], flow, credentials, cb)`. Mock
`@doover/nodered-core`'s transport (or inject a fake) so tests don't need a real
device — the node code should resolve its transport through the config node,
which makes it straightforward to substitute.

---

## 8. Quick checklist for a new Doover node

1. Add the `.js`→file entry to `package.json` `node-red.nodes`.
2. `.js`: `module.exports = function(RED){ … RED.nodes.registerType(name, Ctor[, {credentials}]) }`; `createNode` first; resolve the `doover-connection` via `RED.nodes.getNode`.
3. Handle input with `(msg, send, done)` and call `done()`/`done(err)`; sources use `node.send` from callbacks.
4. `on('close', done)` to unsubscribe/clear timers.
5. Drive `node.status()` from the connection (green dot / yellow ring / red ring).
6. `.html`: `registerType` with `category`, `color`, `icon`, `defaults` (with `validate`), `label`; matching `data-template-name` form (`node-input-<prop>` ids) and `data-help-name` help.
7. Live dropdowns via `RED.httpAdmin.get` + `RED.auth.needsPermission` and `$.getJSON` in `oneditprepare`.
8. Ship an example flow in `examples/`.
9. Write a `*_spec.js` test with `node-red-node-test-helper`.

---

## References

- Creating nodes overview — <https://nodered.org/docs/creating-nodes/>
- First node — <https://nodered.org/docs/creating-nodes/first-node>
- Node .js runtime — <https://nodered.org/docs/creating-nodes/node-js>
- Node properties — <https://nodered.org/docs/creating-nodes/properties>
- Edit dialog / typedInput — <https://nodered.org/docs/creating-nodes/edit-dialog>
- Config nodes — <https://nodered.org/docs/creating-nodes/config-nodes>
- Credentials — <https://nodered.org/docs/creating-nodes/credentials>
- Packaging — <https://nodered.org/docs/creating-nodes/packaging>
- Test helper — <https://github.com/node-red/node-red-node-test-helper>
</content>
</invoke>

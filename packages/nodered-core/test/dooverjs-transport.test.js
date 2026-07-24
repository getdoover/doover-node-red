"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DooverJsLocalTransport,
  DooverJsCloudTransport,
} = require("../lib/dooverjs-transport");
const { TagClient } = require("../lib/tags");

// ---------------------------------------------------------------------------
// Fakes: a scripted WebSocket that speaks the doover-js gateway op-code protocol
// and a fetch stub backed by an in-memory aggregate store. These are the
// injection points doover-js exposes (fetchImpl / webSocketImpl).
// ---------------------------------------------------------------------------

/**
 * A minimal WebSocket that auto-completes the doover-js handshake
 * (Hello → identify/resume → Ready) and lets a test push server frames.
 */
class FakeWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 1; // OPEN (isConnected checks === WebSocket.OPEN === 1)
    this.sent = [];
    FakeWebSocket.instances.push(this);
    FakeWebSocket.last = this;
    queueMicrotask(() => {
      if (this.readyState !== 1) {
        return;
      }
      if (this.onopen) {
        this.onopen();
      }
      // Server greets → client identifies/resumes → server Readys.
      this._server({ op: 0, t: "Hello", d: {} });
    });
  }

  send(raw) {
    const msg = JSON.parse(raw);
    this.sent.push(msg);
    if (msg.op === 10 || msg.op === 11) {
      // identify / resume → Ready
      queueMicrotask(() =>
        this._server({
          op: 0,
          t: "Ready",
          d: { session_id: "sess-1", session_token: "tok-1" },
        })
      );
    }
  }

  /** Push a raw server frame to the client (test-driven). */
  server(obj) {
    this._server(obj);
  }

  _server(obj) {
    if (this.readyState !== 1) {
      return;
    }
    if (this.onmessage) {
      this.onmessage({ data: JSON.stringify(obj) });
    }
  }

  close(code, reason) {
    if (this.readyState === 3) {
      return;
    }
    this.readyState = 3;
    if (this.onclose) {
      this.onclose({ code: code || 1000, reason: reason || "" });
    }
  }
}
FakeWebSocket.CONNECTING = 0;
FakeWebSocket.OPEN = 1;
FakeWebSocket.CLOSING = 2;
FakeWebSocket.CLOSED = 3;
FakeWebSocket.instances = [];
FakeWebSocket.last = null;

/** Reset the shared instance registry between tests. */
function resetWs() {
  FakeWebSocket.instances = [];
  FakeWebSocket.last = null;
}

/**
 * Build a fetch stub over a mutable store.
 * @param {{ agentId: string, aggregates: Record<string, any>, calls: any[] }} state
 */
function makeFetch(state) {
  const { applyDiff } = require("../lib/diff");
  return async (url, opts = {}) => {
    const u = String(url);
    const method = (opts.method || "GET").toUpperCase();
    const bodyObj = opts.body ? JSON.parse(opts.body) : undefined;
    state.calls.push({ url: u, method, body: bodyObj });

    const respond = (body, status = 200) => ({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => "application/json" },
      json: async () => body,
      text: async () => JSON.stringify(body),
      blob: async () => body,
    });

    // /agents/{id}/channels/{ch}/aggregate
    const aggMatch = u.match(/\/agents\/([^/]+)\/channels\/([^/]+)\/aggregate/);
    if (aggMatch) {
      const ch = decodeURIComponent(aggMatch[2]);
      if (method === "GET") {
        if (!(ch in state.aggregates)) {
          return respond({ detail: "Channel not found" }, 404);
        }
        return respond({
          data: state.aggregates[ch],
          attachments: [],
          last_updated: 1,
        });
      }
      if (method === "PATCH") {
        const base = state.aggregates[ch] || {};
        state.aggregates[ch] = applyDiff(base, bodyObj, { doDelete: true });
        return respond({ data: state.aggregates[ch] });
      }
      if (method === "PUT") {
        state.aggregates[ch] = bodyObj;
        return respond({ data: state.aggregates[ch] });
      }
    }

    // /agents/ list
    if (/\/agents\/?(\?|$)/.test(u)) {
      return respond({ agents: [{ id: state.agentId }] });
    }
    return respond({});
  };
}

/** Await a couple of macrotasks so the async handshake / seeds settle. */
function flush() {
  return new Promise((resolve) => setTimeout(resolve, 15));
}

/**
 * @param {object} [over] - option overrides
 * @returns {{ t: DooverJsLocalTransport, state: any }}
 */
function makeLocal(over = {}) {
  resetWs();
  const state = {
    agentId: "agent-xyz",
    aggregates: over.aggregates || {},
    calls: [],
  };
  const t = new DooverJsLocalTransport({
    baseUrl: "http://127.0.0.1:49100",
    appKey: over.appKey !== undefined ? over.appKey : "app",
    fetchImpl: makeFetch(state),
    webSocketImpl: FakeWebSocket,
  });
  return { t, state };
}

/** Build a channel AggregateUpdate frame for the last socket. */
function pushAggregate(channel, data, agentId = "agent-xyz") {
  FakeWebSocket.last.server({
    op: 0,
    t: "AggregateUpdate",
    d: {
      channel: { agent_id: agentId, name: channel },
      aggregate: { data, attachments: [], last_updated: 2 },
    },
  });
}

// ---------------------------------------------------------------------------
// Local transport — lifecycle & identity
// ---------------------------------------------------------------------------

test("local: connect resolves the agent id and reports connected", async () => {
  const { t } = makeLocal();
  const seen = [];
  t.on("status", (s) => seen.push(s));
  await t.connect();
  assert.equal(t.status(), "connected");
  assert.equal(t.agentId(), "agent-xyz");
  assert.equal(t.appKey(), "app");
  assert.ok(seen.includes("connecting"));
  assert.ok(seen.includes("connected"));
  await t.close();
  assert.equal(t.status(), "disconnected");
});

test("local: appKey falls back to $APP_KEY", async () => {
  const prev = process.env.APP_KEY;
  process.env.APP_KEY = "env_app";
  try {
    resetWs();
    const state = { agentId: "a", aggregates: {}, calls: [] };
    const t = new DooverJsLocalTransport({
      baseUrl: "http://127.0.0.1:49100",
      fetchImpl: makeFetch(state),
      webSocketImpl: FakeWebSocket,
    });
    assert.equal(t.appKey(), "env_app");
    await t.close();
  } finally {
    if (prev === undefined) {
      delete process.env.APP_KEY;
    } else {
      process.env.APP_KEY = prev;
    }
  }
});

test("local: baseUrl defaults to $DDA_WEB_URI when set", () => {
  const prev = process.env.DDA_WEB_URI;
  process.env.DDA_WEB_URI = "http://dda-host:49100";
  try {
    const t = new DooverJsLocalTransport();
    assert.equal(t._baseUrl, "http://dda-host:49100");
  } finally {
    if (prev === undefined) {
      delete process.env.DDA_WEB_URI;
    } else {
      process.env.DDA_WEB_URI = prev;
    }
  }
});

// ---------------------------------------------------------------------------
// Local transport — connect/close race & lifecycle robustness
//
// These drive the transport with a hand-built doover-js *client* (injected via
// `opts.client`) whose gateway.connect() / getAgentScope() the test resolves on
// demand — so a close() or a second connect() can be interleaved at an exact
// point mid-connect. That control is impossible with the auto-completing
// FakeWebSocket above.
// ---------------------------------------------------------------------------

/**
 * A minimal controllable doover-js client stand-in.
 * @param {{ agentId?: string, connectDeferred?: boolean, scopeDeferred?: boolean, scopeThrows?: boolean }} [o]
 */
function makeControllableClient(o = {}) {
  const ctl = /** @type {any} */ ({ disconnects: 0 });
  const gateway = {
    _open: false,
    connect() {
      if (o.connectDeferred) {
        return new Promise((res) => {
          ctl.resolveConnect = () => {
            gateway._open = true;
            res(undefined);
          };
        });
      }
      gateway._open = true;
      return Promise.resolve();
    },
    isConnected() {
      return gateway._open;
    },
    disconnect() {
      ctl.disconnects += 1;
      gateway._open = false;
    },
    on() {},
    off() {},
    subscribeToChannel() {
      return () => {};
    },
    sendOneShotMessage() {},
  };
  ctl.gateway = gateway;
  ctl.client = {
    gateway,
    onStatusChange(fn) {
      ctl.statusCb = fn;
      return () => {};
    },
    getAgentScope() {
      if (o.scopeThrows) {
        return Promise.reject(new Error("agent scope unreachable"));
      }
      if (o.scopeDeferred) {
        return new Promise((res, rej) => {
          ctl.resolveScope = () =>
            res({ mode: "list", agentIds: [o.agentId || "agent-late"] });
          ctl.rejectScope = rej;
        });
      }
      return Promise.resolve({ mode: "list", agentIds: [o.agentId || "a"] });
    },
  };
  return ctl;
}

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

test("local: close() during an in-flight connect() wins and does not leak the gateway socket", async () => {
  const ctl = makeControllableClient({ connectDeferred: true });
  const t = new DooverJsLocalTransport({ client: ctl.client });
  const p = t.connect();
  await tick(); // park inside `await gateway.connect()`
  await t.close(); // close interleaves the in-flight connect
  assert.equal(t.status(), "disconnected");

  // The gateway socket opens AFTER close() (connect resolves late). The fix must
  // recheck `_closed` and tear it back down — not leave a live socket behind a
  // transport that reports "disconnected", and never flip to "connected".
  ctl.resolveConnect();
  await p;
  assert.equal(t.status(), "disconnected", "close wins the race");
  assert.equal(ctl.gateway.isConnected(), false, "no leaked open gateway socket");
  assert.ok(ctl.disconnects >= 1, "gateway was disconnected");
});

test("local: a concurrent connect() joins the in-flight connect and sees the resolved agent id", async () => {
  const ctl = makeControllableClient({ scopeDeferred: true, agentId: "agent-late" });
  const t = new DooverJsLocalTransport({ client: ctl.client });
  const p1 = t.connect();
  await tick(); // park inside `await getAgentScope()`
  assert.equal(t.agentId(), null, "agent id not resolved yet");

  // The gateway's own status callback flips us to "connected" while the agent id
  // is still null. A second connect() must NOT short-circuit on that status — it
  // must join the in-flight connect and observe the resolved id.
  ctl.statusCb({ state: "connected" });
  const p2 = t.connect();
  ctl.resolveScope();
  await Promise.all([p1, p2]);
  assert.equal(t.agentId(), "agent-late", "concurrent connect saw the resolved id");
  assert.equal(t.status(), "connected");
  await t.close();
});

test("local: a failed connect() ends 'disconnected' (never stuck at 'connecting')", async () => {
  const ctl = makeControllableClient({ scopeThrows: true });
  const t = new DooverJsLocalTransport({ client: ctl.client });
  const seen = [];
  t.on("status", (s) => seen.push(s));
  await assert.rejects(() => t.connect(), /unreachable/);
  assert.equal(t.status(), "disconnected", "failed connect falls back to disconnected");
  assert.ok(seen.includes("connecting"));
  assert.ok(seen.includes("disconnected"));
  await t.close();
});

// ---------------------------------------------------------------------------
// Local transport — publish
// ---------------------------------------------------------------------------

test("local: publish issues a PATCH (merge) with the payload", async () => {
  const { t, state } = makeLocal();
  await t.publish("tag_values", { app: { temp: 5 } });
  const call = state.calls.find(
    (c) => c.method === "PATCH" && c.url.endsWith("/aggregate")
  );
  assert.ok(call, "PATCH issued");
  assert.deepEqual(call.body, { app: { temp: 5 } });
  assert.ok(call.url.includes("/agents/agent-xyz/channels/tag_values/aggregate"));
  await t.close();
});

test("local: publish recordLog sets log_update; replaceData uses PUT", async () => {
  const { t, state } = makeLocal();
  await t.publish("c", { a: 1 }, { recordLog: true });
  await t.publish("c", { a: 2 }, { replaceData: true });
  const patch = state.calls.find((c) => c.method === "PATCH");
  assert.ok(patch.url.includes("log_update=true"), "log_update in query");
  const put = state.calls.find((c) => c.method === "PUT");
  assert.ok(put, "PUT issued for replaceData");
  await t.close();
});

test("local: publish validates the payload before hitting the wire", async () => {
  const { t, state } = makeLocal();
  await assert.rejects(() => t.publish("c", { "bad key": 1 }));
  await assert.rejects(() => t.publish("c", 42));
  assert.equal(
    state.calls.some((c) => c.method === "PATCH" || c.method === "PUT"),
    false
  );
  await t.close();
});

test("local: maxAge is a documented no-op (no query param, no throw)", async () => {
  const { t, state } = makeLocal();
  await t.publish("c", { a: 1 }, { maxAge: 30 });
  const patch = state.calls.find((c) => c.method === "PATCH");
  assert.equal(patch.url.includes("max_age"), false);
  await t.close();
});

// ---------------------------------------------------------------------------
// Local transport — reads
// ---------------------------------------------------------------------------

test("local: getAggregate returns .data", async () => {
  const { t } = makeLocal({ aggregates: { tag_values: { app: { x: 1 } } } });
  assert.deepEqual(await t.getAggregate("tag_values"), { app: { x: 1 } });
  await t.close();
});

test("local: getAggregate returns null on 404", async () => {
  const { t } = makeLocal();
  assert.equal(await t.getAggregate("nope"), null);
  await t.close();
});

// ---------------------------------------------------------------------------
// Local transport — subscribe / one-shot
// ---------------------------------------------------------------------------

test("local: subscribe delivers an initial sync seeded from getAggregate", async () => {
  const { t } = makeLocal({ aggregates: { tag_values: { app: { x: 1 } } } });
  const events = [];
  t.subscribe("tag_values", (m) => events.push(m));
  await flush();
  assert.equal(events[0].event, "sync");
  assert.deepEqual(events[0].aggregate, { app: { x: 1 } });
  await t.close();
});

test("local: a gateway AggregateUpdate is delivered as an aggregate event", async () => {
  const { t } = makeLocal({ aggregates: { tag_values: { app: { x: 1 } } } });
  const events = [];
  t.subscribe("tag_values", (m) => events.push(m));
  await flush();
  pushAggregate("tag_values", { app: { x: 2 } });
  await flush();
  const agg = events.filter((e) => e.event === "aggregate");
  assert.equal(agg.length, 1);
  assert.deepEqual(agg[0].aggregate, { app: { x: 2 } });
  await t.close();
});

test("local: the first event is always a sync even if a gateway update races in", async () => {
  const { t } = makeLocal({ aggregates: { tag_values: { app: { x: 1 } } } });
  const events = [];
  t.subscribe("tag_values", (m) => events.push(m));
  // Push a gateway update immediately, before the REST seed resolves.
  await new Promise((r) => setTimeout(r, 3));
  pushAggregate("tag_values", { app: { x: 9 } });
  await flush();
  assert.equal(events[0].event, "sync", "first delivered event is a sync");
  await t.close();
});

test("local: sendOneShot emits op 15 and inbound one-shots fan out per channel", async () => {
  const { t } = makeLocal();
  const events = [];
  t.subscribe("tag_values", (m) => events.push(m));
  await flush();
  await t.sendOneShot("tag_values", { "app.temp": 21.5 });
  const oneShotFrame = FakeWebSocket.last.sent.find((m) => m.op === 15);
  assert.ok(oneShotFrame, "op 15 sent");
  assert.deepEqual(oneShotFrame.d.channel, {
    agent_id: "agent-xyz",
    name: "tag_values",
  });
  // Inbound one-shot on this channel → oneshot event.
  FakeWebSocket.last.server({
    op: 0,
    t: "OneShotMessage",
    d: {
      id: "1",
      author_id: "x",
      channel: { agent_id: "agent-xyz", name: "tag_values" },
      data: { live: 7 },
    },
  });
  await flush();
  const oneshot = events.find((e) => e.event === "oneshot");
  assert.deepEqual(oneshot.payload, { live: 7 });
  await t.close();
});

test("local: subscriptions multiplex and unsubscribe independently", async () => {
  const { t } = makeLocal({ aggregates: { tag_values: {} } });
  const a = [];
  const b = [];
  t.subscribe("tag_values", (m) => m.event === "aggregate" && a.push(m.payload));
  const unsubB = t.subscribe(
    "tag_values",
    (m) => m.event === "aggregate" && b.push(m.payload)
  );
  await flush();
  pushAggregate("tag_values", { v: 1 });
  await flush();
  unsubB();
  pushAggregate("tag_values", { v: 2 });
  await flush();
  assert.deepEqual(a, [{ v: 1 }, { v: 2 }]);
  assert.deepEqual(b, [{ v: 1 }]);
  await t.close();
});

// ---------------------------------------------------------------------------
// Local transport — RECONNECT RESYNC (the tag-layer-critical path)
// ---------------------------------------------------------------------------

test("local: on gateway 'ready' (resume) the aggregate is re-fetched and re-synced", async () => {
  const { t, state } = makeLocal({
    aggregates: { tag_values: { app: { door: false } } },
  });
  const events = [];
  t.subscribe("tag_values", (m) => events.push(m));
  await flush();
  assert.equal(events.filter((e) => e.event === "sync").length, 1);

  // Value changes "while the stream is down", then a resume completes (Ready).
  state.aggregates.tag_values = { app: { door: true } };
  FakeWebSocket.last.server({
    op: 0,
    t: "Ready",
    d: { session_id: "sess-2" },
  });
  await flush();

  const syncs = events.filter((e) => e.event === "sync");
  assert.equal(syncs.length, 2, "a second sync on resume");
  assert.deepEqual(syncs[1].aggregate, { app: { door: true } });
  await t.close();
});

// ---------------------------------------------------------------------------
// TagClient over the doover-js local transport (must work UNCHANGED)
// ---------------------------------------------------------------------------

test("tags: subscribeTag fires on an aggregate change over the doover-js transport", async () => {
  const { t } = makeLocal({
    appKey: "app",
    aggregates: { tag_values: { app: { temp: 1 } } },
  });
  const tags = new TagClient(t);
  const calls = [];
  tags.subscribeTag("temp", (nv, pv) => calls.push([nv, pv]), { type: "number" });
  await flush(); // consume initial sync (seeds, no fire)
  assert.deepEqual(calls, []);

  pushAggregate("tag_values", { app: { temp: 2 } });
  await flush();
  assert.deepEqual(calls, [[2, 1]]);
  await t.close();
});

test("tags: reconnect reseed fires a tag that changed during the outage", async () => {
  const { t, state } = makeLocal({
    appKey: "app",
    aggregates: { tag_values: { app: { door: { open: false } } } },
  });
  const tags = new TagClient(t);
  const calls = [];
  tags.subscribeTag("door.open", (nv, pv) => calls.push([nv, pv]));
  await flush();
  assert.deepEqual(calls, []);

  // Flip while "down", then resume.
  state.aggregates.tag_values = { app: { door: { open: true } } };
  FakeWebSocket.last.server({ op: 0, t: "Ready", d: { session_id: "s2" } });
  await flush();
  assert.deepEqual(calls, [[true, false]]);
  await t.close();
});

test("tags: setTag publishes a namespaced merge; getTag reads it back", async () => {
  const { t, state } = makeLocal({ appKey: "app", aggregates: {} });
  const tags = new TagClient(t);
  await tags.setTag("mode", "auto");
  // Written under the app namespace.
  assert.deepEqual(state.aggregates.tag_values, { app: { mode: "auto" } });
  assert.equal(await tags.getTag("mode"), "auto");
  await t.close();
});

test("tags: live write goes out as a one-shot (op 15) with a qualified key", async () => {
  const { t } = makeLocal({ appKey: "app", aggregates: {} });
  const tags = new TagClient(t);
  await t.connect();
  await tags.setTag("temperature", 21.5, { live: true });
  const frame = FakeWebSocket.last.sent.find((m) => m.op === 15);
  assert.ok(frame, "one-shot op 15 sent");
  assert.deepEqual(frame.d.data, { "app.temperature": 21.5 });
  await t.close();
});

// ---------------------------------------------------------------------------
// Cloud transport
// ---------------------------------------------------------------------------

/**
 * @param {object} [over]
 * @returns {{ t: DooverJsCloudTransport, state: any }}
 */
function makeCloud(over = {}) {
  resetWs();
  const state = {
    agentId: "cloud-agent",
    aggregates: over.aggregates || {},
    calls: [],
  };
  const t = new DooverJsCloudTransport({
    agentId: "cloud-agent",
    token: "tok",
    tokenExpires: Date.now() + 3600_000,
    dataWssUrl: "wss://data.example/ws",
    dataRestUrl: "https://data.example/api",
    controlApiUrl: "https://api.example",
    appKey: over.appKey,
    fetchImpl: makeFetch(state),
    webSocketImpl: FakeWebSocket,
  });
  return { t, state };
}

test("cloud: requires a target agentId", () => {
  assert.throws(() => new DooverJsCloudTransport({ token: "x" }));
});

test("cloud: is scoped to the configured agent for reads and writes", async () => {
  const { t, state } = makeCloud({
    aggregates: { tag_values: { g: { x: 1 } } },
  });
  await t.connect();
  assert.equal(t.agentId(), "cloud-agent");
  assert.deepEqual(await t.getAggregate("tag_values"), { g: { x: 1 } });
  await t.publish("tag_values", { g: { x: 2 } });
  const patch = state.calls.find((c) => c.method === "PATCH");
  assert.ok(
    patch.url.includes("/agents/cloud-agent/channels/tag_values/aggregate"),
    "write scoped to configured agent"
  );
  await t.close();
});

test("cloud: appKey is null unless configured", async () => {
  const { t } = makeCloud();
  assert.equal(t.appKey(), null);
  await t.close();
  const { t: t2 } = makeCloud({ appKey: "cu_app" });
  assert.equal(t2.appKey(), "cu_app");
  await t2.close();
});

test("cloud: subscribe seeds a sync and delivers aggregate updates", async () => {
  const { t } = makeCloud({ aggregates: { tag_values: { g: { x: 1 } } } });
  const events = [];
  t.subscribe("tag_values", (m) => events.push(m));
  await flush();
  assert.equal(events[0].event, "sync");
  pushAggregate("tag_values", { g: { x: 2 } }, "cloud-agent");
  await flush();
  assert.ok(events.some((e) => e.event === "aggregate"));
  await t.close();
});

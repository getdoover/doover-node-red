"use strict";

/**
 * CONTRACT TEST — DooverJsLocalTransport against a real in-process fake DDA.
 *
 * Unlike dooverjs-transport.test.js (which injects a hand-scripted FakeWebSocket
 * and a fetch stub), this suite stands up a REAL `node:http` + `ws` server
 * (test/harness/fake-dda-server.js) and drives the transport through it over
 * genuine sockets — exercising real fetch, real WebSocket framing, real
 * reconnect/backoff and real response timing. It is the closest thing to the
 * on-device smoke test we can run in CI, and it is fast + fully local so it
 * ships in the default `node --test` run.
 *
 * FINDINGS surfaced by this workout (see the transport source line refs):
 *
 *   F1 (surface mismatch, from ground truth). doover-js `LocalAgentClient` 0.7.1
 *      speaks the CLOUD Doover-Data contract (`/agents/{id}/channels/...` REST +
 *      opcode gateway), NOT the shipping dda-agent web surface (`/ch/v1/...` +
 *      `UI_SUBSCRIBE_CHANNEL`). Confirmed against the installed dist and the
 *      dda-agent black-box suite tests_bb/test_local_http_wss.py. So this fake —
 *      and our transport — cannot talk to the real port-49100 server as-is. The
 *      harness header documents this in full; the on-device test must resolve it.
 *
 *   F2 (transport robustness). `GatewayClient.handleMessage` runs
 *      `JSON.parse(raw)` with NO try/catch (gateway-client.js). A malformed
 *      (non-JSON) WSS frame from the agent throws synchronously inside the
 *      socket 'message' handler → an UNCAUGHT exception that can crash the
 *      Node-RED process. Pinned by `handleMessage("<not json>")` below.
 *
 *   F3 (transport robustness). `RestClient` issues plain `fetch` with no
 *      AbortController/timeout (rest-client.js). A slow/hung DDA web server makes
 *      `connect()`, `getAggregate()` and `publish()` hang indefinitely with no
 *      client-side deadline. Demonstrated by the delayResponses test.
 *
 *   F4 (transport robustness, PARTIALLY FIXED). `connect()` used to resolve to
 *      "connected" the moment the REST agent-scope call succeeded and the gateway
 *      socket was merely *created* — before it OPENed. That dropped the first
 *      post-connect one-shot (doover-js `sendOneShotMessage` drops frames while
 *      `!isConnected()`). connect() now waits (bounded by `gatewayOpenTimeoutMs`)
 *      for the socket to reach OPEN, so the happy path no longer drops the first
 *      one-shot (see the "connect() does not report connected until the gateway
 *      WS is OPEN" test). The RESIDUAL gap: a permanently-refused/dead gateway
 *      still resolves connect() after the timeout and reports "connected" while
 *      live subscriptions are silently dead — pinned by the refuseUpgrades test.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const WebSocket = require("ws");

const { FakeDdaServer } = require("./harness/fake-dda-server");
const {
  DooverJsLocalTransport,
} = require("../lib/dooverjs-transport");
const { TagClient } = require("../lib/tags");

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Poll `cond` until truthy or timeout.
 * @param {() => boolean} cond
 * @param {number} [ms]
 * @returns {Promise<void>}
 */
function waitFor(cond, ms = 4000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      let ok = false;
      try {
        ok = cond();
      } catch (_e) {
        ok = false;
      }
      if (ok) {
        clearInterval(iv);
        resolve();
      } else if (Date.now() - t0 > ms) {
        clearInterval(iv);
        reject(new Error("waitFor: timed out"));
      }
    }, 8);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Stand up a fake server + a transport wired to it. Registers teardown on `t`.
 * @param {import('node:test').TestContext} t
 * @param {{ agentId?: string, appKey?: string|null, seed?: Record<string, any>, gatewayOpenTimeoutMs?: number }} [over]
 * @returns {Promise<{ server: FakeDdaServer, transport: DooverJsLocalTransport }>}
 */
async function setup(t, over = {}) {
  const server = new FakeDdaServer({ agentId: over.agentId || "agent-xyz" });
  await server.start();
  for (const [ch, data] of Object.entries(over.seed || {})) {
    server.setAggregate(ch, data);
  }
  const transport = new DooverJsLocalTransport({
    baseUrl: server.baseUrl,
    wssUrl: server.wssUrl,
    appKey: over.appKey !== undefined ? over.appKey : "app",
    webSocketImpl: WebSocket,
    ...(over.gatewayOpenTimeoutMs != null
      ? { gatewayOpenTimeoutMs: over.gatewayOpenTimeoutMs }
      : {}),
  });
  t.after(async () => {
    try {
      await transport.close();
    } catch (_e) {
      /* ignore */
    }
    await server.stop();
  });
  return { server, transport };
}

// ---------------------------------------------------------------------------
// connect / identity
// ---------------------------------------------------------------------------

test("contract: connect resolves the agent id over real REST + reports connected", async (t) => {
  const { transport } = await setup(t);
  const seen = [];
  transport.on("status", (s) => seen.push(s));
  await transport.connect();
  assert.equal(transport.status(), "connected");
  assert.equal(transport.agentId(), "agent-xyz");
  assert.equal(transport.appKey(), "app");
  assert.ok(seen.includes("connected"));
});

test("contract: connect() does not report connected until the gateway WS is OPEN (first one-shot is not dropped)", async (t) => {
  // Regression for the "connect resolves before the socket is OPEN" race:
  // doover-js gateway.connect() resolves when the socket is CREATED, not opened,
  // and sendOneShotMessage silently drops frames while !isConnected(). connect()
  // now waits (bounded) for the socket to reach OPEN, so immediately after an
  // awaited connect() the gateway really is connected and a one-shot lands.
  const { transport } = await setup(t, { seed: { live_ch: {} } });

  // connect() is the very first call on a fresh transport, driving the REAL
  // async `ws` socket. Pre-fix, gateway.connect() resolved while the socket was
  // still CONNECTING, so isConnected() here would be false; post-fix connect()
  // waits for OPEN, so it is true the instant connect() resolves.
  await transport.connect();
  assert.equal(
    transport._client.gateway.isConnected(),
    true,
    "gateway socket is OPEN when connect() resolves"
  );

  // And a one-shot sent right after connect() is actually delivered (would be
  // dropped by doover-js if the socket were still CONNECTING).
  const events = [];
  transport.subscribe("live_ch", (m) => events.push(m));
  await waitFor(() => events.some((e) => e.event === "sync"));
  await transport.sendOneShot("live_ch", { "app.x": 1 });
  await waitFor(() => events.some((e) => e.event === "oneshot"));
  assert.deepEqual(
    events.find((e) => e.event === "oneshot").payload,
    { "app.x": 1 }
  );
});

test("contract: healthcheck endpoint answers 200 ok", async (t) => {
  const { server } = await setup(t);
  const res = await fetch(`${server.baseUrl}/healthcheck`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: "ok" });
});

// ---------------------------------------------------------------------------
// aggregate fetch
// ---------------------------------------------------------------------------

test("contract: getAggregate returns .data; unknown channel -> null (404)", async (t) => {
  const { transport } = await setup(t, {
    seed: { tag_values: { app: { x: 1 } } },
  });
  assert.deepEqual(await transport.getAggregate("tag_values"), { app: { x: 1 } });
  assert.equal(await transport.getAggregate("never_seen"), null);
});

// ---------------------------------------------------------------------------
// publish / subscribe roundtrip (real WSS broadcast)
// ---------------------------------------------------------------------------

test("contract: publish/subscribe roundtrip over real sockets (merge semantics)", async (t) => {
  const { transport } = await setup(t, {
    seed: { tag_values: { app: { temp: 1, mode: "auto" } } },
  });
  const events = [];
  transport.subscribe("tag_values", (m) => events.push(m));
  await waitFor(() => events.some((e) => e.event === "sync"));
  assert.deepEqual(
    events.find((e) => e.event === "sync").aggregate,
    { app: { temp: 1, mode: "auto" } }
  );

  // A merge PATCH must not clobber sibling keys (real applyDiff on the server).
  await transport.publish("tag_values", { app: { temp: 2 } });
  await waitFor(() => events.some((e) => e.event === "aggregate"));
  const agg = events.filter((e) => e.event === "aggregate").pop();
  assert.deepEqual(agg.aggregate, { app: { temp: 2, mode: "auto" } });
});

test("contract: replaceData issues a PUT (wholesale replace)", async (t) => {
  const { server, transport } = await setup(t, {
    seed: { c: { a: 1, b: 2 } },
  });
  await transport.publish("c", { a: 9 }, { replaceData: true });
  assert.deepEqual(server.getAggregate("c"), { a: 9 });
  assert.ok(server.calls.some((c) => c.method === "PUT"));
});

test("contract: maxAge is a no-op on the wire and warns exactly once per process", async (t) => {
  // The honest-contract fix: PublishOptions.maxAge has no doover-js equivalent,
  // so it never reaches the wire (no query param, no throw) AND the first use
  // per process emits a single console.warn rather than silently pretending the
  // hint took effect. This file's process trips the warn latch here (no other
  // test in it passes maxAge), so the once-only assertion is deterministic.
  const { server, transport } = await setup(t);
  const origWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    await transport.publish("c", { a: 1 }, { maxAge: 30 });
    await transport.publish("c", { a: 2 }, { maxAge: -1 });
  } finally {
    console.warn = origWarn;
  }
  const maxAgeWarnings = warnings.filter((w) => /maxAge/i.test(w));
  assert.equal(maxAgeWarnings.length, 1, "warned exactly once across two uses");
  // Never leaked onto the write: no max_age query param on either PATCH.
  const patches = server.calls.filter((c) => c.method === "PATCH");
  assert.ok(patches.length >= 2, "both writes issued");
  assert.ok(
    patches.every((c) => !("max_age" in (c.query || {}) || "max_age_secs" in (c.query || {}))),
    "no max-age hint on the wire"
  );
});

test("contract: recordLog sends log_update=true on the write query", async (t) => {
  const { server, transport } = await setup(t);
  await transport.publish("c", { a: 1 }, { recordLog: true });
  const patch = server.calls.find((c) => c.method === "PATCH");
  assert.ok(patch, "PATCH issued");
  assert.equal(patch.query.log_update, "true");
});

test("contract: subscriptions multiplex and unsubscribe independently", async (t) => {
  const { server, transport } = await setup(t, { seed: { c: {} } });
  const a = [];
  const b = [];
  // Filter to `.v` so the F5 seed-echo aggregate (empty `{}`) is excluded and
  // we assert only on the values this test publishes.
  const pickV = (arr) => (m) => {
    if (m.event === "aggregate" && m.payload && m.payload.v != null) {
      arr.push(m.payload.v);
    }
  };
  transport.subscribe("c", pickV(a));
  const unsubB = transport.subscribe("c", pickV(b));
  // Wait until the gateway op:12 subscribe has landed — AggregateUpdates are
  // live-only, so a publish before this would be lost.
  await waitFor(() => server.subscriberCount("c") >= 1);

  server.publishAggregate("c", { v: 1 });
  await waitFor(() => a.includes(1) && b.includes(1));
  unsubB();
  server.publishAggregate("c", { v: 2 });
  await waitFor(() => a.includes(2));
  await sleep(40);
  assert.deepEqual(a, [1, 2]);
  assert.deepEqual(b, [1]);
});

// ---------------------------------------------------------------------------
// one-shot roundtrip
// ---------------------------------------------------------------------------

test("contract: sendOneShot round-trips as a per-channel oneshot event", async (t) => {
  const { transport } = await setup(t, { seed: { live_ch: {} } });
  const events = [];
  transport.subscribe("live_ch", (m) => events.push(m));
  await waitFor(() => events.some((e) => e.event === "sync"));

  await transport.sendOneShot("live_ch", { "app.temp": 21.5 });
  await waitFor(() => events.some((e) => e.event === "oneshot"));
  assert.deepEqual(
    events.find((e) => e.event === "oneshot").payload,
    { "app.temp": 21.5 }
  );
});

// ---------------------------------------------------------------------------
// message post -> message event
// ---------------------------------------------------------------------------

test("contract: a posted channel message arrives as a message event", async (t) => {
  const { server, transport } = await setup(t, { seed: { events_ch: {} } });
  const events = [];
  transport.subscribe("events_ch", (m) => events.push(m));
  await waitFor(() => events.some((e) => e.event === "sync"));

  server.postMessage("events_ch", { level: "warn", text: "hi" });
  await waitFor(() => events.some((e) => e.event === "message"));
  const msg = events.find((e) => e.event === "message");
  assert.deepEqual(msg.payload, { level: "warn", text: "hi" });
  assert.ok(msg.messageId, "message id present");
});

// ---------------------------------------------------------------------------
// tag layer over the real transport
// ---------------------------------------------------------------------------

test("contract: TagClient.subscribeTag fires on an aggregate change", async (t) => {
  const { transport } = await setup(t, {
    seed: { tag_values: { app: { temp: 1 } } },
  });
  const tags = new TagClient(transport);
  const calls = [];
  tags.subscribeTag("temp", (nv, pv) => calls.push([nv, pv]), { type: "number" });
  await waitFor(() => transport.status() === "connected");
  await sleep(80); // consume initial sync (seeds, no fire)
  assert.deepEqual(calls, []);

  await transport.publish("tag_values", { app: { temp: 2 } });
  await waitFor(() => calls.length > 0);
  assert.deepEqual(calls, [[2, 1]]);
});

test("contract: TagClient.setTag live=true goes out as a one-shot", async (t) => {
  const { server, transport } = await setup(t, {
    seed: { tag_values: {} },
  });
  const tags = new TagClient(transport);
  // Subscribe so the server has a target to broadcast the one-shot back to,
  // and so we can observe it land.
  const events = [];
  transport.subscribe("tag_values", (m) => events.push(m));
  await waitFor(() => events.some((e) => e.event === "sync"));

  await tags.setTag("temperature", 21.5, { live: true });
  await waitFor(() => events.some((e) => e.event === "oneshot"));
  assert.deepEqual(
    events.find((e) => e.event === "oneshot").payload,
    { "app.temperature": 21.5 }
  );
});

// ---------------------------------------------------------------------------
// RECONNECT-RESYNC after dropConnections (the tag-layer-critical path)
// ---------------------------------------------------------------------------

test("contract: reconnect after dropConnections re-syncs; tag layer sees the change made while disconnected", async (t) => {
  const { server, transport } = await setup(t, {
    seed: { tag_values: { app: { door: { open: false } } } },
  });
  const tags = new TagClient(transport);
  const calls = [];
  tags.subscribeTag("door.open", (nv, pv) => calls.push([nv, pv]));
  await waitFor(() => transport.status() === "connected");
  await sleep(80);
  assert.deepEqual(calls, [], "no spurious fire on initial seed");

  // Kill the live socket, then mutate the aggregate "while the client is down".
  server.dropConnections();
  server.setAggregate("tag_values", { app: { door: { open: true } } });

  // The gateway auto-reconnects (Hello -> resume -> Ready); the transport
  // re-fetches each channel's aggregate on 'ready' and re-delivers a sync, so
  // the tag layer diffs the missed change and fires.
  await waitFor(() => calls.length > 0, 8000);
  assert.deepEqual(calls, [[true, false]]);
});

// ---------------------------------------------------------------------------
// malformed-frame resilience  (+ F2 finding)
// ---------------------------------------------------------------------------

test("contract: transport survives JSON-valid but unknown WSS frames", async (t) => {
  const { server, transport } = await setup(t, {
    seed: { c: { app: { v: 1 } } },
  });
  const events = [];
  transport.subscribe("c", (m) => events.push(m));
  await waitFor(() => events.some((e) => e.event === "sync"));

  // Unknown op / unknown event type / wrong shape — all should be ignored.
  server.broadcastRaw(JSON.stringify({ op: 0, t: "TotallyUnknown", d: {} }));
  server.broadcastRaw(JSON.stringify({ op: 99, d: { nope: true } }));
  server.broadcastRaw(JSON.stringify({ hello: "world" }));
  await sleep(60);

  // Still fully functional afterwards.
  await transport.publish("c", { app: { v: 2 } });
  await waitFor(() => events.some((e) => e.event === "aggregate"));
  assert.deepEqual(
    events.filter((e) => e.event === "aggregate").pop().aggregate,
    { app: { v: 2 } }
  );
});

test("contract: F2 — a non-JSON WSS frame throws uncaught in GatewayClient.handleMessage", async (t) => {
  const { transport } = await setup(t, { seed: { c: {} } });
  await transport.connect();
  // `handleMessage` is exactly what the socket 'message' handler calls with the
  // raw frame. With a real malformed frame this throw escapes as an uncaught
  // exception on the ws socket callback — a process-crash risk on device. We
  // assert it here deterministically rather than firing it at the live socket
  // (which would crash the test runner) — that is the whole point of the finding.
  assert.throws(
    () => transport._client.gateway.handleMessage("this is <not> json"),
    /JSON|Unexpected token/i
  );
});

// ---------------------------------------------------------------------------
// slow-server behaviour  (F3 finding)
// ---------------------------------------------------------------------------

test("contract: F3 — the transport has no client-side REST timeout (slow DDA hangs it)", async (t) => {
  const { server, transport } = await setup(t, { seed: { c: { v: 1 } } });
  await transport.connect();

  const delay = 250;
  server.delayResponses(delay);
  const t0 = Date.now();
  const p = transport.getAggregate("c");

  // Within a much shorter budget the call has NOT aborted/rejected — the
  // transport simply waits for the slow server (no AbortController/deadline).
  const raced = await Promise.race([
    p.then(() => "settled"),
    sleep(80).then(() => "still-pending"),
  ]);
  assert.equal(raced, "still-pending", "no early timeout/abort");

  // It eventually resolves once the server responds — waited the full delay.
  const val = await p;
  const elapsed = Date.now() - t0;
  assert.deepEqual(val, { v: 1 });
  assert.ok(elapsed >= delay - 20, `waited for slow server (${elapsed}ms)`);
  server.delayResponses(0);
});

// ---------------------------------------------------------------------------
// refuseUpgrades  (F4 finding)
// ---------------------------------------------------------------------------

test("contract: F4 — a permanently-refused WSS upgrade still resolves connect() (bounded) and reports connected", async (t) => {
  // connect() now waits for the gateway to reach OPEN before reporting connected
  // (fixes the healthy-path "first one-shot dropped" race). But that wait is
  // BOUNDED by gatewayOpenTimeoutMs so a permanently-dead/refused gateway never
  // hangs connect(): after the timeout, connect() resolves and status reflects
  // the client's own not-connected view. Live subscriptions would still be
  // silently dead — the remaining F4 robustness gap. Use a short timeout here so
  // the bounded wait is observable without slowing the suite.
  const { server, transport } = await setup(t, { gatewayOpenTimeoutMs: 150 });
  server.refuseUpgrades(true);

  const t0 = Date.now();
  const raced = await Promise.race([
    transport.connect().then(() => "resolved"),
    sleep(1500).then(() => "hung"),
  ]);
  const elapsed = Date.now() - t0;
  assert.equal(raced, "resolved", "connect() must not hang on a dead gateway");
  // It waited for the bounded open-timeout rather than resolving instantly.
  assert.ok(elapsed >= 140, `waited the bounded open-timeout (${elapsed}ms)`);
  assert.equal(transport.status(), "connected");
  assert.equal(
    transport._client.isConnected(),
    false,
    "gateway is NOT actually connected — live subscriptions would be silently dead"
  );
});

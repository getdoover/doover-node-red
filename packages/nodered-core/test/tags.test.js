"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { MockTransport } = require("../lib/mock-transport");
const { TagClient } = require("../lib/tags");

/** Flush pending microtasks (emitInitial fires on a microtask). */
function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("setTag namespaces under the app key inside tag_values", async () => {
  const t = new MockTransport({ autoConnect: true, appKey: "cu_myapp_1234" });
  const tags = new TagClient(t);
  await tags.setTag("temperature", 25.5);
  const agg = await t.getAggregate("tag_values");
  assert.deepEqual(agg, { cu_myapp_1234: { temperature: 25.5 } });
});

test("global tags land at the root with no wrapper key", async () => {
  const t = new MockTransport({ autoConnect: true, appKey: "cu_myapp_1234" });
  const tags = new TagClient(t);
  await tags.setTag("system_mode", "auto", { global: true });
  const agg = await t.getAggregate("tag_values");
  assert.deepEqual(agg, { system_mode: "auto" });
});

test("another app's namespace via appKey option", async () => {
  const t = new MockTransport({ autoConnect: true, appKey: "cu_myapp_1234" });
  const tags = new TagClient(t);
  await tags.setTag("pump_speed", 1450, { appKey: "cu_otherapp_5678" });
  const agg = await t.getAggregate("tag_values");
  assert.deepEqual(agg, { cu_otherapp_5678: { pump_speed: 1450 } });
});

test("nested key paths via dot-notation", async () => {
  const t = new MockTransport({ autoConnect: true, appKey: "app" });
  const tags = new TagClient(t);
  await tags.setTag("battery.voltage", 12.3);
  await tags.setTag("battery.current", 0.8);
  const agg = await t.getAggregate("tag_values");
  assert.deepEqual(agg, { app: { battery: { voltage: 12.3, current: 0.8 } } });
  assert.equal(await tags.getTag("battery.voltage"), 12.3);
});

test("invalid key segment (dot survivor / bad char) is rejected early", async () => {
  const t = new MockTransport({ autoConnect: true, appKey: "app" });
  const tags = new TagClient(t);
  await assert.rejects(() => tags.setTag(["bad key"], 1));
  await assert.rejects(() => tags.setTag(["a.b"], 1)); // array segment keeps the dot
});

test("getTag returns default when unset, coerces by type", async () => {
  const t = new MockTransport({ autoConnect: true, appKey: "app" });
  const tags = new TagClient(t);
  assert.equal(await tags.getTag("missing", { default: 7 }), 7);
  await tags.setTag("count", 5.0);
  // stored as JSON number; integer coercion keeps it an int
  assert.equal(await tags.getTag("count", { type: "integer" }), 5);
  await tags.setTag("flag", 1);
  assert.equal(await tags.getTag("flag", { type: "boolean" }), true);
});

test("setTags does an atomic multi-write in one channel write", async () => {
  const t = new MockTransport({ autoConnect: true, appKey: "app" });
  let publishes = 0;
  const origPublish = t.publish.bind(t);
  t.publish = async (ch, payload, opts) => {
    publishes++;
    return origPublish(ch, payload, opts);
  };
  const tags = new TagClient(t);
  await tags.setTags({ a: 1, "nested.b": 2, c: 3 });
  assert.equal(publishes, 1);
  const agg = await t.getAggregate("tag_values");
  assert.deepEqual(agg, { app: { a: 1, nested: { b: 2 }, c: 3 } });
});

test("only_if_changed: unchanged write is a no-op (no publish)", async () => {
  const t = new MockTransport({ autoConnect: true, appKey: "app" });
  const tags = new TagClient(t);
  await tags.setTag("x", 1);

  let publishes = 0;
  const origPublish = t.publish.bind(t);
  t.publish = async (ch, payload, opts) => {
    publishes++;
    return origPublish(ch, payload, opts);
  };
  await tags.setTag("x", 1); // unchanged
  assert.equal(publishes, 0);
  await tags.setTag("x", 2); // changed
  assert.equal(publishes, 1);
});

test("onlyIfChanged:false always writes", async () => {
  const t = new MockTransport({ autoConnect: true, appKey: "app" });
  const tags = new TagClient(t);
  await tags.setTag("x", 1);
  let publishes = 0;
  const origPublish = t.publish.bind(t);
  t.publish = async (ch, payload, opts) => {
    publishes++;
    return origPublish(ch, payload, opts);
  };
  await tags.setTag("x", 1, { onlyIfChanged: false });
  assert.equal(publishes, 1);
});

test("getTag re-fetches a fresh aggregate on every read when not subscribed", async () => {
  // Regression: an unsubscribed client cached only the FIRST fetched aggregate
  // and returned it forever, so external changes were invisible.
  const t = new MockTransport({ autoConnect: true, appKey: "app" });
  const reader = new TagClient(t);
  const writer = new TagClient(t);
  await writer.setTag("speed", 10);
  assert.equal(await reader.getTag("speed"), 10);
  await writer.setTag("speed", 20);
  assert.equal(await reader.getTag("speed"), 20, "must not be stuck at 10");
  await writer.setTag("speed", 30);
  assert.equal(await reader.getTag("speed"), 30);
});

test("only-if-changed on an unsubscribed client diffs against the live value", async () => {
  // Regression: the stale cache made setTag(onlyIfChanged) diff against a
  // long-gone value and skip a required write.
  const t = new MockTransport({ autoConnect: true, appKey: "app" });
  const client = new TagClient(t);
  const external = new TagClient(t);
  await client.setTag("pump", 10);
  await external.setTag("pump", 99); // moved externally; client isn't subscribed

  let publishes = 0;
  const origPublish = t.publish.bind(t);
  t.publish = async (...a) => {
    publishes++;
    return origPublish(...a);
  };
  // Writing 10 again MUST publish — the live value is 99, not the stale 10.
  await client.setTag("pump", 10);
  assert.equal(publishes, 1);
  assert.equal(await external.getTag("pump"), 10);
});

test("subscribeTag fires (newValue, prevValue) on change; not on unchanged", async () => {
  const t = new MockTransport({ autoConnect: true, appKey: "app" });
  const tags = new TagClient(t);
  // A second client models an EXTERNAL writer (e.g. another app / process): the
  // subscriber only ever fires on changes it did not fold into its own cache,
  // matching the LocalTransport round-trip.
  const writer = new TagClient(t);
  const calls = [];
  tags.subscribeTag("temperature", (nv, pv) => calls.push([nv, pv]));

  await writer.setTag("temperature", 25);
  await writer.setTag("temperature", 25); // unchanged -> no publish -> no fire
  await writer.setTag("temperature", 30);
  await tick();

  assert.deepEqual(calls, [
    [25, undefined],
    [30, 25],
  ]);
});

test("subscribeTag multiplexes many callbacks per tag", async () => {
  const t = new MockTransport({ autoConnect: true, appKey: "app" });
  const tags = new TagClient(t);
  const writer = new TagClient(t);
  const a = [];
  const b = [];
  tags.subscribeTag("v", (nv) => a.push(nv));
  const unsubB = tags.subscribeTag("v", (nv) => b.push(nv));

  await writer.setTag("v", 1);
  await tick();
  assert.deepEqual(a, [1]);
  assert.deepEqual(b, [1]);

  unsubB();
  await writer.setTag("v", 2);
  await tick();
  assert.deepEqual(a, [1, 2]);
  assert.deepEqual(b, [1]); // unsubscribed, no further fires
});

test("a client does not fire its own subscription on a local write", async () => {
  // Regression: with synchronous mock delivery the writer fired its own tag
  // subscription; on a real Doovit the write is folded into cache before the
  // echo, so it never fires. External changes must still fire.
  const t = new MockTransport({ autoConnect: true, appKey: "app" });
  const tags = new TagClient(t);
  const calls = [];
  tags.subscribeTag("temperature", (nv, pv) => calls.push([nv, pv]));

  await tags.setTag("temperature", 25); // local write on the SAME client
  await tick();
  assert.deepEqual(calls, [], "local write must not fire the local subscription");

  const writer = new TagClient(t);
  await writer.setTag("temperature", 30); // external write
  await tick();
  // prev is 25 even though that write never fired — the local write updated the
  // baseline, so the external change reports the correct previous value.
  assert.deepEqual(calls, [[30, 25]]);
});

test("unsubscribe last callback tears down the channel subscription", async () => {
  const t = new MockTransport({ autoConnect: true, appKey: "app" });
  const tags = new TagClient(t);
  const unsub = tags.subscribeTag("v", () => {});
  assert.equal(t._subscribers.has("tag_values"), true);
  unsub();
  assert.equal(t._subscribers.has("tag_values"), false);
});

test("emitInitial fires once with the current value on subscribe", async () => {
  const t = new MockTransport({
    autoConnect: true,
    appKey: "app",
    aggregates: { tag_values: { app: { seeded: 99 } } },
  });
  const tags = new TagClient(t);
  const calls = [];
  tags.subscribeTag("seeded", (nv, pv) => calls.push([nv, pv]), {
    emitInitial: true,
  });
  await tick();
  assert.deepEqual(calls, [[99, undefined]]);
});

test("subscribeTag on a parent path fires when a child changes", async () => {
  const t = new MockTransport({ autoConnect: true, appKey: "app" });
  const tags = new TagClient(t);
  const writer = new TagClient(t);
  const calls = [];
  tags.subscribeTag("battery", (nv) => calls.push(nv));
  await writer.setTag("battery.voltage", 12.3);
  await tick();
  assert.deepEqual(calls, [{ voltage: 12.3 }]);
});

test("global-scope subscription is independent of app-scope", async () => {
  const t = new MockTransport({ autoConnect: true, appKey: "app" });
  const tags = new TagClient(t);
  const writer = new TagClient(t);
  const globalCalls = [];
  const appCalls = [];
  tags.subscribeTag("mode", (nv) => globalCalls.push(nv), { global: true });
  tags.subscribeTag("mode", (nv) => appCalls.push(nv)); // app-scoped

  await writer.setTag("mode", "g", { global: true });
  await writer.setTag("mode", "a"); // app-scoped
  await tick();

  assert.deepEqual(globalCalls, ["g"]);
  assert.deepEqual(appCalls, ["a"]);
});

test("a post-initial sync (stream reconnect reseed) fires changed subscriptions", async () => {
  // Regression: on reconnect LocalTransport re-delivers a `sync` frame; a tag
  // that changed while the stream was down must fire, not be silently swallowed.
  const t = new MockTransport({
    autoConnect: true,
    appKey: "app",
    aggregates: { tag_values: { app: { door: { open: false } } } },
  });
  const tags = new TagClient(t);
  const calls = [];
  tags.subscribeTag("door.open", (nv, pv) => calls.push([nv, pv]));
  await tick(); // consume the initial sync (seeds, does not fire)
  assert.deepEqual(calls, []);

  // Value flips while the "stream is down", then the stream reconnects and
  // re-seeds with the new aggregate.
  t.seedAggregate("tag_values", { app: { door: { open: true } } });
  t.resync("tag_values");
  await tick();
  assert.deepEqual(calls, [[true, false]]);
});

test("deleteTag transmits null and removes the tag from the aggregate", async () => {
  const t = new MockTransport({ autoConnect: true, appKey: "app" });
  const tags = new TagClient(t);
  await tags.setTag("x", 1);
  await tags.deleteTag("x");
  const agg = await t.getAggregate("tag_values");
  assert.deepEqual(agg, { app: {} });
});

test("live write goes out as a one-shot with qualified dotted key", async () => {
  const t = new MockTransport({ autoConnect: true, appKey: "app" });
  const oneShots = [];
  const origOneShot = t.sendOneShot.bind(t);
  t.sendOneShot = async (ch, payload) => {
    oneShots.push([ch, payload]);
    return origOneShot(ch, payload);
  };
  let publishes = 0;
  const origPublish = t.publish.bind(t);
  t.publish = async (...a) => {
    publishes++;
    return origPublish(...a);
  };
  const tags = new TagClient(t);
  await tags.setTag("temperature", 21.5, { live: true });
  assert.equal(publishes, 0);
  assert.deepEqual(oneShots, [["tag_values", { "app.temperature": 21.5 }]]);
  // one-shot did NOT touch the aggregate
  assert.equal(await t.getAggregate("tag_values"), null);
});

test("log option maps to recordLog on the underlying publish", async () => {
  const t = new MockTransport({ autoConnect: true, appKey: "app" });
  let seenOpts = null;
  const origPublish = t.publish.bind(t);
  t.publish = async (ch, payload, opts) => {
    seenOpts = opts;
    return origPublish(ch, payload, opts);
  };
  const tags = new TagClient(t);
  await tags.setTag("x", 1, { log: true });
  assert.equal(seenOpts.recordLog, true);
});

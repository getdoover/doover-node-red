"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { MockTransport } = require("../lib/mock-transport");

/** Flush pending macrotasks — channel echoes are delivered asynchronously. */
function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("subscribe delivers a sync event with the current aggregate", () => {
  const t = new MockTransport({
    autoConnect: true,
    aggregates: { chan: { a: 1 } },
  });
  const events = [];
  t.subscribe("chan", (msg) => events.push(msg));
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "sync");
  assert.deepEqual(events[0].aggregate, { a: 1 });
});

test("publish merges the aggregate and delivers the FULL merged aggregate", async () => {
  const t = new MockTransport({ autoConnect: true });
  const events = [];
  t.subscribe("chan", (msg) => events.push(msg));
  await t.publish("chan", { a: 1 });
  await t.publish("chan", { b: 2 });
  const agg = await t.getAggregate("chan");
  assert.deepEqual(agg, { a: 1, b: 2 });
  await tick(); // echoes are delivered on the next macrotask
  // events: sync, aggregate(a), aggregate(a+b)
  assert.equal(events[1].event, "aggregate");
  assert.deepEqual(events[1].aggregate, { a: 1 });
  assert.deepEqual(events[2].aggregate, { a: 1, b: 2 });
});

test("publish null deletes a key (server merge semantics)", async () => {
  const t = new MockTransport({ autoConnect: true });
  await t.publish("chan", { a: 1, b: 2 });
  await t.publish("chan", { b: null });
  assert.deepEqual(await t.getAggregate("chan"), { a: 1 });
});

test("sendOneShot delivers a oneshot event WITHOUT touching the aggregate", async () => {
  const t = new MockTransport({ autoConnect: true });
  const events = [];
  t.subscribe("chan", (msg) => events.push(msg));
  await t.sendOneShot("chan", { live: 5 });
  await tick();
  const oneshot = events.find((e) => e.event === "oneshot");
  assert.deepEqual(oneshot.payload, { live: 5 });
  assert.equal(await t.getAggregate("chan"), null);
});

test("subscriptions multiplex and unsubscribe independently", async () => {
  const t = new MockTransport({ autoConnect: true });
  const a = [];
  const b = [];
  t.subscribe("chan", (m) => m.event === "aggregate" && a.push(m.payload));
  const unsubB = t.subscribe(
    "chan",
    (m) => m.event === "aggregate" && b.push(m.payload)
  );
  await t.publish("chan", { v: 1 });
  unsubB();
  await t.publish("chan", { v: 2 });
  await tick();
  // b unsubscribed after the v1 publish, so it still receives the v1 echo (the
  // subscriber set is snapshotted at publish time) but not v2.
  assert.deepEqual(a, [{ v: 1 }, { v: 2 }]);
  assert.equal(b.length, 1);
});

test("aggregate echo is delivered asynchronously, after the publish resolves", async () => {
  // Regression: synchronous delivery let a writer's own subscription fire before
  // it folded the write into cache. The echo must arrive on a later macrotask so
  // the writer (and the tag layer) can settle first — matching LocalTransport.
  const t = new MockTransport({ autoConnect: true });
  const order = [];
  t.subscribe(
    "chan",
    (m) => m.event === "aggregate" && order.push("delivered")
  );
  await t.publish("chan", { v: 1 });
  order.push("after-publish");
  assert.deepEqual(order, ["after-publish"], "not delivered synchronously");
  await tick();
  assert.deepEqual(order, ["after-publish", "delivered"]);
});

test("status transitions emit a status event", async () => {
  const t = new MockTransport();
  const seen = [];
  t.on("status", (s) => seen.push(s));
  await t.connect();
  await t.close();
  assert.deepEqual(seen, ["connected", "disconnected"]);
});

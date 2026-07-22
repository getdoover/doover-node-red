"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const { LocalTransport } = require("../lib/local-transport");
const { jsToStruct } = require("../lib/struct");

/**
 * Build a mock gRPC client that records requests and returns canned responses.
 * Methods use the (request, options, callback) signature grpc-js uses.
 */
function makeMockClient(overrides = {}) {
  const calls = [];
  const ok = (extra) => ({ response_header: { success: true }, ...extra });
  const base = {
    calls,
    // A server-streaming call that stays open until cancelled.
    channelEventSubscription: (req) => {
      calls.push(["channelEventSubscription", req]);
      const s = new EventEmitter();
      s.cancel = () => s.emit("end");
      return s;
    },
    testComms: (req, opts, cb) => {
      calls.push(["testComms", req]);
      cb(null, ok({ response: "pong" }));
    },
    updateAggregate: (req, opts, cb) => {
      calls.push(["updateAggregate", req]);
      cb(null, ok({ aggregate: { data: { fields: {} } } }));
    },
    getAggregate: (req, opts, cb) => {
      calls.push(["getAggregate", req]);
      cb(null, ok({ aggregate: { data: jsToStruct({ app: { x: 1 } }) } }));
    },
    sendOneShotMessage: (req, opts, cb) => {
      calls.push(["sendOneShotMessage", req]);
      cb(null, ok());
    },
    createMessage: (req, opts, cb) => {
      calls.push(["createMessage", req]);
      cb(null, ok({ message_id: "987654321012345678" }));
    },
  };
  return Object.assign(base, overrides);
}

test("publish builds an UpdateAggregate request with the correct fields", async () => {
  const client = makeMockClient();
  const t = new LocalTransport({ client, appKey: "cu_test_1234" });

  await t.publish(
    "tag_values",
    { cu_test_1234: { temp: 5 } },
    { recordLog: true, maxAge: 3 }
  );

  const call = client.calls.find((c) => c[0] === "updateAggregate");
  assert.ok(call, "updateAggregate was called");
  const req = call[1];
  assert.equal(req.channel_name, "tag_values");
  assert.deepEqual(req.header, { app_id: "cu_test_1234" });
  assert.equal(req.replace_data, false);
  assert.equal(req.save_log, true);
  assert.equal(req.max_age_secs, 3);
  assert.deepEqual(req.data, jsToStruct({ cu_test_1234: { temp: 5 } }));
});

test("publish omits max_age_secs when not supplied", async () => {
  const client = makeMockClient();
  const t = new LocalTransport({ client, appKey: "a" });
  await t.publish("chan", { a: { v: 1 } });
  const req = client.calls.find((c) => c[0] === "updateAggregate")[1];
  assert.equal("max_age_secs" in req, false);
  assert.equal(req.save_log, false);
});

test("publish validates the payload before hitting gRPC", async () => {
  const client = makeMockClient();
  const t = new LocalTransport({ client, appKey: "a" });
  await assert.rejects(() => t.publish("chan", { "bad key": 1 }));
  await assert.rejects(() => t.publish("chan", 42)); // non-object top level
  assert.equal(
    client.calls.some((c) => c[0] === "updateAggregate"),
    false
  );
});

test("connect runs a TestComms health probe once", async () => {
  const client = makeMockClient();
  const t = new LocalTransport({ client, appKey: "a" });
  await t.connect();
  assert.equal(t.status(), "connected");
  assert.equal(client.calls.filter((c) => c[0] === "testComms").length, 1);
});

test("getAggregate struct-decodes a successful response", async () => {
  const client = makeMockClient();
  const t = new LocalTransport({ client, appKey: "a" });
  const agg = await t.getAggregate("tag_values");
  assert.deepEqual(agg, { app: { x: 1 } });
});

test("getAggregate returns null on a 404 (channel not found)", async () => {
  const client = makeMockClient({
    getAggregate: (req, opts, cb) =>
      cb(null, { response_header: { success: false, response_code: 404 } }),
  });
  const t = new LocalTransport({ client, appKey: "a" });
  assert.equal(await t.getAggregate("nope"), null);
});

test("sendOneShot bypasses payload validation (dotted keys allowed)", async () => {
  const client = makeMockClient();
  const t = new LocalTransport({ client, appKey: "a" });
  await t.sendOneShot("tag_values", { "app.temperature": 21.5 });
  const req = client.calls.find((c) => c[0] === "sendOneShotMessage")[1];
  assert.deepEqual(req.data, jsToStruct({ "app.temperature": 21.5 }));
  assert.deepEqual(req.header, { app_id: "a" });
});

test("createMessage sets a timestamp and returns the new message id", async () => {
  const client = makeMockClient();
  const t = new LocalTransport({ client, appKey: "a" });
  const id = await t.createMessage("activity", { event: "boot" });
  assert.equal(id, "987654321012345678");
  const req = client.calls.find((c) => c[0] === "createMessage")[1];
  assert.ok(req.timestamp, "timestamp is set");
  assert.deepEqual(req.data, jsToStruct({ event: "boot" }));
});

test("a failure response header throws with code + notFound flag", async () => {
  const client = makeMockClient({
    updateAggregate: (req, opts, cb) =>
      cb(null, {
        response_header: {
          success: false,
          response_code: 500,
          response_message: "boom",
        },
      }),
  });
  const t = new LocalTransport({ client, appKey: "a" });
  await assert.rejects(
    () => t.publish("chan", { a: 1 }),
    (err) => err.message === "boom" && err.code === 500 && err.notFound === false
  );
});

test("emits status events on connect and close", async () => {
  const client = makeMockClient();
  const t = new LocalTransport({ client, appKey: "a" });
  const seen = [];
  t.on("status", (s) => seen.push(s));
  await t.connect();
  await t.close();
  assert.deepEqual(seen, ["connecting", "connected", "disconnected"]);
});

test("subscribe seeds via GetAggregate and delivers a sync event", async () => {
  const client = makeMockClient();
  const t = new LocalTransport({ client, appKey: "a" });
  const events = [];
  await new Promise((resolve) => {
    t.subscribe("tag_values", (msg) => {
      events.push(msg);
      resolve();
    });
  });
  assert.equal(events[0].event, "sync");
  assert.deepEqual(events[0].aggregate, { app: { x: 1 } });
  await t.close();
});

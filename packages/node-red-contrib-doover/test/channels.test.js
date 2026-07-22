"use strict";

const assert = require("node:assert/strict");
const { describe, it, before, after, afterEach } = require("node:test");

const helper = require("node-red-node-test-helper");
const { MockTransport } = require("@doover/nodered-core");

const connectionNode = require("../nodes/doover-connection.js");
const channelNodes = require("../nodes/channels.js");

helper.init(require.resolve("node-red"));

function startServer() {
  return new Promise((resolve) => helper.startServer(resolve));
}
function stopServer() {
  return new Promise((resolve) => helper.stopServer(resolve));
}
function load(mods, flow, creds) {
  return new Promise((resolve) => helper.load(mods, flow, creds || {}, resolve));
}
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Wire the injected mock into every doover-connection loaded in a test.
function useMock(mock) {
  connectionNode.setTransportFactory(() => mock);
}

describe("doover channel nodes", function () {
  before(startServer);
  after(stopServer);

  afterEach(async function () {
    connectionNode.clearTransportFactory();
    try {
      await helper.unload();
    } catch (_err) {
      /* ignore */
    }
  });

  // ---- doover-channel-out ------------------------------------------------
  it("channel out publishes msg.payload to the channel (merges aggregate)", async function () {
    const mock = new MockTransport({ autoConnect: true });
    useMock(mock);

    const flow = [
      { id: "conn", type: "doover-connection", dooverType: "local" },
      {
        id: "out",
        type: "doover-channel-out",
        connection: "conn",
        channel: "readings",
      },
    ];
    await load([connectionNode, channelNodes], flow);

    const out = helper.getNode("out");
    out.receive({ payload: { temp: 21 } });
    await delay(10);

    const agg = await mock.getAggregate("readings");
    assert.deepEqual(agg, { temp: 21 }, "payload merged into channel aggregate");
  });

  it("channel out one-shot delivers without merging the aggregate", async function () {
    const mock = new MockTransport({ autoConnect: true });
    useMock(mock);

    let delivered = null;
    mock.subscribe("live", (m) => {
      delivered = m.payload;
    });

    const flow = [
      { id: "conn", type: "doover-connection", dooverType: "local" },
      {
        id: "out",
        type: "doover-channel-out",
        connection: "conn",
        channel: "live",
        oneShot: true,
      },
    ];
    await load([connectionNode, channelNodes], flow);

    helper.getNode("out").receive({ payload: 42 });
    await delay(10);

    assert.equal(delivered, 42, "subscriber received the one-shot payload");
    assert.equal(
      await mock.getAggregate("live"),
      null,
      "one-shot did not merge into the aggregate"
    );
  });

  it("channel out passes recordLog and maxAge through to publish", async function () {
    const mock = new MockTransport({ autoConnect: true });
    const calls = [];
    const origPublish = mock.publish.bind(mock);
    mock.publish = function (channel, payload, opts) {
      calls.push({ channel, payload, opts });
      return origPublish(channel, payload, opts);
    };
    useMock(mock);

    const flow = [
      { id: "conn", type: "doover-connection", dooverType: "local" },
      {
        id: "out",
        type: "doover-channel-out",
        connection: "conn",
        channel: "logged",
        recordLog: true,
        maxAge: "3600",
      },
    ];
    await load([connectionNode, channelNodes], flow);

    helper.getNode("out").receive({ payload: 1 });
    await delay(10);

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].opts, { recordLog: true, maxAge: 3600 });
  });

  it("channel out falls back to msg.topic when no channel is configured", async function () {
    const mock = new MockTransport({ autoConnect: true });
    useMock(mock);

    const flow = [
      { id: "conn", type: "doover-connection", dooverType: "local" },
      { id: "out", type: "doover-channel-out", connection: "conn", channel: "" },
    ];
    await load([connectionNode, channelNodes], flow);

    helper.getNode("out").receive({ topic: "dynamic", payload: { v: 5 } });
    await delay(10);

    assert.deepEqual(await mock.getAggregate("dynamic"), { v: 5 });
  });

  it("channel out does not flash status after close (in-flight publish)", async function () {
    // Regression: a publish resolving AFTER close() used to run flashSent() on the
    // torn-down node, scheduling a non-unref'd 500ms timer that was never cleared
    // and fired node.status() on a dead node.
    const mock = new MockTransport({ autoConnect: true });
    let resolvePublish;
    mock.publish = () =>
      new Promise((resolve) => {
        resolvePublish = resolve;
      });
    useMock(mock);

    const flow = [
      { id: "conn", type: "doover-connection", dooverType: "local" },
      { id: "out", type: "doover-channel-out", connection: "conn", channel: "c" },
    ];
    await load([connectionNode, channelNodes], flow);

    const out = helper.getNode("out");
    out.receive({ payload: 1 });
    await delay(5); // input handler is now suspended awaiting publish

    await helper.unload(); // close: sets closed=true, clears any flash timer
    resolvePublish(); // in-flight publish resolves on the torn-down node
    await delay(20);

    assert.equal(
      out._flashTimer == null,
      true,
      "no lingering flash timer scheduled after close"
    );
  });

  // ---- doover-channel-in -------------------------------------------------
  it("channel in emits a message per channel message", async function () {
    const mock = new MockTransport({ autoConnect: true });
    useMock(mock);

    const flow = [
      { id: "conn", type: "doover-connection", dooverType: "local" },
      {
        id: "in",
        type: "doover-channel-in",
        connection: "conn",
        channel: "events",
        wires: [["sink"]],
      },
      { id: "sink", type: "helper" },
    ];
    await load([connectionNode, channelNodes], flow);

    const sink = helper.getNode("sink");
    const got = new Promise((resolve) => sink.on("input", resolve));

    // Publishing on the mock delivers to the node's subscription.
    await mock.publish("events", { hello: "world" });

    const msg = await got;
    assert.deepEqual(msg.payload, { hello: "world" });
    assert.equal(msg.topic, "events");
    assert.ok(msg.doover, "doover metadata present");
    assert.equal(msg.doover.channel, "events");
    assert.equal(msg.doover.agentId, "mock-agent");
  });

  it("channel in emits the aggregate on connect when enabled", async function () {
    const mock = new MockTransport({
      autoConnect: true,
      aggregates: { state: { level: 7 } },
    });
    useMock(mock);

    const flow = [
      { id: "conn", type: "doover-connection", dooverType: "local" },
      {
        id: "in",
        type: "doover-channel-in",
        connection: "conn",
        channel: "state",
        emitAggregateOnConnect: true,
        wires: [["sink"]],
      },
      { id: "sink", type: "helper" },
    ];

    const sink = new Promise((resolve) => {
      helper
        .load([connectionNode, channelNodes], flow, {}, function () {
          helper.getNode("sink").on("input", resolve);
        })
        .catch(() => {});
    });
    // load() resolves via the callback above; give the deferred emit a tick.
    const msg = await sink;
    assert.deepEqual(msg.payload, { level: 7 });
    assert.equal(msg.topic, "state");
    assert.equal(msg.doover.aggregate, true);
  });

  it("channel in does not emit an aggregate when the option is off", async function () {
    const mock = new MockTransport({
      autoConnect: true,
      aggregates: { state: { level: 7 } },
    });
    useMock(mock);

    const flow = [
      { id: "conn", type: "doover-connection", dooverType: "local" },
      {
        id: "in",
        type: "doover-channel-in",
        connection: "conn",
        channel: "state",
        emitAggregateOnConnect: false,
        wires: [["sink"]],
      },
      { id: "sink", type: "helper" },
    ];
    await load([connectionNode, channelNodes], flow);

    let count = 0;
    helper.getNode("sink").on("input", () => {
      count += 1;
    });
    await delay(20);
    assert.equal(count, 0, "no aggregate emitted on connect");
  });

  // ---- doover-aggregate-get ---------------------------------------------
  it("aggregate get fetches into msg.payload by default", async function () {
    const mock = new MockTransport({
      autoConnect: true,
      aggregates: { sensors: { a: 1, b: 2 } },
    });
    useMock(mock);

    const flow = [
      { id: "conn", type: "doover-connection", dooverType: "local" },
      {
        id: "get",
        type: "doover-aggregate-get",
        connection: "conn",
        channel: "sensors",
        property: "payload",
        wires: [["sink"]],
      },
      { id: "sink", type: "helper" },
    ];
    await load([connectionNode, channelNodes], flow);

    const sink = helper.getNode("sink");
    const got = new Promise((resolve) => sink.on("input", resolve));
    helper.getNode("get").receive({ payload: "ignored" });

    const msg = await got;
    assert.deepEqual(msg.payload, { a: 1, b: 2 });
  });

  it("aggregate get writes to a custom property and uses msg.topic as channel", async function () {
    const mock = new MockTransport({
      autoConnect: true,
      aggregates: { sensors: { a: 1 } },
    });
    useMock(mock);

    const flow = [
      { id: "conn", type: "doover-connection", dooverType: "local" },
      {
        id: "get",
        type: "doover-aggregate-get",
        connection: "conn",
        channel: "",
        property: "data.snapshot",
        wires: [["sink"]],
      },
      { id: "sink", type: "helper" },
    ];
    await load([connectionNode, channelNodes], flow);

    const sink = helper.getNode("sink");
    const got = new Promise((resolve) => sink.on("input", resolve));
    helper.getNode("get").receive({ topic: "sensors", payload: "keep" });

    const msg = await got;
    assert.equal(msg.payload, "keep", "original payload untouched");
    assert.deepEqual(msg.data.snapshot, { a: 1 }, "aggregate set on custom path");
  });
});

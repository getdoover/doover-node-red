"use strict";

const assert = require("node:assert");
const { describe, it, before, after, afterEach } = require("node:test");

const helper = require("node-red-node-test-helper");
const { MockTransport } = require("@doover/nodered-core");

const notifyNode = require("../nodes/notify.js");

helper.init(require.resolve("node-red"));

// --- test doubles -----------------------------------------------------------

/** MockTransport that records every publish call (channel, payload, opts). */
class RecordingTransport extends MockTransport {
  constructor(opts) {
    super(opts);
    /** @type {Array<{channel:string,payload:any,opts:any}>} */
    this.publishes = [];
  }
  async publish(channel, payload, opts) {
    this.publishes.push({ channel, payload, opts });
    return super.publish(channel, payload, opts);
  }
}

function fakeConnection(RED) {
  function FakeConnectionNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node._transport = new RecordingTransport({
      appKey: "cu_myapp_1234",
      agentId: "agent-1",
      autoConnect: true,
    });
    node._refcount = 0;
    node.getTransport = () => node._transport;
    node.acquire = () => {
      node._refcount += 1;
      return node._transport;
    };
    node.release = () => {
      node._refcount -= 1;
    };
    node.on("close", (done) => done());
  }
  RED.nodes.registerType("doover-connection", FakeConnectionNode);
}

function load(flow) {
  return new Promise((resolve) => {
    helper.load([notifyNode, fakeConnection], flow, resolve);
  });
}
const CONN = { id: "c1", type: "doover-connection", name: "local" };

// --- tests ------------------------------------------------------------------

describe("doover notify node", () => {
  before((_t, done) => {
    helper.startServer(done);
  });
  after((_t, done) => {
    helper.stopServer(done);
  });
  afterEach(async () => {
    await helper.unload();
  });

  it("is loaded", async () => {
    await load([{ id: "n1", type: "doover-notify", connection: "c1" }, CONN]);
    assert.equal(helper.getNode("n1").type, "doover-notify");
  });

  it("publishes payload text to significantEvent as { notification_msg }", async () => {
    await load([
      { id: "n1", type: "doover-notify", connection: "c1", wires: [["n2"]] },
      { id: "n2", type: "helper" },
      CONN,
    ]);
    const transport = helper.getNode("c1").getTransport();
    const n2 = helper.getNode("n2");
    const got = new Promise((res) => n2.once("input", res));
    helper.getNode("n1").receive({ payload: "High temperature detected!" });
    await got; // pass-through

    const sig = transport.publishes.find((p) => p.channel === "significantEvent");
    assert.ok(sig, "published to significantEvent");
    assert.deepEqual(sig.payload, {
      notification_msg: "High temperature detected!",
    });
    assert.equal(sig.opts.recordLog, true);
    assert.equal(sig.opts.maxAge, 1);
    // No activity log entry unless the option is enabled.
    assert.ok(!transport.publishes.some((p) => p.channel === "activity_log"));
  });

  it("stringifies non-string payloads", async () => {
    await load([{ id: "n1", type: "doover-notify", connection: "c1" }, CONN]);
    const transport = helper.getNode("c1").getTransport();
    helper.getNode("n1").receive({ payload: { code: 5 } });
    await new Promise((r) => setTimeout(r, 20));
    const sig = transport.publishes.find((p) => p.channel === "significantEvent");
    assert.deepEqual(sig.payload, { notification_msg: '{"code":5}' });
  });

  it("also records an activity_log entry when enabled", async () => {
    await load([
      {
        id: "n1",
        type: "doover-notify",
        connection: "c1",
        recordActivity: true,
      },
      CONN,
    ]);
    const transport = helper.getNode("c1").getTransport();
    helper.getNode("n1").receive({ payload: "Pump started" });
    await new Promise((r) => setTimeout(r, 20));

    const act = transport.publishes.find((p) => p.channel === "activity_log");
    assert.ok(act, "published to activity_log");
    assert.deepEqual(act.payload, { action_string: "Pump started" });
    assert.equal(act.opts.recordLog, true);
  });

  it("passes the message through", async () => {
    await load([
      { id: "n1", type: "doover-notify", connection: "c1", wires: [["n2"]] },
      { id: "n2", type: "helper" },
      CONN,
    ]);
    const n2 = helper.getNode("n2");
    const got = new Promise((res) => n2.once("input", res));
    helper.getNode("n1").receive({ payload: "hello", extra: 42 });
    const msg = await got;
    assert.equal(msg.payload, "hello");
    assert.equal(msg.extra, 42);
  });
});

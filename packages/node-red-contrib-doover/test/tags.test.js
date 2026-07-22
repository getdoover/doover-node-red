"use strict";

const assert = require("node:assert");
const { describe, it, before, after, afterEach } = require("node:test");

const helper = require("node-red-node-test-helper");
const { MockTransport } = require("@doover/nodered-core");

const tagsNode = require("../nodes/tags.js");

helper.init(require.resolve("node-red"));

// --- test doubles -----------------------------------------------------------

// Mutable seed the fake tag client copies at construction, so a tag can exist
// before a tag-in node subscribes (emit-on-connect scenarios).
let sharedSeed = {};

/**
 * In-memory stand-in for @doover/nodered-core's TagClient. Faithfully models the
 * documented API (getTag / setTag / setTags / subscribeTag) with scope options,
 * nested dot-paths, and change-only subscription firing. Records writes and
 * subscriptions so tests can assert the nodes' option plumbing.
 */
class FakeTagClient {
  constructor() {
    this.store = structuredClone(sharedSeed);
    /** @type {Array<{ns:string,key:string,cb:Function,opts:object}>} */
    this.subs = [];
    /** @type {Array<object>} */
    this.writes = [];
  }
  _ns(opts) {
    if (opts && opts.global) return "__global__";
    if (opts && opts.appKey) return opts.appKey;
    return "__self__";
  }
  _split(key) {
    return String(key).split(".");
  }
  _get(obj, path) {
    let c = obj;
    for (const p of path) {
      if (c == null || typeof c !== "object") return undefined;
      c = c[p];
    }
    return c;
  }
  _set(obj, path, val) {
    let c = obj;
    for (let i = 0; i < path.length - 1; i++) {
      if (typeof c[path[i]] !== "object" || c[path[i]] == null) c[path[i]] = {};
      c = c[path[i]];
    }
    c[path[path.length - 1]] = val;
  }
  async getTag(key, opts) {
    const ns = this._ns(opts);
    return this._get(this.store[ns] || {}, this._split(key));
  }
  async setTag(key, value, opts) {
    this.writes.push({ type: "set", key, value, opts: opts || {} });
    const ns = this._ns(opts);
    if (!this.store[ns]) this.store[ns] = {};
    const path = this._split(key);
    const prev = this._get(this.store[ns], path);
    this._set(this.store[ns], path, value);
    if (JSON.stringify(prev) !== JSON.stringify(value)) {
      this._fire(ns, key, value, prev);
    }
  }
  async setTags(obj, opts) {
    this.writes.push({ type: "setTags", obj, opts: opts || {} });
    const ns = this._ns(opts);
    if (!this.store[ns]) this.store[ns] = {};
    for (const [k, v] of Object.entries(obj)) {
      const path = this._split(k);
      const prev = this._get(this.store[ns], path);
      this._set(this.store[ns], path, v);
      if (JSON.stringify(prev) !== JSON.stringify(v)) this._fire(ns, k, v, prev);
    }
  }
  subscribeTag(key, cb, opts) {
    const ns = this._ns(opts);
    const entry = { ns, key, cb, opts: opts || {} };
    this.subs.push(entry);
    if (opts && opts.emitInitial) {
      cb(this._get(this.store[ns] || {}, this._split(key)), undefined);
    }
    return () => {
      const i = this.subs.indexOf(entry);
      if (i >= 0) this.subs.splice(i, 1);
    };
  }
  _fire(ns, key, value, prev) {
    for (const s of [...this.subs]) {
      if (s.ns === ns && s.key === key) s.cb(value, prev);
    }
  }
  // test-only: force a delivery even when the value is unchanged.
  emitRaw(key, value, prev, opts) {
    this._fire(this._ns(opts), key, value, prev);
  }
}

/** Fake `doover-connection` config node exposing the documented accessors. */
function fakeConnection(RED) {
  function FakeConnectionNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node._transport = new MockTransport({
      appKey: "cu_myapp_1234",
      agentId: "agent-1",
      autoConnect: true,
    });
    node._tagClient = new FakeTagClient();
    node._refcount = 0;
    node.getTransport = () => node._transport;
    node.getTagClient = () => node._tagClient;
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

// --- helpers ----------------------------------------------------------------

function load(flow) {
  return new Promise((resolve) => {
    helper.load([tagsNode, fakeConnection], flow, resolve);
  });
}
function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
const CONN = { id: "c1", type: "doover-connection", name: "local" };

// --- tests ------------------------------------------------------------------

describe("doover tag nodes", () => {
  before((_t, done) => {
    helper.startServer(done);
  });
  after((_t, done) => {
    helper.stopServer(done);
  });
  afterEach(async () => {
    sharedSeed = {};
    await helper.unload();
  });

  it("loads all three tag types", async () => {
    await load([
      { id: "n1", type: "doover-tag-in", connection: "c1", tag: "a" },
      { id: "n2", type: "doover-tag-get", connection: "c1", tag: "a" },
      { id: "n3", type: "doover-tag-out", connection: "c1", tag: "a" },
      CONN,
    ]);
    assert.equal(helper.getNode("n1").type, "doover-tag-in");
    assert.equal(helper.getNode("n2").type, "doover-tag-get");
    assert.equal(helper.getNode("n3").type, "doover-tag-out");
  });

  describe("doover-tag-in", () => {
    it("emits payload, topic and doover metadata on change", async () => {
      await load([
        {
          id: "n1",
          type: "doover-tag-in",
          connection: "c1",
          scope: "thisApp",
          tag: "battery.voltage",
          wires: [["n2"]],
        },
        { id: "n2", type: "helper" },
        CONN,
      ]);
      const c1 = helper.getNode("c1");
      const n2 = helper.getNode("n2");
      const got = new Promise((res) => n2.once("input", res));
      await c1.getTagClient().setTag("battery.voltage", 12.4, {});
      const msg = await got;
      assert.equal(msg.payload, 12.4);
      assert.equal(msg.topic, "cu_myapp_1234/battery.voltage");
      assert.deepEqual(msg.doover, {
        agentId: "agent-1",
        appKey: "cu_myapp_1234",
        tag: "battery.voltage",
        previous: undefined,
      });
    });

    it("uses the other-app namespace for scope=otherApp", async () => {
      await load([
        {
          id: "n1",
          type: "doover-tag-in",
          connection: "c1",
          scope: "otherApp",
          appKey: "cu_other_5678",
          tag: "pump_speed",
          wires: [["n2"]],
        },
        { id: "n2", type: "helper" },
        CONN,
      ]);
      const c1 = helper.getNode("c1");
      const n2 = helper.getNode("n2");
      const sub = c1.getTagClient().subs[0];
      assert.equal(sub.opts.appKey, "cu_other_5678");
      const got = new Promise((res) => n2.once("input", res));
      await c1.getTagClient().setTag("pump_speed", 1450, { appKey: "cu_other_5678" });
      const msg = await got;
      assert.equal(msg.topic, "cu_other_5678/pump_speed");
      assert.equal(msg.doover.appKey, "cu_other_5678");
    });

    it("passes emitInitial through to the tag layer when checked", async () => {
      sharedSeed = { __self__: { level: 7 } };
      await load([
        {
          id: "n1",
          type: "doover-tag-in",
          connection: "c1",
          tag: "level",
          emitInitial: true,
        },
        CONN,
      ]);
      const sub = helper.getNode("c1").getTagClient().subs[0];
      assert.equal(sub.opts.emitInitial, true);
    });

    it("suppresses an unchanged value when onlyOnChange is on", async () => {
      await load([
        {
          id: "n1",
          type: "doover-tag-in",
          connection: "c1",
          tag: "state",
          onlyOnChange: true,
          wires: [["n2"]],
        },
        { id: "n2", type: "helper" },
        CONN,
      ]);
      const client = helper.getNode("c1").getTagClient();
      const n2 = helper.getNode("n2");
      let count = 0;
      n2.on("input", () => {
        count += 1;
      });
      client.emitRaw("state", "running", undefined, {});
      client.emitRaw("state", "running", "running", {});
      await delay(20);
      assert.equal(count, 1);
    });

    it("forwards every delivery when onlyOnChange is off", async () => {
      await load([
        {
          id: "n1",
          type: "doover-tag-in",
          connection: "c1",
          tag: "state",
          onlyOnChange: false,
          wires: [["n2"]],
        },
        { id: "n2", type: "helper" },
        CONN,
      ]);
      const client = helper.getNode("c1").getTagClient();
      const n2 = helper.getNode("n2");
      let count = 0;
      n2.on("input", () => {
        count += 1;
      });
      client.emitRaw("state", "running", undefined, {});
      client.emitRaw("state", "running", "running", {});
      await delay(20);
      assert.equal(count, 2);
    });
  });

  describe("doover-tag-get", () => {
    it("reads a tag into msg.payload by default", async () => {
      await load([
        {
          id: "n1",
          type: "doover-tag-get",
          connection: "c1",
          tag: "battery.voltage",
          property: "payload",
          wires: [["n2"]],
        },
        { id: "n2", type: "helper" },
        CONN,
      ]);
      const c1 = helper.getNode("c1");
      await c1.getTagClient().setTag("battery.voltage", 3.3, {});
      const n1 = helper.getNode("n1");
      const n2 = helper.getNode("n2");
      const got = new Promise((res) => n2.once("input", res));
      n1.receive({ payload: "trigger" });
      const msg = await got;
      assert.equal(msg.payload, 3.3);
    });

    it("takes the tag name from msg.topic when no tag is configured", async () => {
      await load([
        {
          id: "n1",
          type: "doover-tag-get",
          connection: "c1",
          tag: "",
          property: "payload",
          wires: [["n2"]],
        },
        { id: "n2", type: "helper" },
        CONN,
      ]);
      const c1 = helper.getNode("c1");
      await c1.getTagClient().setTag("battery.voltage", 7, {});
      const n2 = helper.getNode("n2");
      const got = new Promise((res) => n2.once("input", res));
      helper.getNode("n1").receive({ topic: "battery.voltage" });
      const msg = await got;
      assert.equal(msg.payload, 7);
    });

    it("uses the configured default value when the tag is unset", async () => {
      await load([
        {
          id: "n1",
          type: "doover-tag-get",
          connection: "c1",
          tag: "missing",
          property: "payload",
          defaultValue: "42",
          defaultValueType: "num",
          wires: [["n2"]],
        },
        { id: "n2", type: "helper" },
        CONN,
      ]);
      const n2 = helper.getNode("n2");
      const got = new Promise((res) => n2.once("input", res));
      helper.getNode("n1").receive({ payload: "trigger" });
      const msg = await got;
      assert.equal(msg.payload, 42);
    });

    it("does not clobber an existing target property when nonClobber is set", async () => {
      await load([
        {
          id: "n1",
          type: "doover-tag-get",
          connection: "c1",
          tag: "missing",
          property: "payload",
          nonClobber: true,
          wires: [["n2"]],
        },
        { id: "n2", type: "helper" },
        CONN,
      ]);
      const n2 = helper.getNode("n2");
      const got = new Promise((res) => n2.once("input", res));
      helper.getNode("n1").receive({ payload: "keep-me" });
      const msg = await got;
      assert.equal(msg.payload, "keep-me");
    });
  });

  describe("doover-tag-out", () => {
    it("writes msg.payload via setTag with the log flag", async () => {
      await load([
        {
          id: "n1",
          type: "doover-tag-out",
          connection: "c1",
          tag: "battery.voltage",
          log: true,
          wires: [["n2"]],
        },
        { id: "n2", type: "helper" },
        CONN,
      ]);
      const c1 = helper.getNode("c1");
      const n2 = helper.getNode("n2");
      const got = new Promise((res) => n2.once("input", res));
      helper.getNode("n1").receive({ payload: 12.9 });
      await got; // pass-through
      const writes = c1.getTagClient().writes;
      assert.equal(writes.length, 1);
      assert.equal(writes[0].type, "set");
      assert.equal(writes[0].key, "battery.voltage");
      assert.equal(writes[0].value, 12.9);
      assert.equal(writes[0].opts.log, true, "log flag maps to TagClient opts.log");
    });

    it("writes an object payload atomically via setTags in batch mode", async () => {
      await load([
        {
          id: "n1",
          type: "doover-tag-out",
          connection: "c1",
          batch: true,
          log: true,
          wires: [["n2"]],
        },
        { id: "n2", type: "helper" },
        CONN,
      ]);
      const c1 = helper.getNode("c1");
      const n2 = helper.getNode("n2");
      const got = new Promise((res) => n2.once("input", res));
      helper.getNode("n1").receive({ payload: { a: 1, b: 2 } });
      await got;
      const writes = c1.getTagClient().writes;
      assert.equal(writes.length, 1);
      assert.equal(writes[0].type, "setTags");
      assert.deepEqual(writes[0].obj, { a: 1, b: 2 });
      assert.equal(writes[0].opts.log, true, "batch log flag maps to opts.log");
    });

    it("marks live writes and rate-limits rapid ones", async () => {
      await load([
        {
          id: "n1",
          type: "doover-tag-out",
          connection: "c1",
          tag: "flow",
          live: true,
          rateLimit: 1000,
        },
        CONN,
      ]);
      const client = helper.getNode("c1").getTagClient();
      const n1 = helper.getNode("n1");
      n1.receive({ payload: 1 });
      n1.receive({ payload: 2 }); // within the rate window -> dropped
      await delay(20);
      const liveWrites = client.writes.filter((w) => w.opts && w.opts.live);
      assert.equal(liveWrites.length, 1);
      assert.equal(liveWrites[0].value, 1);
    });
  });
});

"use strict";

const assert = require("node:assert/strict");
const { describe, it, before, after, beforeEach, afterEach } = require("node:test");

const helper = require("node-red-node-test-helper");
const { MockTransport, TagClient } = require("@doover/nodered-core");

const connectionNode = require("../nodes/doover-connection.js");
const channelNodes = require("../nodes/channels.js");
const tagsNode = require("../nodes/tags.js");
const notifyNode = require("../nodes/notify.js");

helper.init(require.resolve("node-red"));

// Promise wrappers around the callback-style helper API.
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

describe("doover-connection config node", function () {
  before(startServer);
  after(stopServer);

  afterEach(async function () {
    connectionNode.clearTransportFactory();
    try {
      await helper.unload();
    } catch (_err) {
      /* already unloaded by the test */
    }
  });

  it("registers and exposes getTransport()/getTagClient()", async function () {
    const mock = new MockTransport({ agentId: "agent-x", appKey: "app-x" });
    connectionNode.setTransportFactory(() => mock);

    const flow = [
      { id: "c1", type: "doover-connection", dooverType: "local", name: "Local" },
    ];
    await load(connectionNode, flow);

    const c1 = helper.getNode("c1");
    assert.ok(c1, "config node instance exists");
    assert.equal(typeof c1.getTransport, "function");
    assert.equal(typeof c1.getTagClient, "function");

    const transport = c1.getTransport();
    assert.equal(transport, mock, "returns the injected mock transport");
    // Repeated calls return the same shared instance.
    assert.equal(c1.getTransport(), transport, "transport is shared/created once");

    const tagClient = c1.getTagClient();
    assert.ok(tagClient instanceof TagClient, "getTagClient returns a TagClient");
    assert.equal(c1.getTagClient(), tagClient, "tag client is shared");
  });

  it("passes empty opts for a zero-config local connection", async function () {
    let seen = null;
    connectionNode.setTransportFactory((mode, opts) => {
      seen = { mode, opts };
      return new MockTransport({ autoConnect: true });
    });

    const flow = [{ id: "c1", type: "doover-connection", dooverType: "local" }];
    await load(connectionNode, flow);

    helper.getNode("c1").getTransport();
    assert.equal(seen.mode, "local");
    assert.deepEqual(seen.opts, {}, "no override → zero-config opts");
  });

  it("passes the advanced base-URL override to the local transport factory", async function () {
    let seen = null;
    connectionNode.setTransportFactory((mode, opts) => {
      seen = { mode, opts };
      return new MockTransport({ autoConnect: true });
    });

    const flow = [
      {
        id: "c1",
        type: "doover-connection",
        dooverType: "local",
        localBaseUrl: "https://192.168.0.7:49100",
      },
    ];
    await load(connectionNode, flow);

    helper.getNode("c1").getTransport();
    assert.equal(seen.mode, "local");
    assert.equal(
      seen.opts.baseUrl,
      "https://192.168.0.7:49100",
      "LAN base-URL override forwarded to the transport"
    );
  });

  it("passes cloud config + token credential through to the transport factory", async function () {
    let seen = null;
    connectionNode.setTransportFactory((mode, opts) => {
      seen = { mode, opts };
      return new MockTransport({ autoConnect: true, agentId: "agent-cloud" });
    });

    const flow = [
      {
        id: "c1",
        type: "doover-connection",
        dooverType: "cloud",
        apiBase: "https://api.example.com",
        agentId: "agent-cloud",
      },
    ];
    const creds = { c1: { token: "secret-token" } };
    await load(connectionNode, flow, creds);

    const c1 = helper.getNode("c1");
    const transport = c1.getTransport();
    assert.equal(transport.agentId(), "agent-cloud", "returns the mock transport");
    assert.equal(seen.mode, "cloud");
    assert.equal(seen.opts.apiBase, "https://api.example.com");
    assert.equal(seen.opts.agentId, "agent-cloud");
    assert.equal(
      seen.opts.token,
      "secret-token",
      "token comes from credentials, not plain config"
    );
  });

  it("defaults the cloud API base to production when unset", async function () {
    let seen = null;
    connectionNode.setTransportFactory((mode, opts) => {
      seen = { mode, opts };
      return new MockTransport({ autoConnect: true });
    });

    const flow = [
      {
        id: "c1",
        type: "doover-connection",
        dooverType: "cloud",
        agentId: "agent-y",
      },
    ];
    await load(connectionNode, flow);

    helper.getNode("c1").getTransport();
    assert.equal(seen.opts.apiBase, "https://api.doover.com");
    assert.equal(seen.opts.token, "", "no credential → empty token");
  });

  it("kicks off connect() when the transport is first used", async function () {
    const mock = new MockTransport({ autoConnect: false });
    connectionNode.setTransportFactory(() => mock);

    const flow = [{ id: "c1", type: "doover-connection", dooverType: "local" }];
    await load(connectionNode, flow);

    const c1 = helper.getNode("c1");
    assert.equal(mock.status(), "disconnected", "not connected before use");
    c1.getTransport();
    await delay(10);
    assert.equal(mock.status(), "connected", "connect() ran after first use");
  });

  it("refcounts and closes the transport on last release", async function () {
    const mock = new MockTransport({ autoConnect: true });
    connectionNode.setTransportFactory(() => mock);

    const flow = [{ id: "c1", type: "doover-connection", dooverType: "local" }];
    await load(connectionNode, flow);

    const c1 = helper.getNode("c1");
    c1.acquire();
    c1.acquire();
    await delay(5);
    assert.equal(mock.status(), "connected", "connected while referenced");

    c1.release();
    await delay(5);
    assert.equal(mock.status(), "connected", "still open with one holder left");

    c1.release();
    await delay(5);
    assert.equal(mock.status(), "disconnected", "closed on last release");
  });

  it("recreates the transport after it was released to zero", async function () {
    let created = 0;
    connectionNode.setTransportFactory(() => {
      created += 1;
      return new MockTransport({ autoConnect: true });
    });

    const flow = [{ id: "c1", type: "doover-connection", dooverType: "local" }];
    await load(connectionNode, flow);

    const c1 = helper.getNode("c1");
    c1.acquire();
    c1.release();
    await delay(5);
    assert.equal(created, 1, "one transport built for the first consumer");

    c1.acquire();
    await delay(5);
    assert.equal(created, 2, "a fresh transport is lazily built after teardown");
    c1.release();
  });

  it("tag and notify nodes participate in the refcount (all consumers counted)", async function () {
    // Regression: tag/notify nodes used getTransport() without acquire()/release(),
    // so they were invisible to the refcount and a channel node's release() could
    // close the shared transport out from under them.
    const mock = new MockTransport({ autoConnect: true, appKey: "app" });
    connectionNode.setTransportFactory(() => mock);

    const flow = [
      { id: "c1", type: "doover-connection", dooverType: "local" },
      {
        id: "ti",
        type: "doover-tag-in",
        connection: "c1",
        scope: "thisApp",
        tag: "x",
      },
      {
        id: "tg",
        type: "doover-tag-get",
        connection: "c1",
        scope: "thisApp",
        tag: "x",
      },
      {
        id: "to",
        type: "doover-tag-out",
        connection: "c1",
        scope: "thisApp",
        tag: "x",
      },
      { id: "nf", type: "doover-notify", connection: "c1" },
    ];
    await load([connectionNode, channelNodes, tagsNode, notifyNode], flow);
    await delay(10);

    const c1 = helper.getNode("c1");
    assert.equal(c1._refcount, 4, "tag-in, tag-get, tag-out and notify each hold a ref");
  });

  it("a channel node release does not close the transport while a tag node holds it", async function () {
    const mock = new MockTransport({ autoConnect: true, appKey: "app" });
    connectionNode.setTransportFactory(() => mock);

    const flow = [
      { id: "c1", type: "doover-connection", dooverType: "local" },
      { id: "ci", type: "doover-channel-in", connection: "c1", channel: "ev" },
      {
        id: "ti",
        type: "doover-tag-in",
        connection: "c1",
        scope: "thisApp",
        tag: "x",
      },
    ];
    await load([connectionNode, channelNodes, tagsNode], flow);
    await delay(10);

    const c1 = helper.getNode("c1");
    assert.equal(c1._refcount, 2, "channel-in and tag-in each hold a reference");

    // Mimic the channel node being removed in a "modified nodes" partial deploy.
    c1.release();
    await delay(10);
    assert.equal(
      mock.status(),
      "connected",
      "tag-in still holds the transport open"
    );

    c1.release();
    await delay(10);
    assert.equal(mock.status(), "disconnected", "closed once the last ref releases");
  });

  it("acquire() does not leak a ref when transport construction throws", async function () {
    // Regression: acquire() used to bump _refcount BEFORE _ensureTransport(),
    // so a throwing factory (cloud transport unavailable, etc.) left the ref stuck
    // on the surviving config node — its last-release teardown could never fire.
    connectionNode.setTransportFactory(() => {
      throw new Error("cloud transport unavailable");
    });

    const flow = [
      { id: "c1", type: "doover-connection", dooverType: "cloud", agentId: "a" },
    ];
    await load(connectionNode, flow);

    const c1 = helper.getNode("c1");
    assert.throws(() => c1.acquire(), /cloud transport unavailable/);
    assert.equal(c1._refcount, 0, "refcount not bumped on a failed acquire");
    // A repeated failed acquire must not accumulate either.
    assert.throws(() => c1.acquire());
    assert.equal(c1._refcount, 0, "refcount still zero after repeated failures");
  });

  it("closes the transport when the config node itself closes", async function () {
    const mock = new MockTransport({ autoConnect: true });
    connectionNode.setTransportFactory(() => mock);

    const flow = [{ id: "c1", type: "doover-connection", dooverType: "local" }];
    await load(connectionNode, flow);

    const c1 = helper.getNode("c1");
    c1.getTransport();
    await delay(5);
    assert.equal(mock.status(), "connected");

    await helper.unload(); // triggers node close
    await delay(5);
    assert.equal(mock.status(), "disconnected", "closed on node close");
  });
});

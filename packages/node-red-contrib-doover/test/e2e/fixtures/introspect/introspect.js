"use strict";

/*
 * e2e-introspect — a harness-only node that surfaces Doover transport internals
 * to the e2e runner over the Node-RED admin API. It is NEVER part of the
 * shipping palette; it lives under test/e2e/fixtures and is loaded into the
 * live runtime purely so the runner can assert on things the public API hides:
 * per-connection status-listener counts, refcounts, channel-subscription counts
 * and the doover-js gateway subscription count (the "expose a counter via the
 * harness" requirement of the redeploy-stress scenario).
 *
 * It also proxies read-only global context so a flow can capture a value the
 * runner reads back.
 */

/** @param {import("node-red").NodeAPI} RED */
module.exports = function (RED) {
  // A no-op node type so Node-RED treats this dir as a loadable module. It is
  // never placed on a flow.
  function E2eIntrospectNode(config) {
    RED.nodes.createNode(this, config);
  }
  RED.nodes.registerType("e2e-introspect", E2eIntrospectNode);

  /**
   * Enumerate live `doover-connection` config-node instances.
   * @returns {any[]}
   */
  function eachDooverConnection() {
    /** @type {any[]} */
    const out = [];
    const collect = (n) => {
      if (n && n.type === "doover-connection") {
        const live = RED.nodes.getNode(n.id) || n;
        if (out.indexOf(live) === -1) {
          out.push(live);
        }
      }
    };
    if (typeof RED.nodes.eachConfig === "function") {
      RED.nodes.eachConfig(collect);
    }
    if (typeof RED.nodes.eachNode === "function") {
      RED.nodes.eachNode(collect);
    }
    return out;
  }

  /**
   * Snapshot one connection's transport internals defensively — the transport
   * may not be built yet, or may be a different implementation.
   * @param {any} conn
   */
  function snapshotConnection(conn) {
    /** @type {any} */
    const snap = {
      id: conn.id,
      name: conn.name || "",
      dooverType: conn.dooverType || null,
      refcount: typeof conn._refcount === "number" ? conn._refcount : null,
      hasTransport: !!conn._transport,
      status: null,
      agentId: null,
      appKey: null,
      statusListeners: null,
      channelCount: null,
      channelCallbacks: null,
      gatewaySubs: null,
    };
    const t = conn._transport;
    if (!t) {
      return snap;
    }
    try {
      snap.status = t.status();
    } catch (_e) {
      /* ignore */
    }
    try {
      snap.agentId = t.agentId();
    } catch (_e) {
      /* ignore */
    }
    try {
      snap.appKey = t.appKey();
    } catch (_e) {
      /* ignore */
    }
    try {
      if (typeof t.listenerCount === "function") {
        snap.statusListeners = t.listenerCount("status");
      }
    } catch (_e) {
      /* ignore */
    }
    try {
      if (t._channels && typeof t._channels.size === "number") {
        snap.channelCount = t._channels.size;
        let cbs = 0;
        for (const st of t._channels.values()) {
          if (st && st.callbacks && typeof st.callbacks.size === "number") {
            cbs += st.callbacks.size;
          }
        }
        snap.channelCallbacks = cbs;
      }
    } catch (_e) {
      /* ignore */
    }
    try {
      const gw = t._client && t._client.gateway;
      if (gw && typeof gw.getSubscriptionCount === "function") {
        snap.gatewaySubs = gw.getSubscriptionCount();
      }
    } catch (_e) {
      /* ignore */
    }
    return snap;
  }

  const guard =
    RED.auth && typeof RED.auth.needsPermission === "function"
      ? RED.auth.needsPermission("read")
      : (req, res, next) => next();

  RED.httpAdmin.get("/e2e/introspect", guard, function (_req, res) {
    try {
      const connections = eachDooverConnection().map(snapshotConnection);
      res.json({ connections });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });
};

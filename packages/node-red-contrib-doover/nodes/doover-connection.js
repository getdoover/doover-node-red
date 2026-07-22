"use strict";
/*
 * doover-connection — shared connection config node (doover-js transport era).
 *
 * Every Doover message node references one of these. It owns a single shared
 * DooverTransport, refcounted across the consumer nodes that reference it, and
 * exposes it via getTransport() / getTagClient(). The transport is created
 * lazily on first use and closed when the last consumer releases it (or when the
 * config node itself is closed).
 *
 * The transport core is doover-js (talking to the dda-agent local web API on
 * port 49100, not the parked gRPC socket). Two modes, both active:
 *   - "local" (default) — zero-config. DooverJsLocalTransport connects to the
 *     in-container agent web API (DDA_WEB_URI env, default 127.0.0.1:49100) and
 *     reads APP_KEY from the env. The editor shows the detected agent id / app
 *     key read-only (via the identity admin endpoint below). An optional
 *     advanced "base URL" override enables the LAN scenario: a standalone
 *     Node-RED pointing at a device's web API (https://<device-ip>:49100).
 *   - "cloud" — DooverJsCloudTransport to the Doover cloud. Fields: API base URL
 *     (default https://api.doover.com), target agent id, and an API token stored
 *     via Node-RED credentials (never in plain node config).
 */

const {
  DooverJsLocalTransport,
  DooverJsCloudTransport,
  TagClient,
} = require("@doover/nodered-core");

/**
 * Test-only override for how transports are constructed. When set, it is used
 * instead of {@link defaultTransportFactory} so unit tests can inject a
 * MockTransport. Set via `require(".../doover-connection.js").setTransportFactory(fn)`.
 * @type {null | ((mode: string, opts: object) => import("@doover/nodered-core").DooverTransport)}
 */
let _transportFactory = null;

/**
 * Build the real transport for a connection.
 * @param {string} mode - "local" | "cloud".
 * @param {object} opts - Transport options. For local: `{ baseUrl? }` — omit to
 *   let DooverJsLocalTransport resolve DDA_WEB_URI / its default. For cloud:
 *   `{ apiBase, agentId, token }`.
 * @returns {import("@doover/nodered-core").DooverTransport}
 */
function defaultTransportFactory(mode, opts) {
  if (mode === "cloud") {
    if (!DooverJsCloudTransport) {
      throw new Error(
        "DooverJsCloudTransport is not available from @doover/nodered-core"
      );
    }
    return new DooverJsCloudTransport(opts || {});
  }
  if (!DooverJsLocalTransport) {
    throw new Error(
      "DooverJsLocalTransport is not available from @doover/nodered-core"
    );
  }
  // Local: zero-config unless an advanced base-URL override is supplied. The
  // transport resolves DDA_WEB_URI / its default and reads APP_KEY from env.
  return new DooverJsLocalTransport(opts || {});
}

/** @param {import("node-red").NodeAPI} RED */
module.exports = function (RED) {
  function DooverConnectionNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    // "local" (default) | "cloud". Kept as `dooverType` to avoid clashing with
    // Node-RED's own `type` on the node instance.
    node.dooverType = config.dooverType || "local";
    // Local advanced override: base URL of the agent web API. Empty = zero-config
    // (the transport resolves DDA_WEB_URI / its 127.0.0.1:49100 default). Set to
    // e.g. https://<device-ip>:49100 for the standalone-Node-RED-on-LAN scenario.
    node.localBaseUrl = config.localBaseUrl || "";
    // Cloud fields — API base URL + target agent id. The token lives in
    // credentials (password), never in plain node config.
    node.apiBase = config.apiBase || "https://api.doover.com";
    node.cloudAgentId = config.agentId || "";

    /** @type {import("@doover/nodered-core").DooverTransport | null} */
    node._transport = null;
    /** @type {TagClient | null} */
    node._tagClient = null;
    /** @type {number} Consumers currently holding this connection. */
    node._refcount = 0;
    /** @type {Promise<void> | null} */
    node._connectPromise = null;

    /**
     * Create the shared transport + tag client once, kick off connect(), and
     * return the transport. Idempotent.
     * @returns {import("@doover/nodered-core").DooverTransport}
     */
    node._ensureTransport = function () {
      if (node._transport) {
        return node._transport;
      }
      const factory = _transportFactory || defaultTransportFactory;
      let opts;
      if (node.dooverType === "cloud") {
        opts = {
          apiBase: node.apiBase,
          agentId: node.cloudAgentId,
          token: (node.credentials || {}).token || "",
        };
      } else if (node.localBaseUrl) {
        // Advanced override (LAN scenario) — otherwise stay zero-config ({}).
        opts = { baseUrl: node.localBaseUrl };
      } else {
        opts = {};
      }
      const transport = factory(node.dooverType, opts);
      // Every consumer node attaches its own "status" listener to this single
      // shared transport (see lib/shared.js statusForTransport). A flow with
      // more than ~10 Doover nodes on one connection would otherwise trip Node's
      // default-10 MaxListenersExceededWarning, so lift the cap.
      if (typeof transport.setMaxListeners === "function") {
        transport.setMaxListeners(0);
      }
      node._transport = transport;
      node._tagClient = new TagClient(transport);
      // Fire-and-forget connect: a failed initial connect must not throw during
      // node construction. Node status dots surface the state via "status".
      node._connectPromise = Promise.resolve()
        .then(() => transport.connect())
        .catch((err) => {
          node.warn(
            "Doover connection failed to connect: " +
              (err && err.message ? err.message : String(err))
          );
        });
      return transport;
    };

    /**
     * The shared transport (created + connecting on first call). Safe to call
     * repeatedly; does not affect the refcount.
     * @returns {import("@doover/nodered-core").DooverTransport}
     */
    node.getTransport = function () {
      return node._ensureTransport();
    };

    /**
     * The shared tag client riding on the transport. Does not affect refcount.
     * @returns {TagClient}
     */
    node.getTagClient = function () {
      node._ensureTransport();
      return node._tagClient;
    };

    /**
     * Acquire a reference for a consumer node. Increments the refcount and
     * returns the shared transport. Pair every acquire() with exactly one
     * release() (typically in the consumer's `close` handler).
     * @returns {import("@doover/nodered-core").DooverTransport}
     */
    node.acquire = function () {
      // Build the transport FIRST: _ensureTransport() can throw (cloud transport
      // unavailable, local class missing, ctor rejecting bad config). Incrementing
      // only after success avoids leaking a ref on the surviving config node when
      // the consumer's catch path returns without registering a release.
      const transport = node._ensureTransport();
      node._refcount += 1;
      return transport;
    };

    /**
     * Release a consumer's reference. Closes the shared transport once the last
     * consumer releases it.
     * @returns {void}
     */
    node.release = function () {
      node._refcount -= 1;
      if (node._refcount <= 0) {
        node._refcount = 0;
        node._closeTransport();
      }
    };

    /**
     * Close and drop the shared transport (if any).
     * @returns {Promise<void>}
     */
    node._closeTransport = function () {
      const transport = node._transport;
      node._transport = null;
      node._tagClient = null;
      node._connectPromise = null;
      if (!transport) {
        return Promise.resolve();
      }
      return Promise.resolve()
        .then(() => transport.close())
        .catch(() => {
          /* closing best-effort */
        });
    };

    node.on("close", function (done) {
      Promise.resolve(node._closeTransport()).then(
        () => done(),
        () => done()
      );
    });
  }

  RED.nodes.registerType("doover-connection", DooverConnectionNode, {
    credentials: {
      token: { type: "password" },
    },
  });

  // --- Editor read-only identity endpoint ----------------------------------
  // Serves the detected agent id / app key / status so the config-node editor
  // can display them read-only. Relative path (no leading slash) so it respects
  // httpAdminRoot behind the Doover tunnel. Registered once per module load.
  if (RED.httpAdmin && typeof RED.httpAdmin.get === "function") {
    const guard =
      RED.auth && typeof RED.auth.needsPermission === "function"
        ? RED.auth.needsPermission("doover.read")
        : function (req, res, next) {
            next();
          };

    RED.httpAdmin.get(
      "/doover-connection/:id/identity",
      guard,
      function (req, res) {
        const conn = RED.nodes.getNode(req.params.id);
        if (!conn || typeof conn.getTransport !== "function") {
          res.json({});
          return;
        }
        /** @type {{agentId?: string|null, appKey?: string|null, status?: string}} */
        const out = {};
        let transport;
        try {
          transport = conn.getTransport();
        } catch (_err) {
          res.json({});
          return;
        }
        try {
          out.appKey = transport.appKey();
        } catch (_err) {
          /* not yet available */
        }
        try {
          out.agentId = transport.agentId();
        } catch (_err) {
          /* discovered at connect; not yet available */
        }
        try {
          out.status = transport.status();
        } catch (_err) {
          /* ignore */
        }
        res.json(out);
      }
    );
  }
};

/**
 * Install a test-only transport factory. Call before loading the node in a test
 * so consumer nodes receive a MockTransport instead of a real LocalTransport.
 * @param {(mode: string, opts: object) => import("@doover/nodered-core").DooverTransport} fn
 * @returns {void}
 */
module.exports.setTransportFactory = function (fn) {
  _transportFactory = fn;
};

/**
 * Remove any test-only transport factory, restoring default behaviour.
 * @returns {void}
 */
module.exports.clearTransportFactory = function () {
  _transportFactory = null;
};

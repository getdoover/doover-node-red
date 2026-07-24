"use strict";

/**
 * Fake DDA local web server — a faithful in-memory stand-in for the socket
 * surface that `@doover/nodered-core`'s `DooverJsLocalTransport` (via doover-js
 * `LocalAgentClient`) actually speaks to on the device.
 *
 * IMPORTANT — which surface this mimics, and why.
 * -------------------------------------------------
 * There are TWO local surfaces in play and they are NOT wire-compatible (see
 * docs/reference/dda-local-web-api.md "Headline finding"):
 *
 *   (A) The REAL shipping dda-agent web server (Rust, port 49100): REST under
 *       `/ch/v1/agent/{id}/...` + a WSS at `/ws` speaking
 *       `UI_SUBSCRIBE_CHANNEL` -> `CHANNEL_SUBSCRIPTION_UPDATE`.
 *
 *   (B) The CLOUD Doover-Data contract that doover-js `LocalAgentClient` 0.7.1
 *       emits when pointed at `baseUrl`: REST under `/agents/{id}/channels/...`
 *       + an opcode ("Discord-style") gateway WSS at the base path.
 *
 * Our transport wraps `LocalAgentClient`, so it speaks (B). Verified against the
 * installed dist:
 *   - node_modules/doover-js/dist/client/local-agent-client.js  (points cloud
 *     RestClient/GatewayClient at baseUrl; capabilities include aggregates
 *     get/put/patch, messages.post, gateway.oneShot)
 *   - node_modules/doover-js/dist/apis/aggregates-api.js
 *     `/agents/${id}/channels/${ch}/aggregate`
 *   - node_modules/doover-js/dist/gateway/gateway-client.js  (op 10/11/12/13/
 *     14/15; inbound Hello/Ready/ChannelSync/AggregateUpdate/MessageCreate/
 *     OneShotMessage)
 *
 * To "run our transport against it" (the task) the fake therefore serves (B).
 * The dda-agent SOURCE and its black-box suite (tests_bb/test_local_http_wss.py)
 * were still used as ground truth for two things: (1) the REAL
 * aggregate-merge/diff semantics — mirrored here via the project's own
 * lib/diff.js applyDiff (a faithful port of pydoover utils/diff.py); (2) pinning
 * the (A)-vs-(B) discrepancy as a finding. See the contract test header for the
 * findings this harness helped surface.
 *
 * Everything is plain CommonJS: `node:http` + the `ws` devDependency. No TLS
 * (the real server is https+self-signed; irrelevant for an in-process fake and
 * the transport injects its own WebSocket impl anyway).
 */

const http = require("node:http");
const { Server: WebSocketServer } = require("ws");

const { applyDiff, clone } = require("../../lib/diff");

/** Snowflake epoch used by doover-js (utils/snowflake.js). */
const SNOWFLAKE_EPOCH_MS = 1735689600000;

/**
 * A channel's in-memory state.
 * @typedef {Object} ChannelState
 * @property {Record<string, unknown>} data - The aggregate payload.
 * @property {Array<unknown>} attachments
 * @property {number} lastUpdated - epoch seconds.
 * @property {Array<any>} messages
 * @property {boolean} active - active-tracked (subscribed at least once).
 */

/**
 * @typedef {Object} FakeDdaServerOptions
 * @property {string} [agentId] - The single served device id. Default
 *   `"agent-local"`.
 * @property {string} [host] - Bind host. Default `"127.0.0.1"`.
 */

class FakeDdaServer {
  /**
   * @param {FakeDdaServerOptions} [opts]
   */
  constructor(opts = {}) {
    /** @type {string} */
    this.agentId = opts.agentId || "agent-local";
    /** @private @type {string} */
    this._host = opts.host || "127.0.0.1";

    /** @private @type {Map<string, ChannelState>} */
    this._channels = new Map();

    /** @private @type {import('node:http').Server | null} */
    this._http = null;
    /** @private @type {WebSocketServer | null} */
    this._wss = null;
    /** @private @type {Set<import('ws')>} Live gateway sockets. */
    this._sockets = new Set();

    /** REST calls recorded for assertions: {method, path, query, body}. */
    this.calls = [];

    // --- failure-injection state ---
    /** @private @type {number} Artificial HTTP response delay (ms). */
    this._delayMs = 0;
    /** @private @type {boolean} Reject WS upgrade handshakes when true. */
    this._refuseUpgrades = false;

    /** @private @type {number} monotonic id source for messages/one-shots. */
    this._seq = 0;

    /** @type {number} Bound port (set after {@link start}). */
    this.port = 0;
    /** @type {string} `http://host:port` (set after {@link start}). */
    this.baseUrl = "";
    /** @type {string} `ws://host:port` (set after {@link start}). */
    this.wssUrl = "";
  }

  // -------------------------------------------------------------------------
  // lifecycle
  // -------------------------------------------------------------------------

  /**
   * Start listening on an ephemeral port.
   * @returns {Promise<void>}
   */
  start() {
    return new Promise((resolve, reject) => {
      this._http = http.createServer((req, res) => this._onRequest(req, res));
      this._wss = new WebSocketServer({ noServer: true });

      this._http.on("upgrade", (req, socket, head) => {
        if (this._refuseUpgrades) {
          // Faithful "refuse the WS handshake" — abort before switching
          // protocols. The client sees a failed upgrade / socket close.
          socket.destroy();
          return;
        }
        this._wss.handleUpgrade(req, socket, head, (ws) => {
          this._onConnection(ws);
        });
      });

      this._http.on("error", reject);
      this._http.listen(0, this._host, () => {
        const addr = /** @type {import('node:net').AddressInfo} */ (
          this._http.address()
        );
        this.port = addr.port;
        this.baseUrl = `http://${this._host}:${this.port}`;
        this.wssUrl = `ws://${this._host}:${this.port}`;
        resolve();
      });
    });
  }

  /**
   * Close every socket and the HTTP server.
   * @returns {Promise<void>}
   */
  async stop() {
    for (const ws of this._sockets) {
      try {
        ws.terminate();
      } catch (_e) {
        /* ignore */
      }
    }
    this._sockets.clear();
    if (this._wss) {
      await new Promise((r) => this._wss.close(() => r(undefined)));
      this._wss = null;
    }
    if (this._http) {
      await new Promise((r) => this._http.close(() => r(undefined)));
      this._http = null;
    }
  }

  // -------------------------------------------------------------------------
  // store — real aggregate-merge semantics (mirrors pydoover apply_diff)
  // -------------------------------------------------------------------------

  /**
   * @private
   * @param {string} name
   * @returns {ChannelState}
   */
  _channel(name) {
    let st = this._channels.get(name);
    if (!st) {
      st = {
        data: {},
        attachments: [],
        lastUpdated: 0,
        messages: [],
        active: false,
      };
      this._channels.set(name, st);
    }
    return st;
  }

  /**
   * Replace a channel's aggregate wholesale WITHOUT broadcasting — models an
   * out-of-band change (e.g. another writer, or a value that changed while our
   * transport was disconnected). Tests use this to stage "changed while down".
   * @param {string} name
   * @param {Record<string, unknown>} data
   */
  setAggregate(name, data) {
    const st = this._channel(name);
    st.data = clone(data);
    st.lastUpdated = nowSecs();
  }

  /**
   * @param {string} name
   * @returns {Record<string, unknown> | undefined}
   */
  getAggregate(name) {
    const st = this._channels.get(name);
    return st ? clone(st.data) : undefined;
  }

  /**
   * Server-originated aggregate write, mirroring what a POST/PATCH does, and
   * broadcasts the merged result to subscribers. Lets a test act as a *second*
   * writer independent of the transport under test.
   * @param {string} name
   * @param {Record<string, unknown>} diff
   * @param {{ replace?: boolean }} [opts]
   */
  publishAggregate(name, diff, opts = {}) {
    const st = this._channel(name);
    st.data = opts.replace
      ? clone(diff)
      : /** @type {Record<string, unknown>} */ (
          applyDiff(st.data, diff, { doDelete: true })
        );
    st.lastUpdated = nowSecs();
    this._broadcastAggregate(name, st);
  }

  /**
   * Create a persisted message on a channel and broadcast a MessageCreate.
   * @param {string} name
   * @param {Record<string, unknown>} data
   * @returns {any} the created message
   */
  postMessage(name, data) {
    const st = this._channel(name);
    const msg = this._makeMessage(name, data);
    st.messages.push(msg);
    this._broadcast(name, { op: 0, t: "MessageCreate", d: msg });
    return msg;
  }

  // -------------------------------------------------------------------------
  // failure injection
  // -------------------------------------------------------------------------

  /** Abruptly terminate every live gateway socket (RST-like). */
  dropConnections() {
    for (const ws of [...this._sockets]) {
      try {
        ws.terminate();
      } catch (_e) {
        /* ignore */
      }
      this._sockets.delete(ws);
    }
  }

  /**
   * Delay every subsequent HTTP response by `ms`. Pass 0 to clear.
   * @param {number} ms
   */
  delayResponses(ms) {
    this._delayMs = Math.max(0, Number(ms) || 0);
  }

  /**
   * Broadcast a genuinely malformed (non-JSON) text frame to all live sockets.
   * @param {string} [raw] - override the malformed payload.
   */
  sendMalformedFrame(raw) {
    this.broadcastRaw(raw !== undefined ? raw : " not-json {[");
  }

  /**
   * Broadcast an arbitrary raw string to all live sockets (test helper — used
   * for both malformed and JSON-valid-but-unknown frames).
   * @param {string} raw
   */
  broadcastRaw(raw) {
    for (const ws of this._sockets) {
      if (ws.readyState === ws.OPEN) {
        try {
          ws.send(raw);
        } catch (_e) {
          /* ignore */
        }
      }
    }
  }

  /**
   * Toggle refusal of WS upgrade handshakes.
   * @param {boolean} on
   */
  refuseUpgrades(on) {
    this._refuseUpgrades = !!on;
  }

  /** @returns {number} live gateway socket count. */
  connectionCount() {
    return this._sockets.size;
  }

  /**
   * Number of live sockets currently subscribed to `name`. Tests wait on this
   * before publishing, since AggregateUpdates are live-only (not replayed) —
   * publishing before the `op:12` subscribe lands would be lost.
   * @param {string} name
   * @returns {number}
   */
  subscriberCount(name) {
    let n = 0;
    for (const ws of this._sockets) {
      const conn = /** @type {any} */ (ws)._conn;
      if (conn && conn.subscriptions.has(name)) {
        n += 1;
      }
    }
    return n;
  }

  // -------------------------------------------------------------------------
  // HTTP
  // -------------------------------------------------------------------------

  /**
   * @private
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  _onRequest(req, res) {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body;
      if (chunks.length) {
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch (_e) {
          body = undefined;
        }
      }
      const finish = () => this._route(req, res, body);
      if (this._delayMs > 0) {
        setTimeout(finish, this._delayMs);
      } else {
        finish();
      }
    });
  }

  /**
   * @private
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {any} body
   */
  _route(req, res, body) {
    const method = (req.method || "GET").toUpperCase();
    const parsed = new URL(req.url || "/", this.baseUrl);
    const path = parsed.pathname;
    const query = Object.fromEntries(parsed.searchParams.entries());
    this.calls.push({ method, path, query, body });

    if (method === "OPTIONS") {
      return this._send(res, 200, {});
    }
    if (method === "GET" && path === "/healthcheck") {
      return this._send(res, 200, { status: "ok" });
    }
    // GET /agents/  -> agent scope resolution (LocalAgentClient.getAgentScope)
    if (method === "GET" && (path === "/agents" || path === "/agents/")) {
      return this._send(res, 200, { agents: [{ id: this.agentId }] });
    }

    // /agents/{id}/channels/{ch}/messages
    let m = path.match(/^\/agents\/([^/]+)\/channels\/([^/]+)\/messages\/?$/);
    if (m) {
      const ch = decodeURIComponent(m[2]);
      if (method === "POST") {
        const created = this.postMessage(ch, (body && body.payload) || body || {});
        return this._send(res, 200, created);
      }
      if (method === "GET") {
        const st = this._channels.get(ch);
        return this._send(res, 200, st ? st.messages : []);
      }
    }

    // /agents/{id}/channels/{ch}/aggregate
    m = path.match(/^\/agents\/([^/]+)\/channels\/([^/]+)\/aggregate\/?$/);
    if (m) {
      const ch = decodeURIComponent(m[2]);
      if (method === "GET") {
        const st = this._channels.get(ch);
        if (!st) {
          return this._send(res, 404, { detail: "Channel not found" });
        }
        return this._send(res, 200, this._aggregateEnvelope(st));
      }
      if (method === "PATCH") {
        const st = this._channel(ch);
        st.data = /** @type {Record<string, unknown>} */ (
          applyDiff(st.data, body || {}, { doDelete: true })
        );
        st.lastUpdated = nowSecs();
        this._broadcastAggregate(ch, st);
        return this._send(res, 200, this._aggregateEnvelope(st));
      }
      if (method === "PUT") {
        const st = this._channel(ch);
        st.data = clone(body || {});
        st.lastUpdated = nowSecs();
        this._broadcastAggregate(ch, st);
        return this._send(res, 200, this._aggregateEnvelope(st));
      }
    }

    // /agents/{id}/channels/{ch}
    m = path.match(/^\/agents\/([^/]+)\/channels\/([^/]+)\/?$/);
    if (m) {
      const ch = decodeURIComponent(m[2]);
      if (method === "GET") {
        const st = this._channels.get(ch);
        if (!st) {
          return this._send(res, 404, { detail: "Channel not found" });
        }
        return this._send(res, 200, {
          agent: this.agentId,
          name: ch,
          channel: ch,
          type: "channel",
        });
      }
    }

    // /agents/{id}/channels  (list active)
    m = path.match(/^\/agents\/([^/]+)\/channels\/?$/);
    if (m && method === "GET") {
      const channels = [...this._channels.entries()].map(([name]) => ({
        agent: this.agentId,
        name,
        channel: name,
        type: "channel",
      }));
      return this._send(res, 200, { channels });
    }

    return this._send(res, 404, { detail: "Not found" });
  }

  /**
   * @private
   * @param {ChannelState} st
   * @returns {any}
   */
  _aggregateEnvelope(st) {
    return {
      data: clone(st.data),
      attachments: clone(st.attachments),
      last_updated: st.lastUpdated || null,
    };
  }

  /**
   * @private
   * @param {import('node:http').ServerResponse} res
   * @param {number} status
   * @param {any} body
   */
  _send(res, status, body) {
    const json = JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "*",
      "access-control-allow-headers": "*",
    });
    res.end(json);
  }

  // -------------------------------------------------------------------------
  // WSS gateway (doover-js opcode protocol)
  // -------------------------------------------------------------------------

  /**
   * @private
   * @param {import('ws')} ws
   */
  _onConnection(ws) {
    /** @type {{subscriptions: Set<string>, session: any}} */
    const conn = { subscriptions: new Set(), session: null };
    // eslint-disable-next-line no-param-reassign
    /** @type {any} */ (ws)._conn = conn;
    this._sockets.add(ws);

    ws.on("message", (raw) => {
      let frame;
      try {
        frame = JSON.parse(raw.toString());
      } catch (_e) {
        // Our fake server is robust to junk from the client (the real gateway
        // closes on invalid JSON; being lenient here keeps the harness usable).
        return;
      }
      this._onFrame(ws, conn, frame);
    });

    ws.on("close", () => {
      this._sockets.delete(ws);
    });
    ws.on("error", () => {
      this._sockets.delete(ws);
    });

    // Greet: the doover-js GatewayClient waits for Hello, then identifies.
    this._sendFrame(ws, { op: 0, t: "Hello", d: {} });
  }

  /**
   * @private
   * @param {import('ws')} ws
   * @param {{subscriptions: Set<string>, session: any}} conn
   * @param {any} frame
   */
  _onFrame(ws, conn, frame) {
    if (!frame || typeof frame !== "object") {
      return;
    }
    switch (frame.op) {
      case 10: {
        // identify -> Ready
        conn.session = {
          session_id: `sess-${++this._seq}`,
          session_token: `tok-${this._seq}`,
        };
        this._sendFrame(ws, { op: 0, t: "Ready", d: conn.session });
        break;
      }
      case 11: {
        // resume -> Ready (accept whatever session id the client presents)
        conn.session =
          frame.d && frame.d.session_id
            ? { session_id: frame.d.session_id, session_token: frame.d.session_token || `tok-${++this._seq}` }
            : { session_id: `sess-${++this._seq}`, session_token: `tok-${this._seq}` };
        this._sendFrame(ws, { op: 0, t: "Ready", d: conn.session });
        break;
      }
      case 12: {
        // subscribe -> register + immediate ChannelSync (current aggregate)
        const name = channelName(frame.d && frame.d.channel);
        if (name == null) {
          return;
        }
        conn.subscriptions.add(name);
        const st = this._channel(name);
        st.active = true;
        this._sendFrame(ws, {
          op: 0,
          t: "ChannelSync",
          d: {
            channel: { agent_id: this.agentId, name },
            aggregate: this._aggregateEnvelope(st),
          },
        });
        break;
      }
      case 13: {
        const name = channelName(frame.d && frame.d.channel);
        if (name != null) {
          conn.subscriptions.delete(name);
        }
        break;
      }
      case 14: {
        // syncChannel -> ChannelSync
        const name = channelName(frame.d && frame.d.channel);
        if (name == null) {
          return;
        }
        const st = this._channel(name);
        this._sendFrame(ws, {
          op: 0,
          t: "ChannelSync",
          d: {
            channel: { agent_id: this.agentId, name },
            aggregate: this._aggregateEnvelope(st),
          },
        });
        break;
      }
      case 15: {
        // one-shot -> broadcast OneShotMessage to subscribers of the channel
        const name = channelName(frame.d && frame.d.channel);
        if (name == null) {
          return;
        }
        this._broadcast(name, {
          op: 0,
          t: "OneShotMessage",
          d: {
            id: this._nextSnowflake(),
            author_id: this.agentId,
            channel: { agent_id: this.agentId, name },
            data: frame.d.data,
          },
        });
        break;
      }
      default:
        break;
    }
  }

  /**
   * @private
   * @param {string} name
   * @param {ChannelState} st
   */
  _broadcastAggregate(name, st) {
    this._broadcast(name, {
      op: 0,
      t: "AggregateUpdate",
      d: {
        channel: { agent_id: this.agentId, name },
        aggregate: this._aggregateEnvelope(st),
      },
    });
  }

  /**
   * Send a frame to every socket currently subscribed to `name`.
   * @private
   * @param {string} name
   * @param {any} frame
   */
  _broadcast(name, frame) {
    for (const ws of this._sockets) {
      const conn = /** @type {any} */ (ws)._conn;
      if (conn && conn.subscriptions.has(name)) {
        this._sendFrame(ws, frame);
      }
    }
  }

  /**
   * @private
   * @param {import('ws')} ws
   * @param {any} frame
   */
  _sendFrame(ws, frame) {
    if (ws.readyState === ws.OPEN) {
      try {
        ws.send(JSON.stringify(frame));
      } catch (_e) {
        /* ignore */
      }
    }
  }

  /**
   * @private
   * @param {string} name
   * @param {Record<string, unknown>} data
   */
  _makeMessage(name, data) {
    return {
      id: this._nextSnowflake(),
      author_id: this.agentId,
      channel: { agent_id: this.agentId, name },
      data: clone(data),
    };
  }

  /**
   * A numeric-string snowflake id. doover-js `addTimestampToMessage` calls
   * `BigInt(id)` on every MessageCreate / postMessage response, so the id MUST
   * parse as a BigInt — a plain uuid would throw.
   * @private
   * @returns {string}
   */
  _nextSnowflake() {
    const t = BigInt(Date.now() - SNOWFLAKE_EPOCH_MS);
    const seq = BigInt(this._seq++ % 4096);
    return ((t << 22n) + seq).toString();
  }
}

/** @returns {number} epoch seconds. */
function nowSecs() {
  return Math.floor(Date.now() / 1000);
}

/**
 * @param {any} channel - `{agent_id, name}` gateway channel ref.
 * @returns {string | null}
 */
function channelName(channel) {
  if (channel && channel.name != null) {
    return String(channel.name);
  }
  return null;
}

module.exports = { FakeDdaServer };

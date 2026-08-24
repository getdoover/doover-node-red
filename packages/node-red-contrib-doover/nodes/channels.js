"use strict";
/*
 * Channel nodes: doover-channel-in, doover-channel-out, doover-message,
 * doover-aggregate-get.
 *
 * All four ride directly on the referenced doover-connection config node's
 * shared DooverTransport (subscribe / publish / createMessage / getAggregate /
 * sendOneShot). Each consumer acquire()s the connection on construction and
 * release()s it on close so the shared transport is refcounted and torn down
 * cleanly.
 */

const {
  resolveConnection,
  statusForTransport,
  STATUS_DOTS,
} = require("../lib/shared");

/**
 * Best-effort agent id — the transport may not have discovered it yet (or be a
 * stub), in which case we return null rather than throwing.
 * @param {import("@doover/nodered-core").DooverTransport} transport
 * @returns {string | null}
 */
function safeAgentId(transport) {
  try {
    return transport.agentId();
  } catch (_err) {
    return null;
  }
}

/**
 * Coerce a Node-RED editor value (which may arrive as a string) to a boolean.
 * @param {unknown} v
 * @returns {boolean}
 */
function asBool(v) {
  return v === true || v === "true";
}

/**
 * Momentary "sent" activity dot, restored to the transport's steady status.
 * @param {import("node-red").Node} node
 * @param {import("@doover/nodered-core").DooverTransport} transport
 */
function flashSent(node, transport) {
  node.status({ fill: "blue", shape: "dot", text: "sent" });
  if (node._flashTimer) {
    clearTimeout(node._flashTimer);
  }
  node._flashTimer = setTimeout(function () {
    node._flashTimer = null;
    let status;
    try {
      status = transport.status();
    } catch (_err) {
      status = "disconnected";
    }
    node.status(
      STATUS_DOTS[status] || { fill: "grey", shape: "ring", text: "unknown" }
    );
  }, 500);
  // Unref so a pending status-restore never keeps the process alive (parity with
  // the tag/notify blip timers).
  if (node._flashTimer.unref) {
    node._flashTimer.unref();
  }
}

/** @param {import("node-red").NodeAPI} RED */
module.exports = function (RED) {
  // --- doover-channel-in ----------------------------------------------------
  function DooverChannelInNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.channel = config.channel;
    node.emitAggregateOnConnect = asBool(config.emitAggregateOnConnect);

    const conn = resolveConnection(RED, node, config.connection);
    if (!conn) {
      return;
    }

    let transport;
    try {
      transport = conn.acquire();
    } catch (err) {
      node.status({ fill: "red", shape: "ring", text: "no transport" });
      node.error("Doover connection unavailable: " + err.message);
      return;
    }

    // No-op until we attach the transport status follower. When the node is
    // misconfigured (no channel) we deliberately DON'T attach it: the red
    // "no channel" config-error status must take precedence permanently, and a
    // status follower would overwrite it green the moment the transport connects.
    let detachStatus = function () {};
    let unsubscribe = null;
    let onStatus = null;
    // Set in the close handler; guards work that resolves after teardown (an
    // in-flight getAggregate landing on a torn-down node).
    let closed = false;

    if (!node.channel) {
      node.status({ fill: "red", shape: "ring", text: "no channel" });
      node.error("doover channel in: no channel configured.");
    } else {
      detachStatus = statusForTransport(node, transport);
      try {
        unsubscribe = transport.subscribe(node.channel, function (m) {
          // Skip the client-synthesised "sync" event: it carries the full
          // channel aggregate and is (re-)delivered on every subscribe and on
          // every gateway reconnect/resync. Forwarding it would emit the whole
          // aggregate as a message on connect even when emitAggregateOnConnect
          // is off, and re-emit it on each reconnect. The opt-in initial
          // aggregate is handled explicitly by the emitAggregateOnConnect path
          // below (once, via getAggregate).
          if (m && m.event === "sync") {
            return;
          }
          node.send({
            payload: m.payload,
            topic: node.channel,
            doover: { agentId: safeAgentId(transport), channel: node.channel },
          });
        });
      } catch (err) {
        node.status({ fill: "red", shape: "ring", text: "subscribe failed" });
        node.error(
          "doover channel in: failed to subscribe to '" +
            node.channel +
            "': " +
            err.message
        );
      }

      if (node.emitAggregateOnConnect) {
        let emitted = false;
        const emitAgg = function () {
          if (emitted) {
            return;
          }
          emitted = true;
          Promise.resolve()
            .then(function () {
              return transport.getAggregate(node.channel);
            })
            .then(function (agg) {
              if (closed) {
                return;
              }
              if (agg !== null && agg !== undefined) {
                node.send({
                  payload: agg,
                  topic: node.channel,
                  doover: {
                    agentId: safeAgentId(transport),
                    channel: node.channel,
                    aggregate: true,
                  },
                });
              }
            })
            .catch(function (err) {
              node.warn(
                "doover channel in: aggregate fetch failed: " + err.message
              );
            });
        };
        // Emit on the next tick so the flow is fully wired before we send.
        const trigger = function () {
          node._aggTimer = setTimeout(emitAgg, 0);
        };
        let status;
        try {
          status = transport.status();
        } catch (_err) {
          status = "disconnected";
        }
        if (status === "connected") {
          trigger();
        } else {
          onStatus = function (s) {
            if (s === "connected") {
              transport.removeListener("status", onStatus);
              onStatus = null;
              trigger();
            }
          };
          transport.on("status", onStatus);
        }
      }
    }

    node.on("close", function (done) {
      closed = true;
      if (unsubscribe) {
        try {
          unsubscribe();
        } catch (_err) {
          /* ignore */
        }
      }
      if (onStatus) {
        try {
          transport.removeListener("status", onStatus);
        } catch (_err) {
          /* ignore */
        }
      }
      if (node._aggTimer) {
        clearTimeout(node._aggTimer);
        node._aggTimer = null;
      }
      detachStatus();
      conn.release();
      done();
    });
  }
  RED.nodes.registerType("doover-channel-in", DooverChannelInNode);

  // --- doover-channel-out ---------------------------------------------------
  function DooverChannelOutNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.channel = config.channel;
    node.recordLog = asBool(config.recordLog);
    node.oneShot = asBool(config.oneShot);
    node.maxAge =
      config.maxAge !== "" && config.maxAge !== undefined && config.maxAge !== null
        ? Number(config.maxAge)
        : undefined;

    const conn = resolveConnection(RED, node, config.connection);
    if (!conn) {
      return;
    }

    let transport;
    try {
      transport = conn.acquire();
    } catch (err) {
      node.status({ fill: "red", shape: "ring", text: "no transport" });
      node.error("Doover connection unavailable: " + err.message);
      return;
    }

    const detachStatus = statusForTransport(node, transport);
    // Set in the close handler; guards post-await status work (an in-flight
    // publish resolving after the node is torn down during a redeploy).
    let closed = false;

    // One-shot mode delivers an ephemeral value that is neither merged into the
    // aggregate nor logged, so "Record in history" and "Max age" have no effect.
    // Warn once at deploy rather than silently dropping the operator's choice.
    if (node.oneShot && (node.recordLog || node.maxAge !== undefined)) {
      node.warn(
        "doover channel out: one-shot mode ignores 'Record in history' and " +
          "'Max age' (those apply only to aggregate publishes)."
      );
    }

    node.on("input", async function (msg, send, done) {
      const channel = node.channel || msg.topic;
      if (!channel) {
        done(
          new Error(
            "doover channel out: no channel configured and msg.topic is empty."
          )
        );
        return;
      }
      try {
        if (node.oneShot) {
          await transport.sendOneShot(channel, msg.payload);
        } else {
          /** @type {{recordLog?: boolean, maxAge?: number}} */
          const opts = {};
          if (node.recordLog) {
            opts.recordLog = true;
          }
          if (node.maxAge !== undefined && !Number.isNaN(node.maxAge)) {
            opts.maxAge = node.maxAge;
          }
          await transport.publish(channel, msg.payload, opts);
        }
        // Skip flashSent if the node was closed while the publish was in flight:
        // it would schedule a timer that calls status() on a torn-down node.
        if (!closed) {
          flashSent(node, transport);
        }
        done();
      } catch (err) {
        done(err);
      }
    });

    node.on("close", function (done) {
      closed = true;
      if (node._flashTimer) {
        clearTimeout(node._flashTimer);
        node._flashTimer = null;
      }
      detachStatus();
      conn.release();
      done();
    });
  }
  RED.nodes.registerType("doover-channel-out", DooverChannelOutNode);

  // --- doover-message -------------------------------------------------------
  function DooverMessageNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.channel = config.channel;

    const conn = resolveConnection(RED, node, config.connection);
    if (!conn) {
      return;
    }

    let transport;
    try {
      transport = conn.acquire();
    } catch (err) {
      node.status({ fill: "red", shape: "ring", text: "no transport" });
      node.error("Doover connection unavailable: " + err.message);
      return;
    }

    const detachStatus = statusForTransport(node, transport);
    let closed = false;

    node.on("input", async function (msg, send, done) {
      const channel = node.channel || msg.topic;
      if (!channel) {
        done(
          new Error(
            "doover message: no channel configured and msg.topic is empty."
          )
        );
        return;
      }

      try {
        await transport.createMessage(channel, msg.payload);
        if (!closed) {
          flashSent(node, transport);
        }
        done();
      } catch (err) {
        done(err);
      }
    });

    node.on("close", function (done) {
      closed = true;
      if (node._flashTimer) {
        clearTimeout(node._flashTimer);
        node._flashTimer = null;
      }
      detachStatus();
      conn.release();
      done();
    });
  }
  RED.nodes.registerType("doover-message", DooverMessageNode);

  // --- doover-aggregate-get -------------------------------------------------
  function DooverAggregateGetNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.channel = config.channel;
    node.property = config.property || "payload";

    const conn = resolveConnection(RED, node, config.connection);
    if (!conn) {
      return;
    }

    let transport;
    try {
      transport = conn.acquire();
    } catch (err) {
      node.status({ fill: "red", shape: "ring", text: "no transport" });
      node.error("Doover connection unavailable: " + err.message);
      return;
    }

    const detachStatus = statusForTransport(node, transport);
    // Set in the close handler; guards the post-await send (an in-flight
    // getAggregate resolving after the node is torn down during a redeploy).
    let closed = false;

    node.on("input", async function (msg, send, done) {
      const channel = node.channel || msg.topic;
      if (!channel) {
        done(
          new Error(
            "doover aggregate get: no channel configured and msg.topic is empty."
          )
        );
        return;
      }
      try {
        const agg = await transport.getAggregate(channel);
        if (closed) {
          done();
          return;
        }
        RED.util.setMessageProperty(msg, node.property, agg, true);
        send(msg);
        done();
      } catch (err) {
        done(err);
      }
    });

    node.on("close", function (done) {
      closed = true;
      detachStatus();
      conn.release();
      done();
    });
  }
  RED.nodes.registerType("doover-aggregate-get", DooverAggregateGetNode);
};

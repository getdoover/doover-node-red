"use strict";
/*
 * doover-notify — user notification / alert node.
 *
 * Publishes msg.payload text to the `significantEvent` channel as
 * `{ "notification_msg": <text> }` (verified against pydoover
 * `ui/manager.py::send_notification`, which publishes exactly that shape with
 * record_log=true, max_age=1). Optionally also records an activity-log entry on
 * the `activity_log` channel as `{ "action_string": <text> }` (mirrors
 * pydoover `record_activity_async`).
 *
 * Works over whatever transport the referenced `doover-connection` exposes via
 * getTransport() — local gRPC on-device, cloud REST elsewhere.
 */

const { STATUS_DOTS, resolveConnection, statusForTransport } = require("../lib/shared");

const SIGNIFICANT_EVENT_CHANNEL = "significantEvent";
const ACTIVITY_LOG_CHANNEL = "activity_log";

/**
 * Coerce an arbitrary payload to notification text.
 * @param {unknown} payload
 * @returns {string}
 */
function toText(payload) {
  if (payload === undefined || payload === null) {
    return "";
  }
  if (typeof payload === "string") {
    return payload;
  }
  if (typeof payload === "object") {
    try {
      return JSON.stringify(payload);
    } catch (_err) {
      return String(payload);
    }
  }
  return String(payload);
}

/** @param {import("node-red").NodeAPI} RED */
module.exports = function (RED) {
  function DooverNotifyNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    const conn = resolveConnection(RED, node, config.connection);
    if (!conn) {
      return;
    }
    if (typeof conn.getTransport !== "function") {
      node.status({ fill: "red", shape: "ring", text: "connection not ready" });
      node.error("Doover connection does not expose getTransport().");
      return;
    }

    /** @type {any} */
    let transport;
    try {
      transport = conn.acquire();
    } catch (err) {
      node.status({ fill: "red", shape: "ring", text: "no transport" });
      node.error("Doover connection unavailable: " + err.message);
      return;
    }
    const stopStatus = statusForTransport(node, transport);
    const recordActivity = !!config.recordActivity;

    node.on("input", async (msg, send, done) => {
      try {
        const text = toText(msg.payload);

        await transport.publish(
          SIGNIFICANT_EVENT_CHANNEL,
          { notification_msg: text },
          { recordLog: true, maxAge: 1 }
        );

        if (recordActivity) {
          await transport.publish(
            ACTIVITY_LOG_CHANNEL,
            { action_string: text },
            { recordLog: true }
          );
        }

        node.status({ fill: "blue", shape: "dot", text: "notified" });
        if (node._blipTimer) {
          clearTimeout(node._blipTimer);
        }
        node._blipTimer = setTimeout(() => {
          try {
            node.status(STATUS_DOTS[transport.status()] || {});
          } catch (_err) {
            /* transport gone */
          }
        }, 400);
        if (node._blipTimer.unref) {
          node._blipTimer.unref();
        }

        if (send) {
          send(msg);
        }
        done();
      } catch (err) {
        done(err);
      }
    });

    node.on("close", (done) => {
      if (node._blipTimer) {
        clearTimeout(node._blipTimer);
      }
      stopStatus();
      conn.release();
      done();
    });
  }

  RED.nodes.registerType("doover-notify", DooverNotifyNode);
};

"use strict";
/*
 * doover-notify — Doover notification node.
 *
 * Publishes msg.payload to the modern `notifications` channel. Scalar and
 * unrecognised object payloads become `{ "message": <text> }`. A payload with a
 * `message` property may also provide the notification system's optional
 * `title`, `topic`, and `severity` fields.
 *
 * Optionally records the message on the customer site's `activity_logs`
 * timeline channel as `{ "message": <text>, "type": "action" }`.
 *
 * Works over whatever transport the referenced `doover-connection` exposes via
 * getTransport() — local gRPC on-device, cloud REST elsewhere.
 */

const { STATUS_DOTS, resolveConnection, statusForTransport } = require("../lib/shared");

const NOTIFICATIONS_CHANNEL = "notifications";
const ACTIVITY_LOGS_CHANNEL = "activity_logs";

/** @typedef {"Trace" | "Debug" | "Info" | "Warn" | "Critical"} NotificationSeverity */
/** @typedef {{message: string, title?: string, topic?: string, severity?: NotificationSeverity}} NotificationPayload */

const NOTIFICATION_SEVERITIES = new Map([
  ["trace", "Trace"],
  ["debug", "Debug"],
  ["info", "Info"],
  ["warn", "Warn"],
  ["critical", "Critical"],
]);

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

/**
 * Read an optional string from a notification payload. Empty strings are
 * omitted so Doover can apply its title and topic defaults.
 * @param {Record<string, unknown>} payload
 * @param {"title" | "topic"} field
 * @returns {string | undefined}
 */
function optionalString(payload, field) {
  const value = payload[field];
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new TypeError("notification " + field + " must be a string");
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

/**
 * Normalise a severity value to the enum names accepted by doover-data.
 * @param {unknown} value
 * @returns {NotificationSeverity | undefined}
 */
function optionalSeverity(value) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new TypeError("notification severity must be a string");
  }
  const severity = NOTIFICATION_SEVERITIES.get(value.trim().toLowerCase());
  if (!severity) {
    throw new TypeError(
      "notification severity must be Trace, Debug, Info, Warn, or Critical"
    );
  }
  return severity;
}

/**
 * Parse msg.payload at the Node-RED boundary into doover-data's notification
 * channel contract.
 * @param {unknown} payload
 * @returns {NotificationPayload}
 */
function toNotification(payload) {
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    !Object.prototype.hasOwnProperty.call(payload, "message")
  ) {
    return { message: toText(payload) };
  }

  /** @type {Record<string, unknown>} */
  const input = payload;
  /** @type {NotificationPayload} */
  const notification = { message: toText(input.message) };
  const title = optionalString(input, "title");
  const topic = optionalString(input, "topic");
  const severity = optionalSeverity(input.severity);

  if (title !== undefined) notification.title = title;
  if (topic !== undefined) notification.topic = topic;
  if (severity !== undefined) notification.severity = severity;
  return notification;
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
        const notification = toNotification(msg.payload);

        await transport.publish(
          NOTIFICATIONS_CHANNEL,
          notification,
          { recordLog: true }
        );

        if (recordActivity) {
          await transport.publish(
            ACTIVITY_LOGS_CHANNEL,
            { message: notification.message, type: "action" },
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

"use strict";
/*
 * doover-notify — Doover notification node.
 *
 * Appends a message to the modern `notifications` channel without changing its
 * aggregate. Message, title, topic, and severity are independent Node-RED typed
 * inputs. Existing nodes and new nodes default to msg.payload, msg.title,
 * msg.topic, and msg.severity respectively.
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
 * Read an optional string from a resolved notification field. Empty strings are
 * omitted so Doover can apply its title and topic defaults.
 * @param {Record<string, unknown>} fields
 * @param {"title" | "topic"} field
 * @returns {string | undefined}
 */
function optionalString(fields, field) {
  const value = fields[field];
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
 * Build doover-data's notification payload from independently resolved fields.
 * @param {{message: unknown, title: unknown, topic: unknown, severity: unknown}} fields
 * @returns {NotificationPayload}
 */
function toNotification(fields) {
  /** @type {NotificationPayload} */
  const notification = { message: toText(fields.message) };
  const title = optionalString(fields, "title");
  const topic = optionalString(fields, "topic");
  const severity = optionalSeverity(fields.severity);

  if (title !== undefined) notification.title = title;
  if (topic !== undefined) notification.topic = topic;
  if (severity !== undefined) notification.severity = severity;
  return notification;
}

/**
 * Evaluate one configured Node-RED typed input.
 * @param {import("node-red").NodeAPI} RED
 * @param {import("node-red").Node} node
 * @param {Record<string, unknown>} msg
 * @param {string} field
 * @param {string} value
 * @param {string} type
 * @returns {Promise<unknown>}
 */
function evaluateField(RED, node, msg, field, value, type) {
  return new Promise((resolve, reject) => {
    try {
      RED.util.evaluateNodeProperty(value, type, node, msg, (err, result) => {
        if (err) {
          reject(
            new Error(
              "notification " + field + " could not be evaluated: " + err.message
            )
          );
          return;
        }
        resolve(result);
      });
    } catch (err) {
      reject(
        new Error(
          "notification " + field + " could not be evaluated: " + err.message
        )
      );
    }
  });
}

/**
 * Resolve the four typed inputs. Explicit undefined checks preserve valid empty
 * fixed strings while giving old saved flows the new defaults.
 * @param {import("node-red").NodeAPI} RED
 * @param {import("node-red").Node} node
 * @param {Record<string, unknown>} msg
 * @param {Record<string, unknown>} config
 * @returns {Promise<NotificationPayload>}
 */
async function resolveNotification(RED, node, msg, config) {
  const configured = (field, defaultValue) =>
    config[field] === undefined ? defaultValue : String(config[field]);
  const configuredType = (field) =>
    config[field + "Type"] === undefined
      ? "msg"
      : String(config[field + "Type"]);

  const [message, topic, severity, title] = await Promise.all([
    evaluateField(
      RED,
      node,
      msg,
      "message",
      configured("message", "payload"),
      configuredType("message")
    ),
    evaluateField(
      RED,
      node,
      msg,
      "topic",
      configured("topic", "topic"),
      configuredType("topic")
    ),
    evaluateField(
      RED,
      node,
      msg,
      "severity",
      configured("severity", "severity"),
      configuredType("severity")
    ),
    evaluateField(
      RED,
      node,
      msg,
      "title",
      configured("title", "title"),
      configuredType("title")
    ),
  ]);

  return toNotification({ message, topic, severity, title });
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
        const notification = await resolveNotification(
          RED,
          node,
          msg,
          config
        );

        await transport.createMessage(NOTIFICATIONS_CHANNEL, notification);

        if (recordActivity) {
          await transport.createMessage(
            ACTIVITY_LOGS_CHANNEL,
            { message: notification.message, type: "action" }
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

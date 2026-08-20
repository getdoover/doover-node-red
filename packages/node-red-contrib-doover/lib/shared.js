"use strict";

const STATUS_DOTS = {
  connecting: { fill: "yellow", shape: "ring", text: "connecting" },
  connected: { fill: "green", shape: "dot", text: "connected" },
  disconnected: { fill: "red", shape: "ring", text: "disconnected" },
};

function resolveConnection(RED, node, id) {
  const connection = id ? RED.nodes.getNode(id) : null;
  if (!connection) {
    node.status({ fill: "red", shape: "ring", text: "no connection" });
    node.error("A Doover connection is required.");
    return null;
  }
  return connection;
}

function statusForTransport(node, transport) {
  const update = (status) => node.status(STATUS_DOTS[status] || { fill: "grey", shape: "ring", text: String(status || "unknown") });
  try { update(transport.status()); } catch (_err) { update("disconnected"); }
  const listener = (status) => update(status);
  const errorListener = (err) => {
    node.status({ fill: "red", shape: "ring", text: "connection error" });
    node.warn(`Doover transport: ${err && err.message ? err.message : String(err)}`);
  };
  if (typeof transport.on === "function") transport.on("status", listener);
  if (typeof transport.on === "function") transport.on("error", errorListener);
  return () => {
    if (typeof transport.removeListener === "function") transport.removeListener("status", listener);
    if (typeof transport.removeListener === "function") transport.removeListener("error", errorListener);
  };
}

module.exports = { STATUS_DOTS, resolveConnection, statusForTransport };

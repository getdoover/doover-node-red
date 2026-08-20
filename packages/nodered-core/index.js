"use strict";

/**
 * @doover/nodered-core — Doover transport + tag layer for Node-RED.
 *
 * Node-RED-independent. Exposes the {@link DooverTransport} interface, its
 * concrete implementations, and the {@link TagClient} convenience layer that
 * rides on any transport.
 *
 * Transports:
 * - {@link GrpcWebTransport} — **the default local transport.** Speaks the
 *   dda-agent's protobuf API through its HTTPS gRPC-Web mount on port 49100.
 * - {@link DooverJsCloudTransport} — cloud transport. Wraps doover-js
 *   `DooverClient`, scoped to a configured target agent id.
 * - {@link LocalTransport} — PARKED legacy gRPC path (port 50051). Retained and
 *   tested, but not the default; re-exported under `LocalTransportGrpc` for the
 *   few callers that still need it.
 * - {@link MockTransport} — in-memory implementation for tests.
 */

const { DooverTransport } = require("./lib/transport");
const {
  DooverJsTransport,
  DooverJsLocalTransport,
  DooverJsCloudTransport,
  DEFAULT_WEB_BASE_URL,
  CLOUD_DEFAULTS,
} = require("./lib/dooverjs-transport");
const { LocalTransport } = require("./lib/local-transport");
const {
  GrpcWebTransport,
  GrpcWebClient,
  DEFAULT_GRPC_WEB_BASE_URL,
} = require("./lib/grpc-web-transport");
const {
  TagClient,
  TAG_CHANNEL_NAME,
  LIVE_TAG_CHANNEL_NAME,
  DEFAULT_MAX_AGE_SECS,
} = require("./lib/tags");
const { MockTransport } = require("./lib/mock-transport");
const { applyDiff, generateDiff, deepEqual } = require("./lib/diff");
const { jsToStruct, structToJs } = require("./lib/struct");
const { validatePayload } = require("./lib/validate");

module.exports = {
  DooverTransport,
  // doover-js transports (default backend)
  DooverJsTransport,
  DooverJsLocalTransport,
  DooverJsCloudTransport,
  // Local DDA transport over the web listener's /grpc mount.
  GrpcWebTransport,
  GrpcWebClient,
  DefaultLocalTransport: GrpcWebTransport,
  // PARKED legacy gRPC transport (kept, not default).
  LocalTransportGrpc: LocalTransport,
  LocalTransport,
  TagClient,
  MockTransport,
  // constants
  TAG_CHANNEL_NAME,
  LIVE_TAG_CHANNEL_NAME,
  DEFAULT_MAX_AGE_SECS,
  DEFAULT_WEB_BASE_URL,
  CLOUD_DEFAULTS,
  DEFAULT_GRPC_WEB_BASE_URL,
  // diff / struct / validation helpers
  applyDiff,
  generateDiff,
  deepEqual,
  jsToStruct,
  structToJs,
  validatePayload,
};

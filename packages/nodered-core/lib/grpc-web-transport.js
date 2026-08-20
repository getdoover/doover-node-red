"use strict";

const http = require("node:http");
const https = require("node:https");
const path = require("node:path");
const { URL } = require("node:url");
const protoLoader = require("@grpc/proto-loader");
const { DooverTransport } = require("./transport");
const { jsToStruct, structToJs } = require("./struct");
const { validatePayload } = require("./validate");
const { clone } = require("./diff");

const DEFAULT_GRPC_WEB_BASE_URL = "https://127.0.0.1:49100/grpc";
const MAX_FRAME_BYTES = 64 * 1024 * 1024;

let cachedService = null;

function serviceDefinition() {
  if (!cachedService) {
    const definition = protoLoader.loadSync(
      path.join(__dirname, "../protos/device_agent.proto"),
      {
        keepCase: true,
        longs: String,
        enums: String,
        defaults: false,
        oneofs: true,
      }
    );
    cachedService = definition["device_agent.deviceAgent"];
  }
  return cachedService;
}

function normaliseBaseUrl(value) {
  let raw = String(value || DEFAULT_GRPC_WEB_BASE_URL).trim();
  if (!/^https?:\/\//i.test(raw)) {
    raw = `https://${raw}`;
  }
  const url = new URL(raw);
  let pathname = url.pathname.replace(/\/+$/, "");
  if (!pathname.endsWith("/grpc")) {
    pathname += "/grpc";
  }
  url.pathname = pathname || "/grpc";
  url.search = "";
  url.hash = "";
  return url;
}

function encodeFrame(payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const frame = Buffer.allocUnsafe(body.length + 5);
  frame[0] = 0;
  frame.writeUInt32BE(body.length, 1);
  body.copy(frame, 5);
  return frame;
}

function parseTrailers(payload) {
  const trailers = {};
  for (const line of payload.toString("utf8").split("\r\n")) {
    const split = line.indexOf(":");
    if (split > 0) {
      trailers[line.slice(0, split).trim().toLowerCase()] = line
        .slice(split + 1)
        .trim();
    }
  }
  return trailers;
}

function grpcError(status, message) {
  const decoded = (() => {
    try {
      return decodeURIComponent(message || "");
    } catch (_err) {
      return message || "";
    }
  })();
  const err = new Error(decoded || `gRPC-Web request failed (${status})`);
  err.code = Number(status);
  return err;
}

class FrameDecoder {
  constructor(onData, onTrailers) {
    this._buffer = Buffer.alloc(0);
    this._onData = onData;
    this._onTrailers = onTrailers;
  }

  write(chunk) {
    this._buffer = this._buffer.length
      ? Buffer.concat([this._buffer, chunk])
      : Buffer.from(chunk);
    while (this._buffer.length >= 5) {
      const flag = this._buffer[0];
      const length = this._buffer.readUInt32BE(1);
      if (length > MAX_FRAME_BYTES) {
        throw new Error(`gRPC-Web frame exceeds ${MAX_FRAME_BYTES} bytes`);
      }
      if (this._buffer.length < length + 5) {
        return;
      }
      const payload = this._buffer.subarray(5, length + 5);
      this._buffer = this._buffer.subarray(length + 5);
      if (flag & 0x80) {
        this._onTrailers(parseTrailers(payload));
      } else if (flag === 0) {
        this._onData(payload);
      } else {
        throw new Error(`unsupported compressed gRPC-Web frame flag ${flag}`);
      }
    }
  }

  finish() {
    if (this._buffer.length) {
      throw new Error("truncated gRPC-Web response frame");
    }
  }
}

/** Minimal binary gRPC-Web client for Node's built-in HTTP stack. */
class GrpcWebClient {
  constructor({
    baseUrl = DEFAULT_GRPC_WEB_BASE_URL,
    rejectUnauthorized = false,
    requestTimeoutMs = 10000,
  } = {}) {
    this.baseUrl = normaliseBaseUrl(baseUrl);
    this.rejectUnauthorized = rejectUnauthorized;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  _method(name) {
    const method = serviceDefinition()[name];
    if (!method) {
      throw new Error(`unknown device-agent RPC ${name}`);
    }
    return method;
  }

  _start(name, message, { onMessage, onEnd, timeoutMs = 0 }) {
    const method = this._method(name);
    const url = new URL(this.baseUrl.toString());
    const prefix = url.pathname.replace(/\/+$/, "");
    const body = encodeFrame(method.requestSerialize(message || {}));
    const requestImpl = url.protocol === "https:" ? https : http;
    let ended = false;
    let cancelled = false;
    let grpcStatus = null;
    let grpcMessage = "";

    const finish = (err = null) => {
      if (ended) return;
      ended = true;
      if (!cancelled) onEnd(err);
    };

    const req = requestImpl.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || undefined,
        path: `${prefix}${method.path}`,
        method: "POST",
        rejectUnauthorized: this.rejectUnauthorized,
        headers: {
          "content-type": "application/grpc-web+proto",
          "x-grpc-web": "1",
          "x-user-agent": "doover-node-red/0.1",
          "content-length": String(body.length),
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          finish(new Error(`gRPC-Web HTTP status ${res.statusCode}`));
          return;
        }
        if (res.headers["grpc-status"] !== undefined) {
          grpcStatus = String(res.headers["grpc-status"]);
          grpcMessage = String(res.headers["grpc-message"] || "");
        }
        const decoder = new FrameDecoder(
          (payload) => onMessage(method.responseDeserialize(payload)),
          (trailers) => {
            if (trailers["grpc-status"] !== undefined) {
              grpcStatus = trailers["grpc-status"];
              grpcMessage = trailers["grpc-message"] || "";
            }
          }
        );
        res.on("data", (chunk) => {
          try {
            decoder.write(chunk);
          } catch (err) {
            req.destroy(err);
          }
        });
        res.on("end", () => {
          try {
            decoder.finish();
          } catch (err) {
            finish(err);
            return;
          }
          if (grpcStatus !== null && grpcStatus !== "0") {
            finish(grpcError(grpcStatus, grpcMessage));
          } else {
            finish();
          }
        });
        res.on("error", finish);
      }
    );
    req.on("error", finish);
    if (timeoutMs > 0) {
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`gRPC-Web request timed out after ${timeoutMs}ms`));
      });
    }
    req.end(body);

    return () => {
      if (cancelled || ended) return;
      cancelled = true;
      req.destroy();
    };
  }

  unary(name, message) {
    return new Promise((resolve, reject) => {
      let response;
      this._start(name, message, {
        timeoutMs: this.requestTimeoutMs,
        onMessage: (value) => {
          response = value;
        },
        onEnd: (err) => {
          if (err) reject(err);
          else if (response === undefined) {
            reject(new Error(`gRPC-Web ${name} returned no response message`));
          } else resolve(response);
        },
      });
    });
  }

  stream(name, message, handlers) {
    return this._start(name, message, {
      onMessage: handlers.onMessage,
      onEnd: handlers.onEnd,
    });
  }
}

function responseError(header = {}) {
  if (header.success !== false) return null;
  const code = Number(header.response_code || 0);
  const err = new Error(
    header.response_message || `Doover request failed (${code || "unknown"})`
  );
  err.code = code;
  err.notFound = code === 404;
  return err;
}

function jsonPayload(json, struct) {
  if (typeof json === "string" && json.length) {
    return JSON.parse(json);
  }
  return structToJs(struct);
}

function eventMessage(channel, response) {
  const body = jsonPayload(response.data_json, response.data);
  const name = String(response.event_name || "");
  const lower = name.toLowerCase();
  if (lower.includes("aggregate") || lower.includes("channelsync")) {
    const aggregate = body?.aggregate?.data ?? body?.aggregate ?? body?.data ?? body;
    return { channel, event: "aggregate", payload: aggregate, aggregate };
  }
  if (lower.includes("one")) {
    return { channel, event: "oneshot", payload: body?.data ?? body };
  }
  if (lower.includes("message")) {
    return {
      channel,
      event: lower.includes("update") ? "message_update" : "message",
      payload: body?.data ?? body?.message?.data ?? body,
      messageId: body?.id ?? body?.message?.id ?? null,
    };
  }
  return { channel, event: name || "event", payload: body };
}

class GrpcWebTransport extends DooverTransport {
  constructor(opts = {}) {
    const baseUrl =
      opts.baseUrl || process.env.DDA_GRPC_WEB_URI || process.env.DDA_WEB_URI ||
      DEFAULT_GRPC_WEB_BASE_URL;
    super({
      agentId: opts.agentId || process.env.AGENT_ID || "local",
      appKey: opts.appKey !== undefined ? opts.appKey : process.env.APP_KEY || null,
    });
    const verifyEnv = String(process.env.DDA_GRPC_WEB_TLS_VERIFY || "").toLowerCase();
    const rejectUnauthorized = opts.rejectUnauthorized !== undefined
      ? opts.rejectUnauthorized
      : verifyEnv === "1" || verifyEnv === "true";
    this._client = opts.client || new GrpcWebClient({
      baseUrl,
      rejectUnauthorized,
      requestTimeoutMs: opts.requestTimeoutMs,
    });
    this._baseUrl = normaliseBaseUrl(baseUrl).toString();
    this._connectPromise = null;
    this._closed = false;
    this._subscriptions = new Map();
  }

  _header() {
    return { app_id: this._appKey || "" };
  }

  async _rpc(name, request) {
    const response = await this._client.unary(name, request);
    const failure = responseError(response?.response_header);
    if (failure) throw failure;
    return response || {};
  }

  _reportError(err) {
    this.emit("error", err instanceof Error ? err : new Error(String(err)));
  }

  async connect() {
    if (this._status === "connected") return;
    if (this._connectPromise) return this._connectPromise;
    this._closed = false;
    this._connectPromise = (async () => {
      this._setStatus("connecting");
      try {
        await this._rpc("TestComms", {
          header: this._header(),
          message: "node-red",
        });
        if (!this._closed) this._setStatus("connected");
      } catch (err) {
        if (!this._closed) this._setStatus("disconnected");
        throw err;
      } finally {
        this._connectPromise = null;
      }
    })();
    return this._connectPromise;
  }

  async _ensureConnected() {
    if (this._status !== "connected") await this.connect();
  }

  async close() {
    this._closed = true;
    for (const state of this._subscriptions.values()) {
      state.closed = true;
      if (state.retryTimer) clearTimeout(state.retryTimer);
      if (state.cancel) state.cancel();
    }
    this._subscriptions.clear();
    this._setStatus("disconnected");
  }

  async publish(channel, payload, opts = {}) {
    validatePayload(payload);
    await this._ensureConnected();
    const request = {
      header: this._header(),
      channel_name: channel,
      data: jsToStruct(payload),
      data_json: JSON.stringify(payload),
      replace_data: !!opts.replaceData,
      save_log: !!opts.recordLog,
      return_aggregate: false,
    };
    if (opts.maxAge !== undefined) request.max_age_secs = Number(opts.maxAge);
    if (Array.isArray(opts.replaceKeys)) request.replace_keys = opts.replaceKeys;
    await this._rpc("UpdateAggregate", request);
  }

  async getAggregate(channel) {
    await this._ensureConnected();
    try {
      const response = await this._rpc("GetAggregate", {
        header: this._header(),
        channel_name: channel,
      });
      return response.aggregate
        ? jsonPayload(response.aggregate.data_json, response.aggregate.data)
        : null;
    } catch (err) {
      if (err.notFound || Number(err.code) === 404) return null;
      throw err;
    }
  }

  subscribe(channel, callback) {
    let state = this._subscriptions.get(channel);
    if (!state) {
      state = {
        channel,
        callbacks: new Set(),
        cancel: null,
        retryTimer: null,
        retryMs: 250,
        generation: 0,
        closed: false,
      };
      this._subscriptions.set(channel, state);
      queueMicrotask(() => this._openSubscription(state));
    }
    state.callbacks.add(callback);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      state.callbacks.delete(callback);
      if (!state.callbacks.size) {
        state.closed = true;
        if (state.retryTimer) clearTimeout(state.retryTimer);
        if (state.cancel) state.cancel();
        this._subscriptions.delete(channel);
      }
    };
  }

  _emitChannel(state, message) {
    for (const callback of [...state.callbacks]) {
      try {
        callback(clone(message));
      } catch (err) {
        this._reportError(err);
      }
    }
  }

  async _openSubscription(state) {
    if (this._closed || state.closed || !state.callbacks.size) return;
    const generation = ++state.generation;
    try {
      await this._ensureConnected();
      if (this._closed || state.closed || generation !== state.generation) return;

      const buffered = [];
      let seeded = false;
      let streamEnded = false;
      const deliver = (message) => {
        if (seeded) this._emitChannel(state, message);
        else buffered.push(message);
      };
      state.cancel = this._client.stream(
        "ChannelEventSubscription",
        {
          header: this._header(),
          channel_name: state.channel,
          wire_format: "WIRE_FORMAT_JSON_ONLY",
          replay_missed_messages: false,
        },
        {
          onMessage: (response) => {
            const failure = responseError(response?.response_header);
            if (failure) {
              this._reportError(failure);
              return;
            }
            try {
              deliver(eventMessage(state.channel, response));
            } catch (err) {
              this._reportError(err);
            }
          },
          onEnd: (err) => {
            streamEnded = true;
            if (this._closed || state.closed || generation !== state.generation) return;
            state.cancel = null;
            this._scheduleReconnect(state, err);
          },
        }
      );

      const aggregate = await this.getAggregate(state.channel);
      if (this._closed || state.closed || generation !== state.generation) return;
      this._emitChannel(state, {
        channel: state.channel,
        event: "sync",
        payload: aggregate,
        aggregate,
      });
      seeded = true;
      for (const message of buffered) this._emitChannel(state, message);
      state.retryMs = 250;
      if (!streamEnded) this._setStatus("connected");
    } catch (err) {
      if (!this._closed && !state.closed && generation === state.generation) {
        if (state.cancel) state.cancel();
        state.cancel = null;
        this._scheduleReconnect(state, err);
      }
    }
  }

  _scheduleReconnect(state, err) {
    if (this._closed || state.closed || state.retryTimer) return;
    if (err) this._reportError(err);
    this._setStatus("disconnected");
    const delay = state.retryMs;
    state.retryMs = Math.min(state.retryMs * 2, 5000);
    state.retryTimer = setTimeout(() => {
      state.retryTimer = null;
      this._openSubscription(state);
    }, delay);
    if (state.retryTimer.unref) state.retryTimer.unref();
  }

  async sendOneShot(channel, payload) {
    validatePayload(payload);
    await this._ensureConnected();
    await this._rpc("SendOneShotMessage", {
      header: this._header(),
      channel_name: channel,
      data: jsToStruct(payload),
      data_json: JSON.stringify(payload),
      timestamp: Date.now(),
    });
  }

  async createMessage(channel, payload) {
    validatePayload(payload);
    await this._ensureConnected();
    const response = await this._rpc("CreateMessage", {
      header: this._header(),
      channel_name: channel,
      data: jsToStruct(payload),
      data_json: JSON.stringify(payload),
      timestamp: Date.now(),
    });
    return response.message_id == null ? null : String(response.message_id);
  }
}

module.exports = {
  GrpcWebClient,
  GrpcWebTransport,
  DEFAULT_GRPC_WEB_BASE_URL,
  // Exported for protocol-level contract tests.
  _internals: { encodeFrame, FrameDecoder, parseTrailers, serviceDefinition },
};

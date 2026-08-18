"use strict";

const path = require("node:path");
const grpc = require("@grpc/grpc-js");
const protoLoader = require("@grpc/proto-loader");
const { DooverTransport } = require("./transport");
const { jsToStruct, structToJs } = require("./struct");
const { validatePayload } = require("./validate");

function makeClient(endpoint) {
  const def = protoLoader.loadSync(path.join(__dirname, "../protos/device_agent.proto"), {
    keepCase: true, longs: String, enums: String, defaults: false, oneofs: true,
  });
  const pkg = grpc.loadPackageDefinition(def).device_agent;
  return new pkg.deviceAgent(endpoint, grpc.credentials.createInsecure());
}

function responseError(header = {}) {
  if (header.success !== false) return null;
  const err = new Error(header.response_message || `Doover request failed (${header.response_code || "unknown"})`);
  err.code = header.response_code;
  err.notFound = header.response_code === 404;
  return err;
}

class LocalTransport extends DooverTransport {
  constructor({ client, endpoint, appKey, agentId = null } = {}) {
    super({ agentId, appKey: appKey || process.env.APP_KEY || null });
    this._client = client || makeClient(endpoint || process.env.DDA_URI || "127.0.0.1:50051");
    this._streams = new Set();
  }

  _header() { return { app_id: this._appKey || "" }; }

  _rpc(method, request) {
    return new Promise((resolve, reject) => {
      this._client[method](request, {}, (err, response) => {
        if (err) return reject(err);
        const failure = responseError(response?.response_header);
        if (failure) return reject(failure);
        resolve(response || {});
      });
    });
  }

  async connect() {
    this._setStatus("connecting");
    try {
      await this._rpc("testComms", { header: this._header(), message: "ping" });
      this._setStatus("connected");
    } catch (err) {
      this._setStatus("disconnected");
      throw err;
    }
  }

  async close() {
    for (const stream of this._streams) try { stream.cancel(); } catch (_err) { /* ignore */ }
    this._streams.clear();
    if (typeof this._client.close === "function") try { this._client.close(); } catch (_err) { /* ignore */ }
    this._setStatus("disconnected");
  }

  async publish(channel, payload, opts = {}) {
    validatePayload(payload);
    const request = {
      header: this._header(), channel_name: channel, data: jsToStruct(payload),
      replace_data: !!opts.replaceData, save_log: !!opts.recordLog,
    };
    if (opts.maxAge !== undefined) request.max_age_secs = opts.maxAge;
    await this._rpc("updateAggregate", request);
  }

  async getAggregate(channel) {
    try {
      const response = await this._rpc("getAggregate", { header: this._header(), channel_name: channel });
      return response.aggregate ? structToJs(response.aggregate.data) : null;
    } catch (err) {
      if (err.notFound || err.code === 404) return null;
      throw err;
    }
  }

  subscribe(channel, callback) {
    let active = true;
    void this.getAggregate(channel).then((aggregate) => {
      if (active) callback({ channel, event: "sync", payload: aggregate, aggregate });
    }).catch((err) => this.emit("error", err));
    const stream = this._client.channelEventSubscription({ header: this._header(), channel_name: channel });
    this._streams.add(stream);
    stream.on("data", (event) => {
      if (!active) return;
      const failure = responseError(event.response_header);
      if (failure) return this.emit("error", failure);
      const data = structToJs(event.data);
      const name = String(event.event_name || "").toLowerCase();
      const kind = name.includes("one") ? "oneshot" : name.includes("message") ? "message" : "aggregate";
      callback({ channel, event: kind, payload: data, ...(kind === "aggregate" ? { aggregate: data } : {}) });
    });
    stream.on("error", (err) => { if (active) this.emit("error", err); });
    return () => {
      if (!active) return;
      active = false;
      this._streams.delete(stream);
      try { stream.cancel(); } catch (_err) { /* ignore */ }
    };
  }

  async sendOneShot(channel, payload) {
    await this._rpc("sendOneShotMessage", { header: this._header(), channel_name: channel, data: jsToStruct(payload) });
  }

  async createMessage(channel, payload) {
    const response = await this._rpc("createMessage", {
      header: this._header(), channel_name: channel, data: jsToStruct(payload), timestamp: Date.now(),
    });
    return response.message_id == null ? null : String(response.message_id);
  }
}

module.exports = { LocalTransport };

"use strict";

const { DooverClient, LocalAgentClient } = require("doover-js");
const { DooverTransport } = require("./transport");
const { validatePayload } = require("./validate");
const { clone } = require("./diff");

const DEFAULT_WEB_BASE_URL = "http://127.0.0.1:49100";
const CLOUD_DEFAULTS = {
  controlApiUrl: "https://api.doover.com",
  dataRestUrl: "https://data.doover.com/api",
  dataWssUrl: "wss://data.doover.com/ws",
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let warnedMaxAge = false;

class DooverJsTransport extends DooverTransport {
  constructor({ client, agentId = null, appKey = null, gatewayOpenTimeoutMs = 2000 } = {}) {
    super({ agentId, appKey });
    this._client = client;
    this._gatewayOpenTimeoutMs = gatewayOpenTimeoutMs;
    this._connectPromise = null;
    this._closed = false;
    this._channelStates = new Map();
    this._statusDetach = typeof client?.onStatusChange === "function"
      ? client.onStatusChange((status) => {
        if (this._closed) return;
        const state = status?.state;
        if (state === "connecting") this._setStatus("connecting");
        else if (state === "disconnected" || state === "error") this._setStatus("disconnected");
        else if (state === "connected" || status?.connected) this._setStatus("connected");
      }) : null;
    this._onReady = () => this._resyncAll();
    if (client?.gateway?.on) client.gateway.on("ready", this._onReady);
  }

  async connect() {
    if (this._connectPromise) return this._connectPromise;
    this._closed = false;
    this._connectPromise = (async () => {
      this._setStatus("connecting");
      try {
        await this._client.gateway.connect();
        const started = Date.now();
        while (!this._closed && this._client.gateway.isConnected && !this._client.gateway.isConnected() && Date.now() - started < this._gatewayOpenTimeoutMs) {
          await delay(10);
        }
        if (this._closed) {
          this._client.gateway.disconnect();
          return;
        }
        await this._resolveAgent();
        if (this._closed) {
          this._client.gateway.disconnect();
          return;
        }
        this._setStatus("connected");
      } catch (err) {
        this._setStatus("disconnected");
        throw err;
      } finally {
        this._connectPromise = null;
      }
    })();
    return this._connectPromise;
  }

  async _resolveAgent() { /* cloud already has one; local overrides */ }

  async close() {
    this._closed = true;
    for (const state of this._channelStates.values()) this._detachChannel(state);
    this._channelStates.clear();
    try { this._client.gateway.disconnect(); } catch (_err) { /* best effort */ }
    if (this._statusDetach) this._statusDetach();
    this._setStatus("disconnected");
  }

  async _ensureConnected() {
    if (this._status !== "connected" || !this._agentId) await this.connect();
    if (!this._agentId) throw new Error("Doover agent id is not available");
  }

  async publish(channel, payload, opts = {}) {
    validatePayload(payload);
    if (opts.maxAge !== undefined && !warnedMaxAge) {
      warnedMaxAge = true;
      console.warn("@doover/nodered-core: maxAge is not supported by the doover-js transport and is ignored");
    }
    await this._ensureConnected();
    const params = opts.recordLog ? { log_update: true } : undefined;
    const fn = opts.replaceData ? "putAggregate" : "patchAggregate";
    await this._client.aggregates[fn](this._agentId, channel, payload, params);
  }

  async getAggregate(channel) {
    await this._ensureConnected();
    try {
      const aggregate = await this._client.aggregates.getAggregate(this._agentId, channel);
      return aggregate?.data ?? null;
    } catch (err) {
      if (err?.status === 404 || err?.code === 404 || err?.response?.status === 404) return null;
      throw err;
    }
  }

  subscribe(channel, callback) {
    let state = this._channelStates.get(channel);
    if (!state) {
      state = { channel, callbacks: new Set(), detach: null, oneShot: null, cancelled: false, generation: 0, seeded: false };
      this._channelStates.set(channel, state);
      void this._attachChannel(state);
    }
    state.callbacks.add(callback);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      state.callbacks.delete(callback);
      if (!state.callbacks.size) {
        state.cancelled = true;
        this._detachChannel(state);
        this._channelStates.delete(channel);
      }
    };
  }

  _emitChannel(state, message) {
    for (const callback of [...state.callbacks]) {
      try { callback(clone(message)); } catch (err) { this.emit("error", err); }
    }
  }

  async _attachChannel(state) {
    const generation = ++state.generation;
    try {
      await this._ensureConnected();
      if (state.cancelled || generation !== state.generation) return;
      const buffered = [];
      let seeded = false;
      const deliver = (message) => seeded ? this._emitChannel(state, message) : buffered.push(message);
      const ref = { agent_id: this._agentId, name: state.channel };
      state.detach = this._client.gateway.subscribeToChannel(ref, {
        onAggregate: (agg) => deliver({ channel: state.channel, event: "aggregate", payload: agg?.data ?? null, aggregate: agg?.data ?? null }),
        onMessage: (msg) => deliver({ channel: state.channel, event: "message", payload: msg?.data, messageId: msg?.id }),
        onMessageUpdate: (msg) => deliver({ channel: state.channel, event: "message_update", payload: msg?.data, messageId: msg?.id }),
      });
      state.oneShot = (msg) => {
        if (msg?.channel?.name === state.channel && (!msg.channel.agent_id || msg.channel.agent_id === this._agentId)) {
          deliver({ channel: state.channel, event: "oneshot", payload: msg.data });
        }
      };
      this._client.gateway.on("oneShotMessage", state.oneShot);
      const aggregate = await this.getAggregate(state.channel);
      if (state.cancelled || generation !== state.generation) return;
      this._emitChannel(state, { channel: state.channel, event: "sync", payload: aggregate, aggregate });
      seeded = true;
      state.seeded = true;
      buffered.forEach((message) => this._emitChannel(state, message));
    } catch (err) {
      if (!state.cancelled) this.emit("error", err);
    }
  }

  _detachChannel(state) {
    try { if (state.detach) state.detach(); } catch (_err) { /* ignore */ }
    try { if (state.oneShot) this._client.gateway.off("oneShotMessage", state.oneShot); } catch (_err) { /* ignore */ }
    state.detach = null;
    state.oneShot = null;
  }

  async _resyncAll() {
    for (const state of this._channelStates.values()) {
      if (!state.seeded) continue;
      try {
        const aggregate = await this.getAggregate(state.channel);
        if (!state.cancelled) this._emitChannel(state, { channel: state.channel, event: "sync", payload: aggregate, aggregate });
      } catch (_err) { /* a later reconnect retries */ }
    }
  }

  async sendOneShot(channel, payload) {
    await this._ensureConnected();
    this._client.gateway.sendOneShotMessage({ agent_id: this._agentId, name: channel }, payload);
  }

  async createMessage(channel, payload) {
    await this._ensureConnected();
    const result = await this._client.messages.postMessage(this._agentId, channel, { data: payload });
    return result?.id ?? null;
  }
}

class DooverJsLocalTransport extends DooverJsTransport {
  constructor(opts = {}) {
    const baseUrl = opts.baseUrl || process.env.DDA_WEB_URI || DEFAULT_WEB_BASE_URL;
    const client = opts.client || new LocalAgentClient({
      baseUrl,
      ...(opts.wssUrl ? { wssUrl: opts.wssUrl } : {}),
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      ...(opts.webSocketImpl ? { webSocketImpl: opts.webSocketImpl } : {}),
      disableBrowserLifecycleHooks: true,
    });
    super({ client, appKey: opts.appKey !== undefined ? opts.appKey : process.env.APP_KEY || null, gatewayOpenTimeoutMs: opts.gatewayOpenTimeoutMs });
    this._baseUrl = baseUrl;
  }

  async _resolveAgent() {
    const scope = await this._client.getAgentScope();
    this._agentId = scope?.mode === "list" ? scope.agentIds?.[0] || null : null;
  }
}

class DooverJsCloudTransport extends DooverJsTransport {
  constructor(opts = {}) {
    if (!opts.agentId) throw new TypeError("cloud transport requires an agentId");
    const client = opts.client || new DooverClient({
      ...CLOUD_DEFAULTS,
      ...opts,
      controlApiUrl: opts.controlApiUrl || opts.apiBase || CLOUD_DEFAULTS.controlApiUrl,
    });
    super({ client, agentId: opts.agentId, appKey: opts.appKey ?? null, gatewayOpenTimeoutMs: opts.gatewayOpenTimeoutMs });
  }
}

module.exports = { DooverJsTransport, DooverJsLocalTransport, DooverJsCloudTransport, DEFAULT_WEB_BASE_URL, CLOUD_DEFAULTS };

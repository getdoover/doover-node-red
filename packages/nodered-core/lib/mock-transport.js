"use strict";

const { DooverTransport } = require("./transport");
const { applyDiff, clone } = require("./diff");
const { validatePayload } = require("./validate");

class MockTransport extends DooverTransport {
  constructor({ autoConnect = false, agentId = "mock-agent", appKey = "mock-app", aggregates = {} } = {}) {
    super({ agentId, appKey });
    this._aggregates = new Map(Object.entries(aggregates).map(([k, v]) => [k, clone(v)]));
    this._subscribers = new Map();
    this.messages = [];
    if (autoConnect) this._status = "connected";
  }

  async connect() { this._setStatus("connected"); }

  async close() {
    this._subscribers.clear();
    this._setStatus("disconnected");
  }

  subscribe(channel, callback) {
    let set = this._subscribers.get(channel);
    if (!set) this._subscribers.set(channel, (set = new Set()));
    set.add(callback);
    const aggregate = this._aggregates.has(channel) ? clone(this._aggregates.get(channel)) : null;
    callback({ channel, event: "sync", aggregate, payload: clone(aggregate) });
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      set.delete(callback);
      if (!set.size) this._subscribers.delete(channel);
    };
  }

  _dispatch(channel, message) {
    const callbacks = [...(this._subscribers.get(channel) || [])];
    setImmediate(() => callbacks.forEach((cb) => {
      try { cb(clone(message)); } catch (err) { this.emit("error", err); }
    }));
  }

  async publish(channel, payload, opts = {}) {
    validatePayload(payload);
    const next = opts.replaceData ? clone(payload) : applyDiff(this._aggregates.get(channel) || {}, payload);
    this._aggregates.set(channel, next);
    this._dispatch(channel, { channel, event: "aggregate", aggregate: next, payload: clone(payload) });
  }

  async getAggregate(channel) {
    return this._aggregates.has(channel) ? clone(this._aggregates.get(channel)) : null;
  }

  async sendOneShot(channel, payload) {
    this._dispatch(channel, { channel, event: "oneshot", payload: clone(payload) });
  }

  async createMessage(channel, payload) {
    validatePayload(payload);
    const id = String(this.messages.length + 1);
    this.messages.push({ id, channel, payload: clone(payload) });
    this._dispatch(channel, { channel, event: "message", payload: clone(payload), messageId: id });
    return id;
  }

  seedAggregate(channel, aggregate) { this._aggregates.set(channel, clone(aggregate)); }

  resync(channel) {
    const aggregate = this._aggregates.has(channel) ? clone(this._aggregates.get(channel)) : null;
    const callbacks = [...(this._subscribers.get(channel) || [])];
    setImmediate(() => callbacks.forEach((cb) => cb({ channel, event: "sync", aggregate, payload: clone(aggregate) })));
  }
}

module.exports = { MockTransport };

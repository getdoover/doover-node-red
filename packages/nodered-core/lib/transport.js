"use strict";

const { EventEmitter } = require("node:events");

/** Common lifecycle and identity surface implemented by every transport. */
class DooverTransport extends EventEmitter {
  constructor({ agentId = null, appKey = null } = {}) {
    super();
    this._agentId = agentId;
    this._appKey = appKey;
    this._status = "disconnected";
  }

  agentId() { return this._agentId; }
  appKey() { return this._appKey; }
  status() { return this._status; }

  _setStatus(status) {
    if (status !== this._status) {
      this._status = status;
      this.emit("status", status);
    }
  }

  async connect() { throw new Error("connect() is not implemented"); }
  async close() { this._setStatus("disconnected"); }
  async publish() { throw new Error("publish() is not implemented"); }
  subscribe() { throw new Error("subscribe() is not implemented"); }
  async getAggregate() { throw new Error("getAggregate() is not implemented"); }
  async sendOneShot() { throw new Error("sendOneShot() is not implemented"); }
}

module.exports = { DooverTransport };

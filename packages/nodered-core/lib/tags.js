"use strict";

const { applyDiff, deepEqual, clone } = require("./diff");
const { KEY_RE } = require("./validate");

const TAG_CHANNEL_NAME = "tag_values";
const LIVE_TAG_CHANNEL_NAME = TAG_CHANNEL_NAME;
const DEFAULT_MAX_AGE_SECS = 60 * 60 * 24 * 30;

function pathParts(key) {
  const parts = Array.isArray(key) ? [...key] : String(key).split(".");
  if (!parts.length || parts.some((p) => typeof p !== "string" || !KEY_RE.test(p))) {
    throw new TypeError("tag key contains an invalid segment");
  }
  return parts;
}

function getAt(root, path) {
  let value = root;
  for (const part of path) {
    if (!value || typeof value !== "object" || !Object.prototype.hasOwnProperty.call(value, part)) return undefined;
    value = value[part];
  }
  return value;
}

function patchAt(path, value) {
  let out = value;
  for (let i = path.length - 1; i >= 0; i--) out = { [path[i]]: out };
  return out;
}

function assertFinite(value) {
  if (typeof value === "number" && !Number.isFinite(value)) throw new TypeError("live value contains NaN/Infinity");
  if (Array.isArray(value)) return value.forEach(assertFinite);
  if (value && typeof value === "object") Object.values(value).forEach(assertFinite);
}

function coerce(value, opts = {}) {
  if (value === undefined || value === null || !opts.type) return value;
  const type = opts.type;
  if (opts.strict) {
    const good = type === "integer" ? typeof value === "number" && Number.isInteger(value)
      : type === "number" ? typeof value === "number"
      : type === "boolean" ? typeof value === "boolean"
      : type === "string" ? typeof value === "string" : true;
    if (!good) throw new TypeError(`value is not a strict ${type}`);
  }
  if (type === "boolean" && (typeof value === "boolean" || typeof value === "number")) return Boolean(value);
  return value;
}

class TagClient {
  constructor(transport) {
    this.transport = transport;
    this._cache = null;
    this._cacheVersion = 0;
    this._subs = new Set();
    this._unsubscribe = null;
    this._seeded = false;
  }

  _resolvePath(key, opts = {}) {
    const tag = pathParts(key);
    if (opts.global) return tag;
    let appKey;
    if (Object.prototype.hasOwnProperty.call(opts, "appKey")) {
      appKey = opts.appKey;
      if (typeof appKey !== "string" || !KEY_RE.test(appKey)) throw new TypeError("invalid app key");
    } else {
      appKey = this.transport.appKey();
      if (typeof appKey !== "string" || !KEY_RE.test(appKey)) throw new TypeError("transport has no valid app key");
    }
    return [appKey, ...tag];
  }

  async _currentValues() {
    if (this._unsubscribe && this._cache !== null) return this._cache;
    const before = this._cacheVersion;
    const fetched = (await this.transport.getAggregate(TAG_CHANNEL_NAME)) || {};
    if (this._cacheVersion === before) {
      this._cache = clone(fetched);
      this._cacheVersion++;
    }
    return this._cache || {};
  }

  _ensureSubscription() {
    if (this._unsubscribe) return;
    this._unsubscribe = this.transport.subscribe(TAG_CHANNEL_NAME, (message) => {
      if (message.event !== "sync" && message.event !== "aggregate") return;
      const next = clone(message.aggregate ?? message.payload ?? {});
      const old = this._cache;
      const initial = !this._seeded;
      this._cache = next;
      this._cacheVersion++;
      this._seeded = true;
      for (const sub of [...this._subs]) {
        const nv = getAt(next, sub.path);
        const pv = old === null ? undefined : getAt(old, sub.path);
        if ((initial && sub.opts.emitInitial && nv !== undefined) || (!initial && !deepEqual(nv, pv))) {
          queueMicrotask(() => {
            try { sub.callback(clone(coerce(nv, sub.opts)), clone(coerce(pv, sub.opts))); } catch (_err) { /* isolate subscribers */ }
          });
        }
      }
    });
  }

  async getTag(key, opts = {}) {
    const values = await this._currentValues();
    const value = getAt(values, this._resolvePath(key, opts));
    return clone(coerce(value === undefined ? opts.default : value, opts));
  }

  async setTag(key, value, opts = {}) {
    if (value === undefined) throw new TypeError("tag value cannot be undefined");
    const path = this._resolvePath(key, opts);
    if (opts.live) {
      assertFinite(value);
      await this.transport.sendOneShot(LIVE_TAG_CHANNEL_NAME, { [path.join(".")]: clone(value) });
      return;
    }
    const current = await this._currentValues();
    if (opts.onlyIfChanged !== false && deepEqual(getAt(current, path), value)) return;
    const patch = patchAt(path, clone(value));
    await this.transport.publish(TAG_CHANNEL_NAME, patch, {
      recordLog: !!opts.log,
      maxAge: opts.maxAge ?? DEFAULT_MAX_AGE_SECS,
    });
    this._cache = applyDiff(current, patch);
    this._cacheVersion++;
  }

  async setTags(values, opts = {}) {
    let patch = {};
    const current = await this._currentValues();
    for (const [key, value] of Object.entries(values || {})) {
      if (value === undefined) throw new TypeError("tag value cannot be undefined");
      const path = this._resolvePath(key, opts);
      if (opts.onlyIfChanged !== false && deepEqual(getAt(current, path), value)) continue;
      patch = applyDiff(patch, patchAt(path, clone(value)), { doDelete: false });
    }
    if (!Object.keys(patch).length) return;
    await this.transport.publish(TAG_CHANNEL_NAME, patch, { recordLog: !!opts.log, maxAge: opts.maxAge ?? DEFAULT_MAX_AGE_SECS });
    this._cache = applyDiff(current, patch);
    this._cacheVersion++;
  }

  deleteTag(key, opts = {}) { return this.setTag(key, null, { ...opts, onlyIfChanged: false }); }

  subscribeTag(key, callback, opts = {}) {
    const sub = { path: this._resolvePath(key, opts), callback, opts };
    this._subs.add(sub);
    this._ensureSubscription();
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this._subs.delete(sub);
      if (!this._subs.size && this._unsubscribe) {
        this._unsubscribe();
        this._unsubscribe = null;
        this._seeded = false;
      }
    };
  }
}

module.exports = { TagClient, TAG_CHANNEL_NAME, LIVE_TAG_CHANNEL_NAME, DEFAULT_MAX_AGE_SECS };

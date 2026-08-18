"use strict";

const KEY_RE = /^[A-Za-z0-9_-]+$/;

function validatePayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("payload must be an object");
  }
  const visit = (value, path) => {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new TypeError(`${path || "payload"} contains NaN/Infinity`);
    }
    if (Array.isArray(value)) return value.forEach((v, i) => visit(v, `${path}[${i}]`));
    if (!value || typeof value !== "object") return;
    for (const key of Object.keys(value)) {
      if (!KEY_RE.test(key)) throw new TypeError(`invalid key "${key}"`);
      if (value[key] === undefined) throw new TypeError(`${path}.${key} is undefined`);
      visit(value[key], path ? `${path}.${key}` : key);
    }
  };
  visit(payload, "");
  return payload;
}

module.exports = { validatePayload, KEY_RE };

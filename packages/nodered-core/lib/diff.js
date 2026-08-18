"use strict";

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a === "boolean" && typeof b === "number") return Number(a) === b;
  if (typeof b === "boolean" && typeof a === "number") return a === Number(b);
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length &&
      a.every((v, i) => deepEqual(v, b[i]));
  }
  if (!isObject(a) || !isObject(b)) return false;
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  return ak.length === bk.length && ak.every((k) => hasOwn(b, k) && deepEqual(a[k], b[k]));
}

function clone(v) {
  if (Array.isArray(v)) return v.map(clone);
  if (!isObject(v)) return v;
  const out = {};
  for (const k of Object.keys(v)) Object.defineProperty(out, k, {
    value: clone(v[k]), enumerable: true, configurable: true, writable: true,
  });
  return out;
}

function applyDiff(target, diff, { doDelete = true } = {}) {
  if (!isObject(diff)) return clone(diff);
  if (!isObject(target)) return clone(diff);
  const out = clone(target);
  for (const key of Object.keys(diff)) {
    const value = diff[key];
    if (value === null && doDelete) {
      delete out[key];
    } else if (isObject(value) && isObject(target[key])) {
      Object.defineProperty(out, key, { value: applyDiff(target[key], value, { doDelete }), enumerable: true, configurable: true, writable: true });
    } else {
      Object.defineProperty(out, key, { value: clone(value), enumerable: true, configurable: true, writable: true });
    }
  }
  return out;
}

function generateDiff(oldValue, newValue, { doDelete = false } = {}) {
  if (!isObject(newValue)) return deepEqual(oldValue, newValue) ? {} : clone(newValue);
  if (!isObject(oldValue)) return clone(newValue);
  const out = {};
  for (const key of Object.keys(newValue)) {
    if (isObject(newValue[key]) && (isObject(oldValue[key]) || !hasOwn(oldValue, key))) {
      const sub = generateDiff(isObject(oldValue[key]) ? oldValue[key] : {}, newValue[key], { doDelete });
      if (!isObject(sub) || Object.keys(sub).length) Object.defineProperty(out, key, { value: sub, enumerable: true, configurable: true, writable: true });
    } else if (!deepEqual(oldValue[key], newValue[key])) {
      Object.defineProperty(out, key, { value: clone(newValue[key]), enumerable: true, configurable: true, writable: true });
    }
  }
  if (doDelete) {
    for (const key of Object.keys(oldValue)) {
      if (!hasOwn(newValue, key)) Object.defineProperty(out, key, { value: null, enumerable: true, configurable: true, writable: true });
    }
  }
  return out;
}

module.exports = { applyDiff, generateDiff, deepEqual, clone };

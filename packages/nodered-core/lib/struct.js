"use strict";

function valueToWire(value) {
  if (value === null) return { null_value: "NULL_VALUE" };
  if (typeof value === "string") return { string_value: value };
  if (typeof value === "boolean") return { bool_value: value };
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("NaN/Infinity cannot be encoded");
    return { number_value: value };
  }
  if (Array.isArray(value)) return { list_value: { values: value.map(valueToWire) } };
  if (value && typeof value === "object") return { struct_value: jsToStruct(value) };
  throw new TypeError(`unsupported value type: ${typeof value}`);
}

function jsToStruct(value) {
  const fields = {};
  for (const [key, item] of Object.entries(value || {})) {
    if (item !== undefined) fields[key] = valueToWire(item);
  }
  return { fields };
}

function wireToValue(value = {}) {
  const kind = value.kind || Object.keys(value).find((k) => k.endsWith("_value") || k.endsWith("Value"));
  const snake = kind && kind.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
  const get = (name) => value[name] !== undefined ? value[name] : value[name.replace(/_([a-z])/g, (_, c) => c.toUpperCase())];
  switch (snake) {
    case "null_value": return null;
    case "string_value": return get("string_value");
    case "number_value": return get("number_value");
    case "bool_value": return get("bool_value");
    case "struct_value": return structToJs(get("struct_value"));
    case "list_value": return (get("list_value")?.values || []).map(wireToValue);
    default: return undefined;
  }
}

function structToJs(struct) {
  const out = {};
  for (const [key, value] of Object.entries(struct?.fields || {})) out[key] = wireToValue(value);
  return out;
}

module.exports = { jsToStruct, structToJs };

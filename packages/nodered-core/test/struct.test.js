"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { jsToStruct, structToJs } = require("../lib/struct");

test("jsToStruct encodes scalars, nested objects and arrays", () => {
  const struct = jsToStruct({
    s: "hi",
    n: 42,
    b: true,
    z: null,
    nested: { inner: 1 },
    arr: [1, "two", false],
  });
  assert.deepEqual(struct.fields.s, { string_value: "hi" });
  assert.deepEqual(struct.fields.n, { number_value: 42 });
  assert.deepEqual(struct.fields.b, { bool_value: true });
  assert.deepEqual(struct.fields.z, { null_value: "NULL_VALUE" });
  assert.deepEqual(struct.fields.nested, {
    struct_value: { fields: { inner: { number_value: 1 } } },
  });
  assert.deepEqual(struct.fields.arr, {
    list_value: {
      values: [
        { number_value: 1 },
        { string_value: "two" },
        { bool_value: false },
      ],
    },
  });
});

test("jsToStruct drops undefined properties", () => {
  const struct = jsToStruct({ a: 1, b: undefined });
  assert.deepEqual(Object.keys(struct.fields), ["a"]);
});

test("jsToStruct rejects NaN/Infinity", () => {
  assert.throws(() => jsToStruct({ x: NaN }));
  assert.throws(() => jsToStruct({ x: Infinity }));
});

test("structToJs decodes the wire form (kind discriminator, snake_case)", () => {
  const wire = {
    fields: {
      s: { kind: "string_value", string_value: "hi" },
      n: { kind: "number_value", number_value: 3.5 },
      b: { kind: "bool_value", bool_value: false },
      z: { kind: "null_value", null_value: "NULL_VALUE" },
      nested: {
        kind: "struct_value",
        struct_value: { fields: { inner: { kind: "number_value", number_value: 1 } } },
      },
      arr: {
        kind: "list_value",
        list_value: {
          values: [
            { kind: "number_value", number_value: 1 },
            { kind: "string_value", string_value: "x" },
          ],
        },
      },
    },
  };
  assert.deepEqual(structToJs(wire), {
    s: "hi",
    n: 3.5,
    b: false,
    z: null,
    nested: { inner: 1 },
    arr: [1, "x"],
  });
});

test("structToJs tolerates camelCase field names", () => {
  const wire = { fields: { a: { kind: "stringValue", stringValue: "y" } } };
  assert.deepEqual(structToJs(wire), { a: "y" });
});

test("structToJs of empty/undefined -> {}", () => {
  assert.deepEqual(structToJs(undefined), {});
  assert.deepEqual(structToJs({ fields: {} }), {});
});

test("round-trip js -> struct -> js is stable", () => {
  const obj = { a: 1, b: { c: [true, null, "x"] }, d: 2.5 };
  assert.deepEqual(structToJs(jsToStruct(obj)), obj);
});

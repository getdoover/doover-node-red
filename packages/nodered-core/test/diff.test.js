"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { applyDiff, generateDiff, deepEqual } = require("../lib/diff");

test("applyDiff deep-merges nested objects without mutating inputs", () => {
  const target = { a: { x: 1 }, b: 2 };
  const diff = { a: { y: 3 }, c: 4 };
  const out = applyDiff(target, diff);
  assert.deepEqual(out, { a: { x: 1, y: 3 }, b: 2, c: 4 });
  // inputs untouched
  assert.deepEqual(target, { a: { x: 1 }, b: 2 });
});

test("applyDiff null deletes a key when doDelete (default)", () => {
  const out = applyDiff({ a: 1, b: 2 }, { b: null });
  assert.deepEqual(out, { a: 1 });
});

test("applyDiff retains null when doDelete=false", () => {
  const out = applyDiff({ a: 1, b: 2 }, { b: null }, { doDelete: false });
  assert.deepEqual(out, { a: 1, b: null });
});

test("applyDiff replaces arrays/scalars wholesale", () => {
  const out = applyDiff({ a: [1, 2], b: 1 }, { a: [3], b: "x" });
  assert.deepEqual(out, { a: [3], b: "x" });
});

test("generateDiff emits only changed/added leaves", () => {
  const diff = generateDiff({ a: 1, b: 2 }, { a: 1, b: 3, c: 4 });
  assert.deepEqual(diff, { b: 3, c: 4 });
});

test("generateDiff on unchanged input is empty (no-fire semantics)", () => {
  const diff = generateDiff({ a: { b: 1 } }, { a: { b: 1 } });
  assert.deepEqual(diff, {});
});

test("generateDiff doDelete=false omits deletions; true emits null", () => {
  assert.deepEqual(
    generateDiff({ a: 1, b: 2 }, { a: 1 }, { doDelete: false }),
    {}
  );
  assert.deepEqual(generateDiff({ a: 1, b: 2 }, { a: 1 }, { doDelete: true }), {
    b: null,
  });
});

test("generateDiff nested sub-diff only included when non-empty", () => {
  const diff = generateDiff(
    { app: { keep: 1, change: 1 } },
    { app: { keep: 1, change: 2 } }
  );
  assert.deepEqual(diff, { app: { change: 2 } });
});

test("deepEqual handles arrays and nested objects", () => {
  assert.ok(deepEqual([1, { a: 2 }], [1, { a: 2 }]));
  assert.ok(!deepEqual([1, 2], [1, 2, 3]));
  assert.ok(!deepEqual({ a: 1 }, { a: 2 }));
});

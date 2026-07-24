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

// --- pyEqual / Python `==` leaf semantics (differential-fuzzer contract) -----
// pydoover's generate_diff compares leaves with Python `!=`, where bool ⊂ int:
// False==0, True==1 (by numeric value), but cross-family values are never equal.
// A strict `===` here would spuriously emit a false→0 / true→1 flip as a change.

test("deepEqual: bool/number interoperate by numeric value (bool ⊂ int)", () => {
  assert.ok(deepEqual(false, 0));
  assert.ok(deepEqual(true, 1));
  assert.ok(deepEqual(false, 0.0));
  assert.ok(deepEqual(true, 1.0));
  assert.ok(!deepEqual(true, 2)); // True != 2
  assert.ok(deepEqual([false, true], [0, 1])); // list == is element-wise
});

test("deepEqual: cross-family leaves are never equal (Python semantics)", () => {
  assert.ok(!deepEqual("", 0)); // '' != 0
  assert.ok(!deepEqual(null, false)); // None != False
  assert.ok(!deepEqual(null, 0)); // None != 0
  assert.ok(!deepEqual("1", 1)); // str != int
  assert.ok(!deepEqual({ a: 1 }, [1])); // dict != list
  assert.ok(!deepEqual(0, [])); // scalar != list
});

test("generateDiff omits a false→0 (and true→1) leaf flip", () => {
  // The exact falsy cross-type divergence the differential fuzzer caught: pydoover
  // treats False==0 as equal, so the key is NOT emitted.
  assert.deepEqual(generateDiff({ battery: false }, { battery: 0 }), {});
  assert.deepEqual(generateDiff({ ok: true }, { ok: 1 }), {});
  // but '' → 0 IS a change (cross-family), and true → 2 IS a change.
  assert.deepEqual(generateDiff({ s: "" }, { s: 0 }), { s: 0 });
  assert.deepEqual(generateDiff({ n: true }, { n: 2 }), { n: 2 });
});

// --- object-value pruning (generateDiff must match pydoover recursion) --------

test("generateDiff prunes an empty/missing-slot sub-object to nothing", () => {
  // old missing the key, new adds an empty (or all-unchanged) object: pydoover
  // recurses with old.get(k, {}) and only includes a non-empty sub-diff.
  assert.deepEqual(generateDiff({}, { a: {} }), {});
  assert.deepEqual(generateDiff({ a: { x: 1 } }, { a: { x: 1 } }), {});
});

test("generateDiff over an old scalar vs new object returns the object verbatim", () => {
  // old[k] is a scalar, new[k] is an object: pydoover's inner generate_diff sees
  // a non-dict old and returns `new` wholesale.
  assert.deepEqual(generateDiff({ a: 1 }, { a: { b: 2 } }), { a: { b: 2 } });
});

// --- applyDiff null-retention through a scalar slot ---------------------------

test("applyDiff into a scalar slot returns the diff subtree verbatim (nulls kept)", () => {
  // target[k] is a scalar, diff[k] is an object: pydoover passes the scalar into
  // the recursion, which short-circuits and returns the diff subtree with its
  // nulls intact — even under doDelete:true (a fresh {} base would strip them).
  const out = applyDiff({ a: 1 }, { a: { b: null } }, { doDelete: true });
  assert.deepEqual(out, { a: { b: null } });
});

// --- __proto__ as a literal key (must not hit the prototype accessor) --------

test("generateDiff/applyDiff round-trip a literal __proto__ key", () => {
  // Build via JSON.parse so __proto__ is a real own property, not the accessor.
  const oldObj = JSON.parse('{"a":1}');
  const newObj = JSON.parse('{"a":1,"__proto__":{"x":2}}');
  const diff = generateDiff(oldObj, newObj);
  assert.ok(
    Object.prototype.hasOwnProperty.call(diff, "__proto__"),
    "__proto__ must survive as an own property in the diff"
  );
  assert.deepEqual(diff["__proto__"], { x: 2 });
  // Prototype pollution did NOT occur.
  assert.equal(Object.getPrototypeOf(diff), Object.prototype);
  assert.equal({}.x, undefined);

  const merged = applyDiff(JSON.parse('{"a":1}'), diff);
  assert.ok(Object.prototype.hasOwnProperty.call(merged, "__proto__"));
  assert.deepEqual(merged["__proto__"], { x: 2 });
  assert.equal(Object.getPrototypeOf(merged), Object.prototype);
});

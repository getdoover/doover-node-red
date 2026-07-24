"use strict";

/**
 * Seeded PRNG case generator for differential fuzzing of the ported diff/tag
 * engine against pydoover. Every case is a pure function of (seed, index,
 * target), so any reported mismatch reproduces exactly.
 *
 * Cases travel to both sides as a single canonical JSON text (run.js parses it
 * with JSON.parse and hands the SAME text to the Python driver on stdin). This
 * is deliberate: it makes numeric-representation limits (2^53+1 collapsing in
 * IEEE-754, -0 → 0 under JSON) identical on both sides, so the fuzzer tests the
 * *algorithm*, not the JSON number model.
 */

// --- PRNG --------------------------------------------------------------------

/**
 * mulberry32 — small, fast, deterministic 32-bit PRNG.
 * @param {number} a seed
 * @returns {() => number} function yielding floats in [0,1)
 */
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Cheap string hash (FNV-1a) so a target name folds into the seed.
 * @param {string} s
 * @returns {number}
 */
function hashStr(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Mix three integers into one seed.
 * @param {number} a @param {number} b @param {number} c @returns {number}
 */
function mix(a, b, c) {
  let h = (a ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ b, 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ c, 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

// --- value pools -------------------------------------------------------------

const HUGE_STRING = "𝒹𝑜𝑜𝓋𝑒𝓇".repeat(600); // ~4200 code units of astral unicode

/**
 * Scalar (leaf) value pool — includes all the required nasty numeric edges and
 * unicode/empty strings. NaN/Infinity are intentionally omitted (not
 * JSON-representable; both sides would only ever see `null`).
 */
const SCALARS = [
  null,
  true,
  false,
  0,
  -0,
  1,
  -1,
  42,
  -42,
  Number.MAX_SAFE_INTEGER, // 2^53 - 1
  9007199254740992, // 2^53
  9007199254740993, // 2^53 + 1  (collapses to 2^53 in IEEE-754 — same on both sides)
  -9007199254740992, // -(2^53)
  0.1,
  -0.1,
  3.141592653589793,
  1e-10,
  1e21,
  -1.5,
  2.5,
  "",
  "x",
  "hello",
  "null",
  "123",
  "true",
  "日本語🔥",
  "a.b.c",
  "  ",
  HUGE_STRING,
];

/**
 * Keys allowed anywhere inside DATA objects — includes the nasty ones the diff
 * engine must survive: empty string, dotted, spaced, unicode. (`__proto__`,
 * `constructor`, `prototype` are excluded: they probe the JS object model, not
 * the port's algorithm, and JSON.parse-created own-props there would only
 * measure engine quirks.)
 */
const DATA_KEYS = [
  "a",
  "b",
  "c",
  "x",
  "temperature",
  "battery",
  "voltage",
  "status",
  "",
  "a.b",
  "1",
  "_",
  "-",
  "k-1",
  "k_2",
  "Ω",
  "温度",
  "🔥",
  "ключ",
  "key space",
];

/**
 * Keys usable as KEYPATH SEGMENTS. pydoover's KeyPath forbids empty/non-string
 * segments (constructor raises); its JS analogue validates in a different layer
 * (TagClient._resolvePath), so to compare the pure path ops apples-to-apples we
 * drive them only with valid non-empty string segments. Dotted ("a.b") is
 * included deliberately — KeyPath must NOT split on dots (tags-contract §2.3).
 */
const PATH_SEGS = DATA_KEYS.filter((k) => k !== "");

// --- generators --------------------------------------------------------------

/** @param {() => number} rng @param {any[]} pool */
function pick(rng, pool) {
  return pool[Math.floor(rng() * pool.length)];
}

/**
 * Random JSON-shaped value.
 * @param {() => number} rng
 * @param {number} depth remaining depth budget
 * @returns {unknown}
 */
function randValue(rng, depth) {
  if (depth <= 0 || rng() < 0.42) {
    return pick(rng, SCALARS);
  }
  const r = rng();
  if (r < 0.22) {
    // array (incl. empty, nested arrays, arrays of objects)
    const n = Math.floor(rng() * 5);
    const arr = [];
    for (let i = 0; i < n; i++) arr.push(randValue(rng, depth - 1));
    return arr;
  }
  return randObject(rng, depth);
}

/**
 * Random object (0..5 keys; empty objects occur naturally).
 * @param {() => number} rng @param {number} depth
 * @returns {Record<string, unknown>}
 */
function randObject(rng, depth) {
  const n = Math.floor(rng() * 6);
  /** @type {Record<string, unknown>} */
  const o = {};
  for (let i = 0; i < n; i++) {
    o[pick(rng, DATA_KEYS)] = randValue(rng, depth - 1);
  }
  return o;
}

/**
 * A deliberately deep linear nest (>10 levels) — the required deep-nesting case.
 * @param {() => number} rng
 * @returns {Record<string, unknown>}
 */
function deepChain(rng) {
  const levels = 11 + Math.floor(rng() * 6); // 11..16
  /** @type {unknown} */
  let v = pick(rng, SCALARS);
  for (let i = 0; i < levels; i++) {
    v = { [pick(rng, PATH_SEGS)]: v };
  }
  return /** @type {any} */ (v);
}

/**
 * Structurally-related mutation of `val` — produces overlapping shapes so the
 * diff hits its nastiest branches (scalar↔object type flips, empty-object
 * slots, null-leaf deletes, added/removed keys).
 * @param {() => number} rng
 * @param {unknown} val
 * @param {number} depth
 * @param {boolean} injectNull bias towards null leaves (for apply-diff diffs)
 * @returns {unknown}
 */
function mutate(rng, val, depth, injectNull) {
  const r = rng();
  if (r < 0.12) return randValue(rng, depth); // wholesale replace (may flip type)
  if (r < 0.17) return {}; // collapse to empty object (nasty for generateDiff)
  if (r < 0.22 && injectNull) return null; // explicit delete leaf

  if (Array.isArray(val)) {
    if (rng() < 0.5) return randValue(rng, depth);
    return val.map((x) => mutate(rng, x, depth - 1, injectNull));
  }
  if (val && typeof val === "object") {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [k, v] of Object.entries(val)) {
      const rr = rng();
      if (rr < 0.2) continue; // drop key (surfaces as delete under do_delete)
      if (rr < 0.35) {
        out[k] = injectNull && rng() < 0.5 ? null : pick(rng, SCALARS); // flip to scalar/null
      } else if (rr < 0.5) {
        out[k] = { [pick(rng, PATH_SEGS)]: injectNull ? null : pick(rng, SCALARS) }; // flip to object (maybe null leaf)
      } else {
        out[k] = mutate(rng, v, depth - 1, injectNull);
      }
    }
    // add some new keys
    const add = Math.floor(rng() * 3);
    for (let i = 0; i < add; i++) {
      out[pick(rng, DATA_KEYS)] = randValue(rng, depth - 1);
    }
    return out;
  }
  // scalar
  if (rng() < 0.4) return val;
  if (injectNull && rng() < 0.3) return { [pick(rng, PATH_SEGS)]: null }; // scalar → object-with-null
  return pick(rng, SCALARS);
}

/**
 * A random path (1..4 valid segments).
 * @param {() => number} rng
 * @returns {string[]}
 */
function randPath(rng) {
  const n = 1 + Math.floor(rng() * 4);
  const p = [];
  for (let i = 0; i < n; i++) p.push(pick(rng, PATH_SEGS));
  return p;
}

/**
 * Build an object that (often) contains `path`, so lookup/in_dict actually
 * resolve part or all of the time.
 * @param {() => number} rng @param {string[]} path @param {number} depth
 */
function objAlongPath(rng, path, depth) {
  const base = randObject(rng, depth);
  if (rng() < 0.55) {
    // graft the path (full or a prefix) with a random leaf
    const cut = 1 + Math.floor(rng() * path.length);
    /** @type {unknown} */
    let leaf = rng() < 0.3 ? randObject(rng, 2) : pick(rng, SCALARS);
    for (let i = cut - 1; i >= 0; i--) leaf = { [path[i]]: leaf };
    // shallow-merge graft into base
    Object.assign(base, leaf);
  }
  return base;
}

// --- top-level case builders -------------------------------------------------

/** @param {() => number} rng @returns {number} random small depth, sometimes deep */
function randDepth(rng) {
  return 2 + Math.floor(rng() * 5); // 2..6
}

/**
 * Build one case for a target. Deterministic in (seed,index,target).
 * @param {number} seed
 * @param {number} index
 * @param {string} target
 * @returns {{target: string, args: object}}
 */
function genCase(seed, index, target) {
  const rng = mulberry32(mix(seed >>> 0, index >>> 0, hashStr(target)));
  const deep = rng() < 0.06;

  switch (target) {
    case "generateDiff": {
      const old = rng() < 0.08 ? pick(rng, SCALARS) : deep ? deepChain(rng) : randObject(rng, randDepth(rng));
      const nw =
        rng() < 0.08
          ? pick(rng, SCALARS)
          : rng() < 0.7
            ? mutate(rng, old, randDepth(rng), false)
            : randObject(rng, randDepth(rng));
      return { target, args: { old, new: nw, doDelete: rng() < 0.5 } };
    }
    case "applyDiff": {
      const data = rng() < 0.08 ? pick(rng, SCALARS) : deep ? deepChain(rng) : randObject(rng, randDepth(rng));
      const diff =
        rng() < 0.08
          ? pick(rng, SCALARS)
          : rng() < 0.75
            ? mutate(rng, data, randDepth(rng), true)
            : randObject(rng, randDepth(rng));
      return { target, args: { data, diff, doDelete: rng() < 0.5 } };
    }
    case "constructDict": {
      const path = randPath(rng);
      const value = deep ? deepChain(rng) : randValue(rng, randDepth(rng));
      return { target, args: { path, value } };
    }
    case "lookupDict":
    case "inDict": {
      const path = randPath(rng);
      const obj = rng() < 0.1 ? pick(rng, SCALARS) : objAlongPath(rng, path, randDepth(rng));
      return { target, args: { obj, path } };
    }
    case "setTagPayload": {
      const appKey = rng() < 0.5 ? pick(rng, PATH_SEGS) : null; // null = global namespace
      const key = randPath(rng);
      const value = rng() < 0.15 ? null : randValue(rng, randDepth(rng)); // null = delete
      const current = deep ? deepChain(rng) : randObject(rng, randDepth(rng));
      return { target, args: { appKey, key, value, current } };
    }
    default:
      throw new Error(`unknown target: ${target}`);
  }
}

const TARGETS = [
  "generateDiff",
  "applyDiff",
  "constructDict",
  "lookupDict",
  "inDict",
  "setTagPayload",
];

module.exports = { genCase, TARGETS, mulberry32, hashStr, mix };

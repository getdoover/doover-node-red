"use strict";

/**
 * Differential fuzzing harness.
 *
 * Generates seeded cases (gen.js), runs the ported JS implementation locally
 * (packages/nodered-core/lib/{diff,tags}.js) AND the pydoover reference
 * (py-driver.py, spawned via `uv run --project`), then deep-compares the two
 * results per case. pydoover is the contract — any mismatch is a JS-side finding.
 *
 * Usage:
 *   node run.js [--target <name>|all] [--count N] [--seed S]
 *               [--max-mismatch K] [--only <index>] [--verbose]
 *
 * The SAME canonical JSON text is fed to both sides (JS re-parses it before
 * calling), so IEEE-754 / JSON number limits are identical on both sides and the
 * test isolates algorithm behaviour.
 */

const path = require("path");
const { spawn } = require("child_process");
const readline = require("readline");

const { genCase, TARGETS } = require("./gen");

// How many mismatch samples to collect for the report. Decoupled from the
// pass/fail tolerance (`--max-mismatch`) so a zero-tolerance run (the shipping
// default) still prints reproducible repros for the first divergences instead
// of failing silently with no detail.
const DISPLAY_CAP = 25;

const CORE = path.resolve(
  __dirname,
  "../../packages/nodered-core/lib"
);
const diff = require(path.join(CORE, "diff.js"));
const tags = require(path.join(CORE, "tags.js"));

const PYDOOVER = "/Users/tomwyatt/pydoover";

// --- argv --------------------------------------------------------------------

function parseArgs(argv) {
  const a = {
    target: "all",
    count: 5000,
    seed: 0x1234abcd,
    // Tolerance threshold: the run FAILS when total mismatches exceed this.
    // Zero tolerance by default — JS must agree with pydoover byte-for-byte.
    maxMismatch: 0,
    only: null,
    verbose: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--target") a.target = argv[++i];
    else if (k === "--count") a.count = parseInt(argv[++i], 10);
    else if (k === "--seed") a.seed = parseInt(argv[++i], 10) >>> 0;
    else if (k === "--max-mismatch") a.maxMismatch = parseInt(argv[++i], 10);
    else if (k === "--only") a.only = parseInt(argv[++i], 10);
    else if (k === "--verbose") a.verbose = true;
    else throw new Error(`unknown arg: ${k}`);
  }
  return a;
}

// --- JS side (mirror of py-driver.handle) ------------------------------------

/**
 * @param {string} target
 * @param {any} args
 * @returns {unknown}
 */
function runJs(target, args) {
  switch (target) {
    case "generateDiff":
      return diff.generateDiff(args.old, args.new, { doDelete: !!args.doDelete });
    case "applyDiff":
      return diff.applyDiff(args.data, args.diff, {
        doDelete: !!args.doDelete,
        clone: true,
      });
    case "constructDict":
      return tags.constructDict(args.path, args.value);
    case "lookupDict":
      return tags.lookupDict(args.obj, args.path);
    case "inDict":
      return tags.inDict(args.obj, args.path);
    case "setTagPayload": {
      const segs = args.appKey != null ? [args.appKey, ...args.key] : args.key.slice();
      let writeDict = {};
      writeDict = /** @type {any} */ (
        diff.applyDiff(writeDict, tags.constructDict(segs, args.value), {
          doDelete: false,
        })
      );
      return diff.generateDiff(args.current, writeDict, { doDelete: false });
    }
    default:
      throw new Error(`unknown target: ${target}`);
  }
}

// --- comparison --------------------------------------------------------------

function isPlainObj(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Deep equality between a JS result and the JSON-parsed Python result.
 * Legitimate normalisations only: undefined→null (Python can't produce
 * undefined; its `None` maps to null), object key order ignored, -0 === 0,
 * int/float unified (both arrive as JS numbers via JSON). No tolerance is
 * applied that could mask a real value difference.
 */
function deepEq(a, b) {
  if (a === undefined) a = null;
  if (b === undefined) b = null;
  if (a === null || b === null) return a === b;
  const ta = typeof a;
  const tb = typeof b;
  if (ta === "number" || tb === "number") return ta === tb && a === b; // -0===0
  if (ta === "boolean" || tb === "boolean") return a === b;
  if (ta === "string" || tb === "string") return a === b;
  const aArr = Array.isArray(a);
  const bArr = Array.isArray(b);
  if (aArr || bArr) {
    if (!aArr || !bArr || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEq(a[i], b[i])) return false;
    return true;
  }
  if (isPlainObj(a) && isPlainObj(b)) {
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    for (const k of ak) {
      if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
      if (!deepEq(a[k], b[k])) return false;
    }
    return true;
  }
  return false;
}

// --- driver ------------------------------------------------------------------

function shorten(s, n = 600) {
  return s.length > n ? s.slice(0, n) + `…(+${s.length - n} chars)` : s;
}

async function main() {
  const opts = parseArgs(process.argv);
  const targets = opts.target === "all" ? TARGETS : [opts.target];
  for (const t of targets) {
    if (!TARGETS.includes(t)) throw new Error(`unknown target: ${t}`);
  }

  // Build every case up front (deterministic), computing the JS result now.
  /** @type {Map<number, {target:string, index:number, args:any, text:string, js:{ok:boolean,result?:unknown,error?:string}}>} */
  const meta = new Map();
  const lines = [];
  let gid = 0;
  for (const target of targets) {
    const indices = opts.only != null ? [opts.only] : range(opts.count);
    for (const index of indices) {
      const c = genCase(opts.seed, index, target);
      // Canonicalise: the exact text both sides consume.
      const text = JSON.stringify(c.args);
      const argsParsed = JSON.parse(text);
      let js;
      try {
        js = { ok: true, result: runJs(target, argsParsed) };
      } catch (e) {
        js = { ok: false, error: `${e.constructor.name}: ${e.message}` };
      }
      const id = gid++;
      meta.set(id, { target, index, args: argsParsed, text, js });
      lines.push(JSON.stringify({ id, target, args: argsParsed }));
    }
  }

  const py = spawn(
    "uv",
    ["run", "--project", PYDOOVER, "python", "py-driver.py"],
    { cwd: __dirname, stdio: ["pipe", "pipe", "inherit"] }
  );

  const rl = readline.createInterface({ input: py.stdout });

  /** @type {{target:string,index:number,args:any,js:any,py:any}[]} */
  const mismatches = [];
  /** @type {Record<string, {total:number, mism:number}>} */
  const stats = {};
  for (const t of targets) stats[t] = { total: 0, mism: 0 };
  let received = 0;

  rl.on("line", (line) => {
    line = line.trim();
    if (!line) return;
    let pres;
    try {
      pres = JSON.parse(line);
    } catch (e) {
      // Non-JSON noise on stdout (should not happen) — surface it.
      process.stderr.write(`[run] non-JSON from driver: ${shorten(line)}\n`);
      return;
    }
    received++;
    const m = meta.get(pres.id);
    if (!m) return;
    stats[m.target].total++;

    let ok;
    if (m.js.ok && pres.ok) {
      ok = deepEq(m.js.result, pres.result);
    } else if (!m.js.ok && !pres.ok) {
      ok = true; // both raised — treat as agreement (input rejected by both)
    } else {
      ok = false; // one raised, the other didn't
    }

    if (!ok) {
      stats[m.target].mism++;
      if (mismatches.length < DISPLAY_CAP) {
        mismatches.push({
          target: m.target,
          index: m.index,
          args: m.args,
          js: m.js.ok ? m.js.result : `<error> ${m.js.error}`,
          py: pres.ok ? pres.result : `<error> ${pres.error}`,
        });
      }
    }
  });

  // stream cases
  for (const l of lines) py.stdin.write(l + "\n");
  py.stdin.end();

  const exitCode = await new Promise((resolve) => {
    let closed = 0;
    const done = () => {
      if (++closed === 2) resolve(py.exitCode);
    };
    rl.on("close", done);
    py.on("close", done);
  });

  // --- report ---------------------------------------------------------------
  const totalMism = Object.values(stats).reduce((s, x) => s + x.mism, 0);
  const totalCases = Object.values(stats).reduce((s, x) => s + x.total, 0);

  process.stdout.write("\n=== differential fuzzing report ===\n");
  process.stdout.write(
    `seed=0x${opts.seed.toString(16)} count/target=${opts.only != null ? 1 : opts.count} targets=${targets.join(",")}\n`
  );
  process.stdout.write(`driver-exit=${exitCode} cases-compared=${totalCases} responses=${received}\n\n`);
  for (const t of targets) {
    const s = stats[t];
    const flag = s.mism > 0 ? "MISMATCH" : "ok";
    process.stdout.write(
      `  ${t.padEnd(16)} ${String(s.total).padStart(6)} cases  ${String(s.mism).padStart(6)} mismatch  [${flag}]\n`
    );
  }

  if (mismatches.length) {
    process.stdout.write(`\n--- first ${mismatches.length} mismatch(es) ---\n`);
    for (const mm of mismatches) {
      process.stdout.write(
        `\n[${mm.target} index=${mm.index}]  reproduce: node run.js --target ${mm.target} --seed ${opts.seed} --only ${mm.index}\n`
      );
      process.stdout.write(`  args: ${shorten(JSON.stringify(mm.args))}\n`);
      process.stdout.write(`  JS : ${shorten(JSON.stringify(mm.js))}\n`);
      process.stdout.write(`  PY : ${shorten(JSON.stringify(mm.py))}\n`);
    }
  }

  const missing = totalCases !== meta.size;
  if (missing) {
    process.stdout.write(
      `\nWARNING: expected ${meta.size} responses, compared ${totalCases}. Driver may have crashed.\n`
    );
  }

  const fail = totalMism > opts.maxMismatch || missing || exitCode !== 0;
  process.stdout.write(
    `\nRESULT: ${fail ? "FAIL" : "PASS"} (${totalMism} mismatch across ${totalCases} cases, tolerance=${opts.maxMismatch})\n`
  );
  process.exit(fail ? 1 : 0);
}

function range(n) {
  const a = new Array(n);
  for (let i = 0; i < n; i++) a[i] = i;
  return a;
}

main().catch((e) => {
  process.stderr.write(`fatal: ${e && e.stack ? e.stack : e}\n`);
  process.exit(2);
});

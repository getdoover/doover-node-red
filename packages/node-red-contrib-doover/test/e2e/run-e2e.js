"use strict";

/**
 * LIVE end-to-end runner for the Doover Node-RED palette.
 *
 * Unlike the unit suites (which drive nodes with a MockTransport in-process),
 * this exercises the REAL stack end to end:
 *
 *   real fake-DDA server  <—TCP gate—>  DDA_WEB_URI  ←  real Node-RED child
 *        (doover-js wire contract)                       (Doover palette loaded)
 *
 * A fake DDA server (the canonical harness at
 * packages/nodered-core/test/harness/fake-dda-server.js, or the local stub if
 * that is absent — see lib/load-fake-dda.js) stands in for the on-device agent
 * and speaks exactly what the shipping DooverJsLocalTransport puts on the wire.
 * A gating TCP proxy sits in front of it so we can "kill" and "restart" the
 * agent on a stable port (scenario e). A real headless Node-RED runs the palette
 * against it, driven through the admin HTTP API, with node status and debug
 * output observed over the editor /comms websocket.
 *
 * Scenarios:
 *   (a) every examples/*.json deploys with zero error-status nodes.
 *   (b) a tag write reaches the fake server with correct <app>/<tag> namespacing,
 *       AND a tag-in subscriber fires on an injected aggregate update.
 *   (c) doover-notify and doover-message append messages without changing
 *       their channel aggregates.
 *   (d) 10x redeploy of one flow: no duplicate deliveries, no WSS-connection or
 *       subscription growth.
 *   (e) kill + restart the fake server: nodes return to green and a subsequent
 *       write succeeds.
 *
 * Waits are deterministic (poll a condition, never sleep-and-hope); every
 * scenario has a hard timeout. Run via `npm run e2e` (kept OUT of `npm test`).
 * Exit code is non-zero if any scenario fails.
 */

const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const { loadFakeDda } = require("./lib/load-fake-dda");
const { TcpGate } = require("./lib/tcp-gate");
const { NodeRedHarness } = require("./lib/node-red-harness");
const { waitFor, sleep } = require("./lib/wait");

/**
 * Poll `cond` until it has held true continuously for `stableMs` (not just at a
 * single sample), or reject at `timeoutMs`. Used where a value can flap during a
 * redeploy handoff and we must wait for it to *settle* before asserting on it —
 * this removes test-side races without masking a genuinely broken end state
 * (which never stabilises and still times out).
 * @param {() => (boolean|Promise<boolean>)} cond
 * @param {{stableMs:number, timeoutMs:number, intervalMs?:number, description?:string}} opts
 */
async function waitStable(cond, opts) {
  const intervalMs = opts.intervalMs ?? 100;
  const deadline = Date.now() + opts.timeoutMs;
  let stableSince = null;
  for (;;) {
    let ok = false;
    try {
      ok = !!(await cond());
    } catch (_e) {
      ok = false;
    }
    if (ok) {
      if (stableSince == null) {
        stableSince = Date.now();
      }
      if (Date.now() - stableSince >= opts.stableMs) {
        return;
      }
    } else {
      stableSince = null;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `waitStable timed out after ${opts.timeoutMs}ms for: ${opts.description || "condition"}`
      );
    }
    await sleep(intervalMs);
  }
}

const APP_KEY = "e2e_app";
const TAG_CHANNEL = "tag_values";
const NOTIFICATIONS_CHANNEL = "notifications";
const GENERIC_MESSAGES_CHANNEL = "e2e_messages";
const EXAMPLES_DIR = path.resolve(__dirname, "../../../../examples");

const DOOVER_CONSUMER_TYPES = new Set([
  "doover-tag-in",
  "doover-tag-get",
  "doover-tag-out",
  "doover-channel-in",
  "doover-channel-out",
  "doover-message",
  "doover-aggregate-get",
  "doover-notify",
]);

// --- tiny assert -----------------------------------------------------------

class AssertionError extends Error {}

/**
 * @param {unknown} cond
 * @param {string} msg
 * @returns {asserts cond}
 */
function assert(cond, msg) {
  if (!cond) {
    throw new AssertionError(msg);
  }
}

// --- infra helpers ---------------------------------------------------------

/** @returns {Promise<number>} an OS-assigned free TCP port. */
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = /** @type {net.AddressInfo} */ (srv.address());
      const p = addr.port;
      srv.close(() => resolve(p));
    });
  });
}

/**
 * Normalise the two possible fake-server API shapes (canonical harness vs. the
 * local stub) behind one small adapter the scenarios code against.
 * @param {any} server
 */
function makeFakeAdapter(server) {
  return {
    raw: server,
    baseUrl: () => server.baseUrl,
    connectionCount: () =>
      typeof server.connectionCount === "function"
        ? server.connectionCount()
        : typeof server.wssConnectionCount === "function"
          ? server.wssConnectionCount()
          : 0,
    subscriberCount: (ch) => server.subscriberCount(ch),
    /** Merge+broadcast an aggregate update to subscribers. */
    injectAggregate: (ch, data) => {
      if (typeof server.publishAggregate === "function") {
        server.publishAggregate(ch, data);
      } else if (typeof server.patchAggregate === "function") {
        server.patchAggregate(ch, data);
      } else {
        server.setAggregate(ch, data);
      }
    },
    /** Aggregate writes (PATCH/PUT) recorded for a channel: {method, body}. */
    getWrites: (ch) => {
      if (typeof server.getWrites === "function") {
        return server.getWrites(ch);
      }
      const calls = server.calls || [];
      return calls
        .filter(
          (c) =>
            (c.method === "PATCH" || c.method === "PUT") &&
            typeof c.path === "string" &&
            c.path.endsWith(`/channels/${ch}/aggregate`)
        )
        .map((c) => ({ method: c.method, channel: ch, body: c.body }));
    },
    /** Persisted message POSTs recorded for a channel, normalised to data. */
    getMessageWrites: (ch) => {
      const calls = server.calls || [];
      return calls
        .filter(
          (c) =>
            c.method === "POST" &&
            typeof c.path === "string" &&
            c.path.endsWith(`/channels/${ch}/messages`)
        )
        .map((c) => ({
          channel: ch,
          data: c.body?.payload?.data ?? c.body?.data ?? c.body,
        }));
    },
    setAggregate: (ch, data) => server.setAggregate(ch, data),
    getAggregate: (ch) => server.getAggregate(ch),
  };
}

// --- flow builders ---------------------------------------------------------

let _idSeq = 0;
const uid = (prefix) => `${prefix}_${Date.now().toString(36)}_${_idSeq++}`;

/** A shared local connection config node. */
function connNode(id) {
  return {
    id,
    type: "doover-connection",
    name: "e2e local",
    dooverType: "local",
    apiBase: "https://api.doover.com",
    agentId: "",
  };
}

function tabNode(id, label) {
  return { id, type: "tab", label, disabled: false, info: "" };
}

function injectNode(id, z, targetId, payload, payloadType) {
  return {
    id,
    type: "inject",
    z,
    name: "trigger",
    props: [{ p: "payload" }],
    repeat: "",
    crontab: "",
    once: false,
    onceDelay: 0.1,
    topic: "",
    payload: String(payload),
    payloadType,
    wires: [[targetId]],
  };
}

function debugNode(id, z) {
  return {
    id,
    type: "debug",
    z,
    name: "sink",
    active: true,
    tosidebar: true,
    console: false,
    tostatus: false,
    complete: "true",
    targetType: "full",
    statusVal: "",
    statusType: "auto",
    wires: [],
  };
}

function tagOutNode(id, z, connId, tag) {
  return {
    id,
    type: "doover-tag-out",
    z,
    name: tag,
    connection: connId,
    tag,
    scope: "thisApp",
    appKey: "",
    log: false,
    live: false,
    wires: [],
  };
}

function tagInNode(id, z, connId, tag, targetId) {
  return {
    id,
    type: "doover-tag-in",
    z,
    name: tag,
    connection: connId,
    tag,
    scope: "thisApp",
    appKey: "",
    emitInitial: false,
    onlyOnChange: true,
    wires: [[targetId]],
  };
}

function notifyNode(id, z, connId, targetId) {
  return {
    id,
    type: "doover-notify",
    z,
    name: "notify",
    connection: connId,
    recordActivity: false,
    wires: targetId ? [[targetId]] : [],
  };
}

function messageNode(id, z, connId, channel) {
  return {
    id,
    type: "doover-message",
    z,
    name: "message",
    connection: connId,
    channel,
    wires: [],
  };
}

// --- status helpers --------------------------------------------------------

/**
 * Extract a plain payload from a captured debug entry. Node-RED's `/comms`
 * debug frames carry `data.msg` as a JSON string (the sidebar representation),
 * so parse it when needed. Special-typed values are `__enc__`-wrapped by the
 * debug encoder; plain scalars/objects round-trip cleanly.
 * @param {{msg:any}|undefined} entry
 * @returns {any}
 */
function debugPayload(entry) {
  if (!entry) {
    return undefined;
  }
  let m = entry.msg;
  if (typeof m === "string") {
    try {
      m = JSON.parse(m);
    } catch (_e) {
      return m;
    }
  }
  return m && typeof m === "object" ? m.payload : m;
}

/** Node ids in a flow that render a Doover connection status dot. */
function dooverConsumerIds(flows) {
  return flows.filter((n) => DOOVER_CONSUMER_TYPES.has(n.type)).map((n) => n.id);
}

/**
 * Poll until every id is green (connected); throw immediately if any goes red.
 * @param {NodeRedHarness} nr
 * @param {string[]} ids
 * @param {number} timeoutMs
 */
async function waitAllGreen(nr, ids, timeoutMs) {
  await waitFor(
    () => {
      for (const id of ids) {
        const st = nr.status(id);
        if (st && st.fill === "red") {
          throw new Error(
            `node ${id} went red: ${JSON.stringify(st)}`
          );
        }
      }
      return ids.every((id) => {
        const st = nr.status(id);
        return st && st.fill === "green";
      });
    },
    { timeoutMs, intervalMs: 100, description: `nodes ${ids.join(",")} to go green` }
  );
}

// --- scenarios -------------------------------------------------------------

/**
 * (a) Every shipped example deploys clean (no red Doover node).
 * @param {{nr:NodeRedHarness, fake:ReturnType<typeof makeFakeAdapter>}} ctx
 */
async function scenarioExamplesDeploy(ctx) {
  const { nr } = ctx;
  const files = fs
    .readdirSync(EXAMPLES_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();
  assert(files.length > 0, `no example flows found in ${EXAMPLES_DIR}`);

  for (const file of files) {
    const raw = JSON.parse(fs.readFileSync(path.join(EXAMPLES_DIR, file), "utf8"));
    // Neutralise auto-firing injects so no example makes outbound side effects
    // (e.g. http-to-doover's Open-Meteo call) during a pure deploy check.
    for (const n of raw) {
      if (n.type === "inject") {
        n.once = false;
      }
    }
    nr.clearStatuses();
    await nr.deploy(raw);
    const ids = dooverConsumerIds(raw);
    assert(ids.length > 0, `${file}: expected at least one Doover node`);
    try {
      await waitAllGreen(nr, ids, 25000);
    } catch (err) {
      throw new AssertionError(
        `example ${file} did not deploy clean: ${err.message}`
      );
    }
  }
  return `deployed ${files.length} example(s) clean: ${files.join(", ")}`;
}

/**
 * (b) tag write namespacing + tag-in delivery.
 * @param {{nr:NodeRedHarness, fake:ReturnType<typeof makeFakeAdapter>}} ctx
 */
async function scenarioTagRoundTrip(ctx) {
  const { nr, fake } = ctx;
  const z = uid("tab");
  const conn = uid("conn");
  const inj = uid("inj");
  const tout = uid("tout");
  const tin = uid("tin");
  const dbg = uid("dbg");
  const flows = [
    tabNode(z, "e2e-b"),
    connNode(conn),
    injectNode(inj, z, tout, 42, "num"),
    tagOutNode(tout, z, conn, "e2e_out"),
    tagInNode(tin, z, conn, "e2e_in", dbg),
    debugNode(dbg, z),
  ];
  await nr.deploy(flows);
  await waitAllGreen(nr, [tout, tin], 20000);
  await waitFor(() => fake.subscriberCount(TAG_CHANNEL) >= 1, {
    timeoutMs: 15000,
    description: "transport to subscribe to tag_values",
  });

  // Write side: trigger the inject, expect a namespaced PATCH.
  await nr.triggerInject(inj);
  const write = await waitFor(
    () => {
      const ws = fake.getWrites(TAG_CHANNEL);
      return ws.find(
        (w) => w.body && w.body[APP_KEY] && w.body[APP_KEY].e2e_out === 42
      );
    },
    { timeoutMs: 15000, description: "namespaced tag write to reach fake DDA" }
  );
  assert(
    !Object.prototype.hasOwnProperty.call(write.body, "e2e_out"),
    `tag write not namespaced — e2e_out at root: ${JSON.stringify(write.body)}`
  );
  assert(
    write.body[APP_KEY] && write.body[APP_KEY].e2e_out === 42,
    `tag write missing ${APP_KEY}.e2e_out=42: ${JSON.stringify(write.body)}`
  );

  // Subscribe side: inject an aggregate update, expect the tag-in to fire once.
  nr.clearDebug();
  fake.injectAggregate(TAG_CHANNEL, { [APP_KEY]: { e2e_in: 7 } });
  await waitFor(() => nr.debugFor(dbg).length >= 1, {
    timeoutMs: 15000,
    description: "tag-in subscriber to fire",
  });
  const msgs = nr.debugFor(dbg);
  const payload = debugPayload(msgs[0]);
  assert(
    payload === 7,
    `tag-in delivered wrong payload: ${JSON.stringify(msgs[0] && msgs[0].msg)}`
  );
  return `namespaced write ${APP_KEY}.e2e_out=42 observed; tag-in delivered payload=7`;
}

/**
 * (c) Notification and generic persisted messages leave aggregates unchanged.
 * @param {{nr:NodeRedHarness, fake:ReturnType<typeof makeFakeAdapter>}} ctx
 */
async function scenarioNotify(ctx) {
  const { nr, fake } = ctx;
  const z = uid("tab");
  const conn = uid("conn");
  const inj = uid("inj");
  const note = uid("note");
  const messageInject = uid("message_inj");
  const message = uid("message");
  const notificationAggregate = { existing: "notification state" };
  const genericAggregate = { existing: "message state" };
  fake.setAggregate(NOTIFICATIONS_CHANNEL, notificationAggregate);
  fake.setAggregate(GENERIC_MESSAGES_CHANNEL, genericAggregate);
  const flows = [
    tabNode(z, "e2e-c"),
    connNode(conn),
    injectNode(inj, z, note, "hello e2e", "str"),
    notifyNode(note, z, conn, null),
    injectNode(
      messageInject,
      z,
      message,
      JSON.stringify({ event: "message e2e" }),
      "json"
    ),
    messageNode(message, z, conn, GENERIC_MESSAGES_CHANNEL),
  ];
  await nr.deploy(flows);
  await waitAllGreen(nr, [note, message], 20000);

  await nr.triggerInject(inj);
  const write = await waitFor(
    () => {
      const ws = fake.getMessageWrites(NOTIFICATIONS_CHANNEL);
      return ws.find((w) => w.data && "message" in w.data);
    },
    { timeoutMs: 15000, description: "notification message to be appended" }
  );
  assert(
    write.data.message === "hello e2e",
    `notify payload wrong: ${JSON.stringify(write.data)}`
  );
  assert(
    JSON.stringify(fake.getAggregate(NOTIFICATIONS_CHANNEL)) ===
      JSON.stringify(notificationAggregate),
    `notify changed the aggregate: ${JSON.stringify(fake.getAggregate(NOTIFICATIONS_CHANNEL))}`
  );

  await nr.triggerInject(messageInject);
  const genericWrite = await waitFor(
    () => fake.getMessageWrites(GENERIC_MESSAGES_CHANNEL)[0],
    { timeoutMs: 15000, description: "generic message to be appended" }
  );
  assert(
    genericWrite.data.event === "message e2e",
    `generic message payload wrong: ${JSON.stringify(genericWrite.data)}`
  );
  assert(
    JSON.stringify(fake.getAggregate(GENERIC_MESSAGES_CHANNEL)) ===
      JSON.stringify(genericAggregate),
    `generic message changed the aggregate: ${JSON.stringify(fake.getAggregate(GENERIC_MESSAGES_CHANNEL))}`
  );
  return "notification and generic messages appended; both aggregates stayed unchanged";
}

/**
 * (d) 10x redeploy: no duplicate deliveries, no connection/subscription growth.
 * @param {{nr:NodeRedHarness, fake:ReturnType<typeof makeFakeAdapter>}} ctx
 */
async function scenarioRedeploy(ctx) {
  const { nr, fake } = ctx;
  const z = uid("tab");
  const conn = uid("conn");
  const tin = uid("tin");
  const dbg = uid("dbg");
  const flows = [
    tabNode(z, "e2e-d"),
    connNode(conn),
    tagInNode(tin, z, conn, "e2e_dup", dbg),
    debugNode(dbg, z),
  ];

  await nr.deploy(flows);
  await waitAllGreen(nr, [tin], 20000);
  await waitFor(() => fake.subscriberCount(TAG_CHANNEL) >= 1, {
    timeoutMs: 15000,
    description: "initial subscription",
  });

  const REDEPLOYS = 10;
  for (let i = 0; i < REDEPLOYS; i++) {
    await nr.deploy(flows);
    await waitAllGreen(nr, [tin], 20000);
  }

  // After the churn, connections/subscriptions must settle to EXACTLY one, and
  // STAY there: too few means the final flow never re-subscribed; more than one
  // is a leak. `<=1` would be satisfied by a torn-down 0, so require ===1 held
  // stably (which also guarantees a live subscriber for the delivery check, and
  // avoids injecting mid-handoff).
  try {
    await waitStable(
      () => fake.connectionCount() === 1 && fake.subscriberCount(TAG_CHANNEL) === 1,
      { stableMs: 1000, timeoutMs: 25000, description: "exactly 1 connection + 1 subscription" }
    );
  } catch (_e) {
    throw new AssertionError(
      `connection/subscription did not settle to 1 after ${REDEPLOYS} redeploys ` +
        `(leak or lost subscription): connections=${fake.connectionCount()}, ` +
        `subscribers=${fake.subscriberCount(TAG_CHANNEL)}, node=${JSON.stringify(nr.status(tin))}`
    );
  }

  // A single update must produce exactly one delivery (no duplicate wiring).
  nr.clearDebug();
  fake.injectAggregate(TAG_CHANNEL, { [APP_KEY]: { e2e_dup: 123 } });
  try {
    await waitFor(() => nr.debugFor(dbg).length >= 1, {
      timeoutMs: 15000,
      description: "delivery after redeploys",
    });
  } catch (_e) {
    throw new AssertionError(
      `no delivery after ${REDEPLOYS} redeploys despite a live subscription ` +
        `(connections=${fake.connectionCount()}, subscribers=${fake.subscriberCount(TAG_CHANNEL)}, ` +
        `node=${JSON.stringify(nr.status(tin))}) — points at a redeploy/reconnect race in ` +
        `the transport/tag layer where the wire subscription is registered but ` +
        `local fan-out is not`
    );
  }
  await sleep(500); // settle: allow any duplicate to arrive before counting.
  const count = nr.debugFor(dbg).length;
  assert(
    count === 1,
    `duplicate delivery after ${REDEPLOYS} redeploys: got ${count} messages for one update`
  );
  return `after ${REDEPLOYS} redeploys: 1 connection, 1 subscriber, exactly 1 delivery`;
}

/**
 * (e) kill + restart the fake server: nodes recover to green and a write lands.
 * @param {{nr:NodeRedHarness, fake:ReturnType<typeof makeFakeAdapter>, gate:TcpGate}} ctx
 */
async function scenarioKillRestart(ctx) {
  const { nr, fake, gate } = ctx;
  const z = uid("tab");
  const conn = uid("conn");
  const inj = uid("inj");
  const tout = uid("tout");
  const tin = uid("tin");
  const dbg = uid("dbg");
  const flows = [
    tabNode(z, "e2e-e"),
    connNode(conn),
    injectNode(inj, z, tout, 24, "num"),
    tagOutNode(tout, z, conn, "e2e_after"),
    tagInNode(tin, z, conn, "e2e_recover", dbg),
    debugNode(dbg, z),
  ];
  await nr.deploy(flows);
  await waitAllGreen(nr, [tout, tin], 20000);

  // Kill: drop every connection and refuse new ones. Nodes must leave green.
  gate.kill();
  await waitFor(
    () => {
      const a = nr.status(tout);
      const b = nr.status(tin);
      return (a && a.fill !== "green") || (b && b.fill !== "green");
    },
    { timeoutMs: 15000, description: "nodes to leave green after kill" }
  );

  // Restart: allow traffic again. Nodes must recover to green.
  gate.revive();
  await waitAllGreen(nr, [tout, tin], 25000);

  // A subsequent write must succeed post-recovery.
  const before = fake.getWrites(TAG_CHANNEL).length;
  await nr.triggerInject(inj);
  await waitFor(
    () => {
      const ws = fake.getWrites(TAG_CHANNEL);
      return ws
        .slice(before)
        .some((w) => w.body && w.body[APP_KEY] && w.body[APP_KEY].e2e_after === 24);
    },
    { timeoutMs: 15000, description: "post-restart tag write to land" }
  );

  // And the subscription must be live again.
  nr.clearDebug();
  fake.injectAggregate(TAG_CHANNEL, { [APP_KEY]: { e2e_recover: 99 } });
  await waitFor(() => nr.debugFor(dbg).length >= 1, {
    timeoutMs: 15000,
    description: "delivery after restart",
  });
  return "nodes recovered to green; post-restart write landed and subscription re-fired";
}

// --- orchestration ---------------------------------------------------------

const SCENARIOS = [
  { key: "a", name: "examples deploy clean", timeoutMs: 120000, fn: scenarioExamplesDeploy },
  { key: "b", name: "tag write namespacing + tag-in delivery", timeoutMs: 60000, fn: scenarioTagRoundTrip },
  { key: "c", name: "persisted messages do not update aggregates", timeoutMs: 45000, fn: scenarioNotify },
  { key: "d", name: "10x redeploy: no dup / no leak", timeoutMs: 120000, fn: scenarioRedeploy },
  { key: "e", name: "kill + restart recovery", timeoutMs: 90000, fn: scenarioKillRestart },
];

/**
 * @template T
 * @param {Promise<T>} p
 * @param {number} ms
 * @param {string} label
 * @returns {Promise<T>}
 */
function hardTimeout(p, ms, label) {
  let timer;
  const guard = new Promise((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`scenario "${label}" exceeded hard timeout ${ms}ms`)),
      ms
    );
    if (timer.unref) timer.unref();
  });
  return Promise.race([p, guard]).finally(() => clearTimeout(timer));
}

async function main() {
  const started = Date.now();
  const loaded = loadFakeDda();
  process.stderr.write(
    `[e2e] fake DDA source: ${loaded.source} (${loaded.path})\n`
  );

  const fakeServer = loaded.createFakeDdaServer({ agentId: "agent-e2e" });
  await fakeServer.start();
  const gate = new TcpGate({ backendPort: fakeServer.port });
  await gate.start();

  const nrPort = await getFreePort();
  const userDir = fs.mkdtempSync(
    path.join(
      fs.existsSync("/private/tmp/claude-501") ? "/private/tmp/claude-501" : os.tmpdir(),
      "nodered-e2e-"
    )
  );

  const nr = new NodeRedHarness({
    userDir,
    port: nrPort,
    ddaWebUri: gate.baseUrl,
    appKey: APP_KEY,
    verbose: process.env.E2E_VERBOSE === "1",
  });

  const fake = makeFakeAdapter(fakeServer);
  const ctx = { nr, fake, gate };

  const results = [];
  let cleanupDone = false;
  const cleanup = async () => {
    if (cleanupDone) return;
    cleanupDone = true;
    await nr.stop().catch(() => {});
    await gate.stop().catch(() => {});
    await Promise.resolve(fakeServer.close ? fakeServer.close() : fakeServer.stop()).catch(
      () => {}
    );
    try {
      fs.rmSync(userDir, { recursive: true, force: true });
    } catch (_e) {
      /* ignore */
    }
  };

  try {
    process.stderr.write(
      `[e2e] Node-RED :${nrPort}  DDA_WEB_URI=${gate.baseUrl}  backend :${fakeServer.port}  APP_KEY=${APP_KEY}\n`
    );
    await hardTimeout(nr.start(), 60000, "startup");
    process.stderr.write(`[e2e] Node-RED up; running ${SCENARIOS.length} scenarios\n\n`);

    for (const sc of SCENARIOS) {
      const t0 = Date.now();
      try {
        const detail = await hardTimeout(sc.fn(ctx), sc.timeoutMs, sc.name);
        const ms = Date.now() - t0;
        results.push({ ...sc, ok: true, detail, ms });
        process.stdout.write(`ok   (${sc.key}) ${sc.name} — ${detail} [${ms}ms]\n`);
      } catch (err) {
        const ms = Date.now() - t0;
        results.push({ ...sc, ok: false, error: err, ms });
        process.stdout.write(
          `FAIL (${sc.key}) ${sc.name} — ${err && err.message} [${ms}ms]\n`
        );
        if (process.env.E2E_VERBOSE === "1") {
          process.stderr.write(`\n[e2e] node-red log tail:\n${nr.logTail()}\n`);
        }
      }
    }
  } catch (err) {
    process.stdout.write(`FAIL (startup) — ${err && err.message}\n`);
    if (nr.logTail) {
      process.stderr.write(`\n[e2e] node-red log tail:\n${nr.logTail()}\n`);
    }
    results.push({ key: "startup", name: "startup", ok: false, error: err });
  } finally {
    await cleanup();
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  const total = Date.now() - started;
  process.stdout.write(
    `\n1..${results.length}\n# e2e: ${passed} passed, ${failed} failed [${total}ms]\n`
  );
  process.exitCode = failed > 0 ? 1 : 0;
}

// Only run when invoked directly (`npm run e2e`). Under Node's built-in test
// runner each file is isolated in a child process where `require.main === module`
// is true, so we ALSO gate on NODE_TEST_CONTEXT — this keeps the live harness
// firmly OUT of the default `npm test` (`node --test`), where it merely loads as
// a zero-test file.
if (require.main === module && !process.env.NODE_TEST_CONTEXT) {
  main().catch((err) => {
    process.stderr.write(`[e2e] fatal: ${err && err.stack ? err.stack : err}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main };

"use strict";
/*
 * Tag nodes: doover-tag-in, doover-tag-get, doover-tag-out.
 *
 * The headline feature. All three register from this single module (the
 * palette's package.json node-red map points every tag type here). Each node
 * resolves the referenced `doover-connection` config node and drives the
 * `TagClient` it exposes via `getTagClient()`, plus the underlying transport via
 * `getTransport()` (for identity + status dots).
 *
 * Scope model (mirrors pydoover):
 *   - "thisApp"  -> tag layer uses the transport's own app key (opts {}).
 *   - "otherApp" -> opts { appKey } reads/writes another app's namespace.
 *   - "global"   -> opts { global: true } uses the app-key-independent root.
 *
 * Nested key paths use dot-notation (`battery.voltage`); the TagClient splits
 * the dotted string into a KeyPath. Each dot-separated segment must match the
 * device-agent key charset `[A-Za-z0-9_-]+`; the node validates early and errors
 * clearly rather than letting the transport reject it opaquely.
 */

const { STATUS_DOTS, resolveConnection, statusForTransport } = require("../lib/shared");

const SEGMENT_RE = /^[A-Za-z0-9_-]+$/;

/**
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
function isPlainObject(v) {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    Object.getPrototypeOf(v) === Object.prototype
  );
}

/**
 * Validate a dotted tag key. Returns an error message, or null when valid.
 * @param {unknown} key
 * @returns {string | null}
 */
function validateTag(key) {
  if (typeof key !== "string" || key.length === 0) {
    return "tag key is empty";
  }
  const segments = key.split(".");
  for (const seg of segments) {
    if (!SEGMENT_RE.test(seg)) {
      return `invalid tag segment "${seg}" (allowed: A-Z a-z 0-9 _ -)`;
    }
  }
  return null;
}

/**
 * Validate the configured scope. For `otherApp` the app key is a real namespace
 * path segment (TagClient._resolvePath unshifts it), so an empty or non-charset
 * app key would silently target a phantom "" (or malformed) namespace. Returns
 * an error message, or null when the scope config is valid.
 * @param {Record<string, any>} config
 * @returns {string | null}
 */
function validateScope(config) {
  const scope = config.scope || "thisApp";
  if (scope === "otherApp") {
    const ak = config.appKey;
    if (typeof ak !== "string" || ak.length === 0) {
      return "scope 'another app' requires an App key";
    }
    if (!SEGMENT_RE.test(ak)) {
      return `invalid App key "${ak}" (allowed: A-Z a-z 0-9 _ -)`;
    }
  }
  return null;
}

/**
 * Resolve the configured scope into TagClient options plus the app-key used for
 * the message topic and `msg.doover.appKey`.
 * @param {Record<string, any>} config
 * @param {any} transport
 * @returns {{ opts: {appKey?: string, global?: boolean}, topicNs: string|null, appKey: string|null }}
 */
function scopeInfo(config, transport) {
  const scope = config.scope || "thisApp";
  if (scope === "global") {
    return { opts: { global: true }, topicNs: "global", appKey: null };
  }
  if (scope === "otherApp") {
    const ak = config.appKey || "";
    return { opts: { appKey: ak }, topicNs: ak, appKey: ak };
  }
  const ak =
    transport && typeof transport.appKey === "function" ? transport.appKey() : null;
  return { opts: {}, topicNs: ak, appKey: ak };
}

/**
 * Momentary "sent" status blip that restores the connection status shortly
 * after. Timer is unref'd so it never keeps the process alive in tests.
 * @param {any} node
 * @param {any} transport
 */
function blip(node, transport) {
  node.status({ fill: "blue", shape: "dot", text: "sent" });
  if (node._blipTimer) {
    clearTimeout(node._blipTimer);
  }
  node._blipTimer = setTimeout(() => {
    try {
      const dot = STATUS_DOTS[transport.status()] || {};
      node.status(dot);
    } catch (_err) {
      /* transport gone; ignore */
    }
  }, 400);
  if (node._blipTimer.unref) {
    node._blipTimer.unref();
  }
}

/** @param {import("node-red").NodeAPI} RED */
module.exports = function (RED) {
  // --- doover-tag-in --------------------------------------------------------
  function DooverTagInNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    const conn = resolveConnection(RED, node, config.connection);
    if (!conn) {
      return;
    }
    if (typeof conn.getTagClient !== "function" || typeof conn.getTransport !== "function") {
      node.status({ fill: "red", shape: "ring", text: "connection not ready" });
      node.error("Doover connection does not expose getTagClient()/getTransport().");
      return;
    }

    const tagErr = validateTag(config.tag);
    if (tagErr) {
      node.status({ fill: "red", shape: "ring", text: "invalid tag" });
      node.error(`doover tag in: ${tagErr}`);
      return;
    }

    const scopeErr = validateScope(config);
    if (scopeErr) {
      node.status({ fill: "red", shape: "ring", text: "invalid app key" });
      node.error(`doover tag in: ${scopeErr}`);
      return;
    }

    /** @type {any} */
    let tagClient;
    /** @type {any} */
    let transport;
    try {
      // Both getTagClient() and acquire() build the transport lazily and can throw
      // when the factory fails; guard them together so the node shows a tidy "no
      // transport" status instead of an uncaught constructor throw.
      tagClient = conn.getTagClient();
      transport = conn.acquire();
    } catch (err) {
      node.status({ fill: "red", shape: "ring", text: "no transport" });
      node.error("Doover connection unavailable: " + err.message);
      return;
    }
    const stopStatus = statusForTransport(node, transport);
    const { opts, topicNs, appKey } = scopeInfo(config, transport);

    const onlyOnChange = config.onlyOnChange !== false; // default true
    let lastSerialized;
    let haveLast = false;
    let unsubscribe;

    try {
      unsubscribe = tagClient.subscribeTag(
        config.tag,
        (value, prev) => {
          const serialized = JSON.stringify(value);
          if (onlyOnChange && haveLast && serialized === lastSerialized) {
            return;
          }
          const previous = haveLast ? tryParse(lastSerialized) : prev;
          lastSerialized = serialized;
          haveLast = true;
          node.send({
            payload: value,
            topic: `${topicNs}/${config.tag}`,
            doover: {
              agentId:
                typeof transport.agentId === "function" ? transport.agentId() : null,
              appKey,
              tag: config.tag,
              previous,
            },
          });
        },
        { ...opts, emitInitial: !!config.emitInitial }
      );
    } catch (err) {
      node.status({ fill: "red", shape: "ring", text: "subscribe failed" });
      node.error(err);
    }

    node.on("close", (done) => {
      if (typeof unsubscribe === "function") {
        try {
          unsubscribe();
        } catch (_err) {
          /* already gone */
        }
      }
      if (node._blipTimer) {
        clearTimeout(node._blipTimer);
      }
      stopStatus();
      conn.release();
      done();
    });
  }
  RED.nodes.registerType("doover-tag-in", DooverTagInNode);

  // --- doover-tag-get -------------------------------------------------------
  function DooverTagGetNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    const conn = resolveConnection(RED, node, config.connection);
    if (!conn) {
      return;
    }
    if (typeof conn.getTagClient !== "function" || typeof conn.getTransport !== "function") {
      node.status({ fill: "red", shape: "ring", text: "connection not ready" });
      node.error("Doover connection does not expose getTagClient()/getTransport().");
      return;
    }

    /** @type {any} */
    let tagClient;
    /** @type {any} */
    let transport;
    try {
      // Guard getTagClient() + acquire() together (both build the transport lazily
      // and can throw) so the node fails with a status dot, not an uncaught throw.
      tagClient = conn.getTagClient();
      transport = conn.acquire();
    } catch (err) {
      node.status({ fill: "red", shape: "ring", text: "no transport" });
      node.error("Doover connection unavailable: " + err.message);
      return;
    }
    const stopStatus = statusForTransport(node, transport);
    const targetProp = config.property || "payload";
    const nonClobber = !!config.nonClobber;

    node.on("input", async (msg, send, done) => {
      try {
        // Tag from config, else from msg.topic (dynamic lookups). A topic of the
        // form "<ns>/<tag>" is stripped to just the tag; the configured scope
        // still governs the namespace.
        let tag = config.tag && config.tag.length ? config.tag : msg.topic;
        if (typeof tag === "string" && tag.indexOf("/") !== -1) {
          tag = tag.substring(tag.indexOf("/") + 1);
        }
        const tagErr = validateTag(tag);
        if (tagErr) {
          done(new Error(`doover tag get: ${tagErr}`));
          return;
        }

        const { opts } = scopeInfo(config, transport);
        let value = await tagClient.getTag(tag, opts);

        if (value === undefined) {
          value = await evalDefault(RED, config, node, msg);
        }

        if (nonClobber && RED.util.getMessageProperty(msg, targetProp) !== undefined) {
          // Enrich-not-clobber: leave the existing value in place.
        } else {
          RED.util.setMessageProperty(msg, targetProp, value, true);
        }

        send(msg);
        done();
      } catch (err) {
        done(err);
      }
    });

    node.on("close", (done) => {
      stopStatus();
      conn.release();
      done();
    });
  }
  RED.nodes.registerType("doover-tag-get", DooverTagGetNode);

  // --- doover-tag-out -------------------------------------------------------
  function DooverTagOutNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    const conn = resolveConnection(RED, node, config.connection);
    if (!conn) {
      return;
    }
    if (typeof conn.getTagClient !== "function" || typeof conn.getTransport !== "function") {
      node.status({ fill: "red", shape: "ring", text: "connection not ready" });
      node.error("Doover connection does not expose getTagClient()/getTransport().");
      return;
    }

    /** @type {any} */
    let tagClient;
    /** @type {any} */
    let transport;
    try {
      // Guard getTagClient() + acquire() together (both build the transport lazily
      // and can throw) so the node fails with a status dot, not an uncaught throw.
      tagClient = conn.getTagClient();
      transport = conn.acquire();
    } catch (err) {
      node.status({ fill: "red", shape: "ring", text: "no transport" });
      node.error("Doover connection unavailable: " + err.message);
      return;
    }
    const stopStatus = statusForTransport(node, transport);
    const doLog = !!config.log;
    const doLive = !!config.live;
    const doBatch = !!config.batch;
    const rateMs = Number(config.rateLimit) > 0 ? Number(config.rateLimit) : 200;

    node.on("input", async (msg, send, done) => {
      try {
        const { opts } = scopeInfo(config, transport);

        if (doBatch) {
          // Batch mode: object payload -> atomic multi-write.
          if (!isPlainObject(msg.payload)) {
            done(new Error("doover tag out: batch mode requires an object payload"));
            return;
          }
          await tagClient.setTags(msg.payload, { ...opts, log: doLog });
          blip(node, transport);
          if (send) {
            send(msg);
          }
          done();
          return;
        }

        const tagErr = validateTag(config.tag);
        if (tagErr) {
          done(new Error(`doover tag out: ${tagErr}`));
          return;
        }

        if (doLive) {
          // One-shot streaming with a simple rate-limit guard.
          const now = Date.now();
          if (node._lastLive !== undefined && now - node._lastLive < rateMs) {
            node.status({ fill: "yellow", shape: "dot", text: "rate limited" });
            node.warn(
              `doover tag out: live write dropped (rate limit ${rateMs}ms)`
            );
            done();
            return;
          }
          node._lastLive = now;
          await tagClient.setTag(config.tag, msg.payload, { ...opts, live: true });
        } else {
          await tagClient.setTag(config.tag, msg.payload, { ...opts, log: doLog });
        }

        blip(node, transport);
        if (send) {
          send(msg);
        }
        done();
      } catch (err) {
        done(err);
      }
    });

    node.on("close", (done) => {
      if (node._blipTimer) {
        clearTimeout(node._blipTimer);
      }
      stopStatus();
      conn.release();
      done();
    });
  }
  RED.nodes.registerType("doover-tag-out", DooverTagOutNode);
};

/**
 * @param {string|undefined} s
 * @returns {unknown}
 */
function tryParse(s) {
  if (s === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(s);
  } catch (_err) {
    return undefined;
  }
}

/**
 * Evaluate the configured default value (typedInput) for a tag-get miss.
 * Resolves to `undefined` when no default is configured.
 * @param {import("node-red").NodeAPI} RED
 * @param {Record<string, any>} config
 * @param {any} node
 * @param {any} msg
 * @returns {Promise<unknown>}
 */
function evalDefault(RED, config, node, msg) {
  return new Promise((resolve) => {
    const type = config.defaultValueType;
    if (!type || type === "none") {
      resolve(undefined);
      return;
    }
    try {
      RED.util.evaluateNodeProperty(
        config.defaultValue,
        type,
        node,
        msg,
        (err, res) => {
          resolve(err ? undefined : res);
        }
      );
    } catch (_err) {
      resolve(undefined);
    }
  });
}

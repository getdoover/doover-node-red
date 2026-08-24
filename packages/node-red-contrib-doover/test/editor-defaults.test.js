"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const NODES_DIR = path.join(__dirname, "..", "nodes");
const DEFAULT_CONNECTION_ID = "doover-local-device";

test("every Doover message node defaults to the seeded local connection", () => {
  const html = ["tags.html", "channels.html", "notify.html"]
    .map((name) => fs.readFileSync(path.join(NODES_DIR, name), "utf8"))
    .join("\n");
  const connectionDefaults = [
    ...html.matchAll(
      /connection:\s*\{[\s\S]*?type:\s*"doover-connection"[\s\S]*?\}/g
    ),
  ];

  assert.equal(connectionDefaults.length, 7);
  for (const [definition] of connectionDefaults) {
    assert.match(
      definition,
      new RegExp(`value:\\s*"${DEFAULT_CONNECTION_ID}"`)
    );
  }
});

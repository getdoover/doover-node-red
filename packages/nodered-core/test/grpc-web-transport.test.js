"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");

const {
  GrpcWebClient,
  GrpcWebTransport,
} = require("..");
const {
  _internals: { encodeFrame, serviceDefinition },
} = require("../lib/grpc-web-transport");

function trailerFrame(status = 0, message = "") {
  const payload = Buffer.from(
    `grpc-status:${status}\r\n${message ? `grpc-message:${message}\r\n` : ""}\r\n`
  );
  const frame = Buffer.alloc(payload.length + 5);
  frame[0] = 0x80;
  frame.writeUInt32BE(payload.length, 1);
  payload.copy(frame, 5);
  return frame;
}

function requestPayload(body, method) {
  assert.equal(body[0], 0);
  const length = body.readUInt32BE(1);
  return method.requestDeserialize(body.subarray(5, 5 + length));
}

async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}/grpc`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("gRPC-Web unary calls use protobuf frames and decode split responses", async () => {
  const method = serviceDefinition().TestComms;
  await withServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      assert.equal(req.url, `/grpc${method.path}`);
      assert.equal(req.headers["content-type"], "application/grpc-web+proto");
      const request = requestPayload(Buffer.concat(chunks), method);
      assert.equal(request.header.app_id, "test-app");
      assert.equal(request.message, "ping");
      const response = Buffer.concat([
        encodeFrame(method.responseSerialize({
          response_header: { success: true, response_code: 200 },
          response: "pong",
        })),
        trailerFrame(),
      ]);
      res.writeHead(200, { "content-type": "application/grpc-web+proto" });
      res.write(response.subarray(0, 3));
      res.write(response.subarray(3, 11));
      res.end(response.subarray(11));
    });
  }, async (baseUrl) => {
    const client = new GrpcWebClient({ baseUrl });
    const response = await client.unary("TestComms", {
      header: { app_id: "test-app" },
      message: "ping",
    });
    assert.equal(response.response, "pong");
  });
});

test("gRPC-Web surfaces grpc-status trailer failures", async () => {
  const method = serviceDefinition().TestComms;
  await withServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/grpc-web+proto" });
      res.end(trailerFrame(14, "device%20offline"));
    });
  }, async (baseUrl) => {
    const client = new GrpcWebClient({ baseUrl });
    await assert.rejects(
      client.unary("TestComms", { message: "ping" }),
      (err) => err.code === 14 && err.message === "device offline"
    );
  });
  assert.ok(method);
});

class FakeGrpcWebClient {
  constructor() {
    this.aggregate = {};
    this.messages = [];
    this.calls = [];
    this.streamHandlers = null;
    this.cancelled = false;
  }

  async unary(name, request) {
    this.calls.push({ name, request });
    if (name === "TestComms") {
      return { response_header: { success: true }, response: "ok" };
    }
    if (name === "GetAggregate") {
      return {
        response_header: { success: true },
        aggregate: { data_json: JSON.stringify(this.aggregate) },
      };
    }
    if (name === "UpdateAggregate") {
      this.aggregate = { ...this.aggregate, ...JSON.parse(request.data_json) };
      return { response_header: { success: true } };
    }
    if (name === "SendOneShotMessage") {
      return { response_header: { success: true } };
    }
    if (name === "CreateMessage") {
      this.messages.push({
        channel: request.channel_name,
        data: JSON.parse(request.data_json),
      });
      return { response_header: { success: true }, message_id: "123" };
    }
    throw new Error(`unexpected RPC ${name}`);
  }

  stream(name, request, handlers) {
    this.calls.push({ name, request });
    this.streamHandlers = handlers;
    return () => {
      this.cancelled = true;
    };
  }
}

function nextTick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test("local gRPC-Web transport connects, publishes JSON and reads it back", async () => {
  const client = new FakeGrpcWebClient();
  const transport = new GrpcWebTransport({ client, appKey: "app-1" });
  await transport.connect();
  assert.equal(transport.status(), "connected");
  assert.equal(transport.agentId(), "local");

  await transport.publish("state", { count: 42 }, { maxAge: 60, recordLog: true });
  const write = client.calls.find((call) => call.name === "UpdateAggregate");
  assert.equal(write.request.data_json, '{"count":42}');
  assert.equal(write.request.max_age_secs, 60);
  assert.equal(write.request.save_log, true);
  assert.equal(write.request.return_aggregate, false);
  assert.deepEqual(await transport.getAggregate("state"), { count: 42 });
  await transport.close();
});

test("local gRPC-Web createMessage appends a message without changing the aggregate", async () => {
  const client = new FakeGrpcWebClient();
  client.aggregate = { current: true };
  const transport = new GrpcWebTransport({ client, appKey: "app-1" });

  const id = await transport.createMessage("notifications", {
    message: "Pump stopped",
  });

  assert.equal(id, "123");
  assert.deepEqual(client.messages, [
    {
      channel: "notifications",
      data: { message: "Pump stopped" },
    },
  ]);
  assert.deepEqual(client.aggregate, { current: true });
  assert.equal(
    client.calls.some((call) => call.name === "UpdateAggregate"),
    false
  );
});

test("local gRPC-Web subscription seeds first and then emits full aggregates", async () => {
  const client = new FakeGrpcWebClient();
  client.aggregate = { value: 1 };
  const transport = new GrpcWebTransport({ client, appKey: "app-1" });
  const seen = [];
  const unsubscribe = transport.subscribe("state", (message) => seen.push(message));
  await nextTick();
  await nextTick();
  assert.equal(seen[0].event, "sync");
  assert.deepEqual(seen[0].aggregate, { value: 1 });
  const stream = client.calls.find((call) => call.name === "ChannelEventSubscription");
  assert.equal(stream.request.wire_format, "WIRE_FORMAT_JSON_ONLY");
  assert.equal(stream.request.replay_missed_messages, false);

  client.streamHandlers.onMessage({
    response_header: { success: true },
    event_name: "AggregateUpdate",
    data_json: JSON.stringify({ aggregate: { data: { value: 2 } } }),
  });
  assert.equal(seen[1].event, "aggregate");
  assert.deepEqual(seen[1].aggregate, { value: 2 });
  unsubscribe();
  assert.equal(client.cancelled, true);
  await transport.close();
});

test("an unobserved asynchronous transport error does not crash EventEmitter", () => {
  const transport = new GrpcWebTransport({ client: new FakeGrpcWebClient() });
  assert.doesNotThrow(() => transport.emit("error", new Error("offline")));
});

import assert from "node:assert/strict";
import test from "node:test";
import { SmokeRegistry, parseOnly, summarize, SseCollector } from "../contrib/smoke/core.js";

test("registry reports passes, failures, and blocked checks", async () => {
  const registry = new SmokeRegistry();
  const called: string[] = [];
  registry.check("good", async () => { called.push("good"); });
  registry.check("bad", async () => { throw new Error("observable missing"); });
  registry.check("blocked", async () => { called.push("blocked"); });
  const lines: string[] = [];
  const results = await registry.run({ log: (line) => lines.push(line) });
  assert.deepEqual(called, ["good"]);
  assert.deepEqual(results.map((r) => r.status), ["PASS", "FAIL", "SKIP"]);
  assert.deepEqual(summarize(results), { pass: 1, fail: 1, skip: 1, exitCode: 1 });
  assert.equal(lines.filter((line) => line.startsWith("FAIL bad")).length, 1);
});

test("only filter includes prerequisites and skips unrelated checks", async () => {
  const registry = new SmokeRegistry();
  const called: string[] = [];
  registry.check("setup", async () => { called.push("setup"); });
  registry.check("unrelated", async () => { called.push("unrelated"); });
  registry.check("selected", async () => { called.push("selected"); }, { dependsOn: ["setup"] });
  const results = await registry.run({ only: parseOnly(["--only", "selected"]), log: () => {} });
  assert.deepEqual(called, ["setup", "selected"]);
  assert.deepEqual(summarize(results), { pass: 2, fail: 0, skip: 1, exitCode: 0 });
});

test("unknown filters and invalid dependencies fail rather than falsely pass", async () => {
  const registry = new SmokeRegistry();
  registry.check("known", async () => {});
  await assert.rejects(registry.run({ only: new Set(["typo"]), log: () => {} }), /unknown check/);
  assert.throws(() => registry.check("known", async () => {}), /duplicate/);
  assert.throws(() => registry.check("later", async () => {}, { dependsOn: ["missing"] }), /prerequisite/);
  assert.throws(() => parseOnly(["--only"]), /requires/);
  assert.throws(() => parseOnly(["--nope"]), /unknown argument/);
});

test("hung checks fail with cancellation using a controlled deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const registry = new SmokeRegistry();
  let cancelled = false;
  registry.check("hung", (signal) => new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => { cancelled = true; resolve(); }, { once: true });
  }), { timeoutMs: 100 });
  const run = registry.run({ log: () => {} });
  t.mock.timers.tick(100);
  const results = await run;
  assert.equal(cancelled, true);
  assert.equal(results[0]?.status, "FAIL");
  assert.match(results[0]?.detail ?? "", /timed out/);
  assert.equal(summarize(results).exitCode, 1);
});

test("interruption stops the active check and skips the remainder", async () => {
  const controller = new AbortController();
  const registry = new SmokeRegistry();
  registry.check("interrupted", async () => { controller.abort(new Error("SIGINT")); });
  registry.check("untouched", async () => { assert.fail("must not run"); });
  const results = await registry.run({ signal: controller.signal, log: () => {} });
  assert.deepEqual(results.map((r) => r.status), ["FAIL", "SKIP"]);
});

test("SSE waits observe only future events and handle split frames", async () => {
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stream = new ReadableStream<Uint8Array>({ start(controller) { streamController = controller; } });
  const sse = new SseCollector();
  const pump = sse.consume(stream);
  const encoder = new TextEncoder();
  const first = sse.waitForEvent((event) => event.type === "session.idle", 1_000);
  streamController?.enqueue(encoder.encode('data: {"type":"session.'));
  streamController?.enqueue(encoder.encode('idle","properties":{"sessionID":"ses_test"}}\n\n'));
  await first;
  const next = sse.waitForEvent((event) => event.type === "session.idle", 1_000);
  const settled = next.then(() => true);
  streamController?.enqueue(encoder.encode('data: {"type":"session.idle","properties":{"sessionID":"ses_new"}}\n\n'));
  const event = await next;
  assert.equal(event.type, "session.idle");
  if (event.type === "session.idle") assert.equal(event.properties.sessionID, "ses_new");
  assert.equal(await settled, true);
  streamController?.close();
  await pump;
  assert.equal(sse.events.length, 2);
});

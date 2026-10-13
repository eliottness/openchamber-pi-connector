import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { loadCatalog } from "../src/catalog.js";
import { SessionManager } from "../src/sessions.js";
import { SessionStore } from "../src/session-store.js";
import { AdapterServer } from "../src/server.js";
import { systemClock } from "../src/lifecycle.js";
import type { OCModelRef } from "../src/types.js";

function setup(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "ocpi-thinking-"));
  const previous = { binary: process.env.OCPI_PI_BINARY, state: process.env.OCPI_STATE_DIR };
  process.env.OCPI_PI_BINARY = resolve("test/fixtures/fake-omo.mjs");
  process.env.OCPI_STATE_DIR = join(directory, "state");
  let time = 0;
  const manager = new SessionManager(() => undefined, new SessionStore(join(directory, "manager-state")), directory, {
    clock: { ...systemClock, now: () => time },
    idleTimeoutMs: 100,
  });
  t.after(async () => {
    await manager.disposeAll();
    if (previous.binary === undefined) delete process.env.OCPI_PI_BINARY;
    else process.env.OCPI_PI_BINARY = previous.binary;
    if (previous.state === undefined) delete process.env.OCPI_STATE_DIR;
    else process.env.OCPI_STATE_DIR = previous.state;
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, manager, expire: () => { time += 100; } };
}

async function state(manager: SessionManager, sessionID: string) {
  const result = await manager.sessionRpc<{ thinkingLevel: string; thinkingCalls: number; resumed: boolean }>(sessionID, { type: "get_state" });
  assert.ok(result.success && result.data);
  return result.data;
}

test("catalog advertises only supported reasoning variants", async (t) => {
  const { directory } = setup(t);
  const catalog = await loadCatalog(directory);
  const models = catalog.providers[0]?.models;
  assert.ok(models);
  assert.deepEqual(Object.keys(models["fake-model"]?.variants ?? {}), ["off", "low", "medium", "high"]);
  assert.deepEqual(Object.keys(models.mapped?.variants ?? {}), ["low", "high"]);
  assert.equal(models.plain?.variants, undefined);
  assert.equal(models.unknown?.variants, undefined);
});

test("a selected level sends one thinking command", async (t) => {
  const { directory, manager } = setup(t);
  const session = await manager.create(directory);
  const selection = { providerID: "fake", modelID: "fake-model", variant: "low" };
  await manager.setModel(session.id, selection);
  assert.equal((await state(manager, session.id)).thinkingLevel, "low");
  assert.equal((await state(manager, session.id)).thinkingCalls, 1);
});

test("unchanged level sends no thinking command", async (t) => {
  const { directory, manager } = setup(t);
  const session = await manager.create(directory);
  const selection = { providerID: "fake", modelID: "fake-model", variant: "medium" };
  await manager.setModel(session.id, selection);
  assert.equal((await state(manager, session.id)).thinkingCalls, 0);
});

test("repeated prompt selection skips a second thinking command", async (t) => {
  const { directory, manager } = setup(t);
  const session = await manager.create(directory);
  const selection = { providerID: "fake", modelID: "fake-model", variant: "high" };
  await manager.setModel(session.id, selection);
  await manager.prompt(session.id, "REPEAT_SELECTION", selection);
  assert.equal((await state(manager, session.id)).thinkingLevel, "high");
  assert.equal((await state(manager, session.id)).thinkingCalls, 1);
});

test("F2 B6 a later thinking selection cannot overtake a prompt's own selection", { timeout: 10_000 }, async (t) => {
  const { directory, manager } = setup(t);
  const session = await manager.create(directory);
  const managed = manager.get(session.id);
  assert.ok(managed?.pi && managed.piPath);
  const pi = managed.pi;
  const later = Promise.withResolvers<OCModelRef>();
  const selection = { providerID: "fake", modelID: "fake-model" };
  const overlap = (event: Record<string, unknown>): void => {
    if (event.type !== "thinking_level_changed" || event.level !== "low") return;
    pi.off("event", overlap);
    void manager.setModel(session.id, { ...selection, variant: "high" }).then(later.resolve, later.reject);
  };
  pi.onEvent(overlap);
  t.after(() => pi.off("event", overlap));
  // Subscribe before prompting. The real fixture event places the later
  // request between the low setter and its correlated state verification.
  const results = await Promise.allSettled([
    manager.prompt(session.id, "RACE_LOW", { ...selection, variant: "low" }),
    later.promise,
  ]);
  for (const result of results) {
    if (result.status === "rejected") assert.fail(String(result.reason));
  }
  await manager.prompt(session.id, "AFTER_HIGH");
  const entries: Array<{ message?: { role: string; thinkingLevel: string; content: Array<{ text: string }> } }> =
    readFileSync(managed.piPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const prompts = entries.flatMap((entry) => entry.message?.role === "user" ? [entry.message] : []);
  assert.deepEqual(prompts.map((message) => [message.content[0]?.text, message.thinkingLevel]),
    [["RACE_LOW", "low"], ["AFTER_HIGH", "high"]]);
  assert.equal((await state(manager, session.id)).thinkingLevel, "high");
  assert.equal(managed.thinkingLevel, "high");
});

test("no selection sends no thinking command", async (t) => {
  const { directory, manager } = setup(t);
  const session = await manager.create(directory);
  await manager.prompt(session.id, "NO_SELECTION");
  assert.equal((await state(manager, session.id)).thinkingCalls, 0);
});

test("thinking refusal propagates and does not change the cached level", async (t) => {
  const { directory, manager } = setup(t);
  const session = await manager.create(directory);
  const selection = { providerID: "fake", modelID: "fake-model", variant: "max" };
  await assert.rejects(manager.setModel(session.id, selection), /unsupported thinking level/);
  assert.equal((await state(manager, session.id)).thinkingLevel, "medium");
});

test("clamped thinking selection is not reported as applied", async (t) => {
  const { directory, manager } = setup(t);
  const session = await manager.create(directory);
  const selection = { providerID: "fake", modelID: "fake-model", variant: "minimal" };
  await assert.rejects(manager.setModel(session.id, selection), /minimal.*low/);
});

test("selected level survives reap and revival even when RPC resets it", async (t) => {
  const { directory, manager, expire } = setup(t);
  const session = await manager.create(directory);
  const selection = { providerID: "fake", modelID: "fake-model", variant: "low" };
  await manager.setModel(session.id, selection);
  const managed = manager.get(session.id);
  assert.ok(managed);
  expire();
  await manager.lifecycle.reap();
  assert.equal(managed.pi, undefined);
  await manager.prompt(session.id, "AFTER_REAP");
  const resumed = await state(manager, session.id);
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.thinkingLevel, "low");
  assert.equal(resumed.thinkingCalls, 1);
});

test("model switch applies its thinking selection after set_model", async (t) => {
  const { directory, manager } = setup(t);
  const session = await manager.create(directory);
  const selection = { providerID: "fake", modelID: "mapped", variant: "high" };
  await manager.setModel(session.id, selection);
  assert.equal(manager.get(session.id)?.model?.modelID, "mapped");
  assert.equal((await state(manager, session.id)).thinkingLevel, "high");
  assert.equal((await state(manager, session.id)).thinkingCalls, 1);
});

test("thinking level is isolated between sessions", async (t) => {
  const { directory, manager } = setup(t);
  const first = await manager.create(directory);
  const second = await manager.create(directory);
  await manager.setModel(first.id, { providerID: "fake", modelID: "fake-model", variant: "low" });
  assert.equal((await state(manager, first.id)).thinkingLevel, "low");
  assert.equal((await state(manager, second.id)).thinkingLevel, "medium");
  assert.equal((await state(manager, second.id)).thinkingCalls, 0);
});

for (const [route, body] of [
  ["api-model", { model: { providerID: "fake", id: "fake-model", variant: "low" } }],
  ["v1-message", { model: { providerID: "fake", modelID: "fake-model" }, variant: "low", parts: [{ type: "text", text: "V1_SELECTION" }] }],
  ["v1-variant-only", { variant: "low", parts: [{ type: "text", text: "VARIANT_ONLY" }] }],
] as const) {
  test(`${route} forwards the selected thinking level`, async (t) => {
    const { directory } = setup(t);
    const server = new AdapterServer({ host: "127.0.0.1", port: 0, defaultDirectory: directory });
    t.after(() => server.stop());
    await server.start();
    const session: { id: string } = await (await fetch(`${server.url}/session`, { method: "POST", body: "{}" })).json();
    const path = route === "api-model" ? `/api/session/${session.id}/model` : `/session/${session.id}/message`;
    const response = await fetch(server.url + path, { method: "POST", body: JSON.stringify(body) });
    assert.equal(response.status, route === "api-model" ? 204 : 200);
    const messages = await fetch(`${server.url}/session/${session.id}/message`);
    assert.equal(messages.status, 200);
    // Use the same fake's session JSONL to observe the RPC command, not UI state.
    const files = readdirSync(directory).filter((file) => file.endsWith(".jsonl"));
    assert.ok(files.some((file) => readFileSync(join(directory, file), "utf8").trim().split("\n").some((line) => {
      const entry: { type: string; thinkingLevel?: string } = JSON.parse(line);
      return entry.type === "thinking_level_change" && entry.thinkingLevel === "low";
    })));
  });
}

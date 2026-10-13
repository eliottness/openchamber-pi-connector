import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { SessionManager } from "../src/sessions.js";
import { SessionStore } from "../src/session-store.js";
import type { PiRpcClient } from "../src/pi-rpc.js";

function bounded<T>(promise: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("status regression timed out")), 5000);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });
}

function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "ocpi-status-"));
  const previous = process.env.OCPI_PI_BINARY;
  process.env.OCPI_PI_BINARY = resolve("test/fixtures/fake-omo.mjs");
  const events = new EventEmitter();
  const snapshots: Array<{ event: string; reported: string | undefined }> = [];
  const manager = new SessionManager((_directory, event) => {
    if (event.type === "session.status" || event.type === "session.idle") {
      snapshots.push({
        event: event.type === "session.idle" ? "idle" : event.properties.status.type,
        reported: manager.statuses()[event.properties.sessionID]?.type,
      });
    }
    events.emit(event.type);
  }, new SessionStore(join(dir, "state")), dir);
  const nextIdle = () => bounded(new Promise<void>((resolve) => events.once("session.idle", resolve)));
  t.after(async () => {
    await manager.disposeAll();
    if (previous === undefined) delete process.env.OCPI_PI_BINARY;
    else process.env.OCPI_PI_BINARY = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, manager, snapshots, nextIdle };
}

for (const pending of ["question", "permission", "turn"] as const) {
  test(`abort reports idle after its event while interrupting a pending ${pending}`, { timeout: 15_000 }, async (t) => {
    const { dir, manager, snapshots, nextIdle } = setup(t);
    const session = await manager.create(dir);
    await bounded(manager.prompt(session.id, `pending-${pending}`));
    const managed = manager.get(session.id);
    assert.ok(managed?.pi);
    const endStatuses: Array<string | undefined> = [];
    managed.pi.onEvent((event) => {
      if (event.type === "agent_end") endStatuses.push(manager.statuses()[session.id]?.type);
    });
    assert.equal(manager.statuses()[session.id]?.type, "busy", "a mid-turn session must remain busy");
    if (pending === "question") assert.equal(manager.questions(session.id).length, 1);
    if (pending === "permission") assert.equal(manager.permissions(session.id).length, 1);

    const idle = nextIdle();
    assert.equal(await bounded(manager.abort(session.id)), true);
    await idle;

    assert.equal(manager.statuses()[session.id]?.type, "idle");
    assert.deepEqual(manager.questions(session.id), []);
    assert.deepEqual(manager.permissions(session.id), []);
    assert.deepEqual(endStatuses, ["busy"], "abort must not publish idle at the intermediate agent_end");
    for (const snapshot of snapshots) assert.equal(snapshot.reported, snapshot.event);
  });
}

test("abort reports idle while history refresh remains in flight and after it settles", { timeout: 15_000 }, async (t) => {
  const { dir, manager, snapshots, nextIdle } = setup(t);
  const session = await manager.create(dir);
  await bounded(manager.prompt(session.id, "pending-turn"));
  const managed = manager.get(session.id);
  assert.ok(managed?.pi);
  const pi = managed.pi;
  const endStatuses: Array<string | undefined> = [];
  pi.onEvent((event) => {
    if (event.type === "agent_end") endStatuses.push(manager.statuses()[session.id]?.type);
  });
  const command = pi.command.bind(pi);
  const dispatched = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  pi.command = async <T>(...args: Parameters<PiRpcClient["command"]>) => {
    const response = await command<T>(...args);
    if (args[0].type === "get_entries") {
      dispatched.resolve();
      await bounded(release.promise);
    }
    return response;
  };
  const refresh = manager.reloadMessages(session.id);
  try {
    await bounded(dispatched.promise);
    assert.equal(manager.statuses()[session.id]?.type, "busy");
    const idle = nextIdle();
    assert.equal(await bounded(manager.abort(session.id)), true);
    await idle;
    assert.equal(manager.statuses()[session.id]?.type, "idle", "history bookkeeping is not an active turn");
  } finally {
    release.resolve();
    await bounded(refresh);
    pi.command = command;
  }
  assert.equal(manager.statuses()[session.id]?.type, "idle");
  assert.deepEqual(endStatuses, ["busy"], "in-flight refresh must not turn agent_end into session idle");
  for (const snapshot of snapshots) assert.equal(snapshot.reported, snapshot.event);
});

test("agent_end keeps busy through a continuation until authoritative agent_idle", { timeout: 15_000 }, async (t) => {
  const { dir, manager, snapshots, nextIdle } = setup(t);
  const session = await manager.create(dir);
  await bounded(manager.prompt(session.id, "pending-turn"));
  const managed = manager.get(session.id);
  assert.ok(managed?.pi);
  const pi = managed.pi;

  await pi.command({ type: "emit_event", event: { type: "agent_end" } }, 5000);
  assert.equal(manager.statuses()[session.id]?.type, "busy", "agent_end is not session idle");
  assert.equal(snapshots.some((snapshot) => snapshot.event === "idle"), false, "no premature idle before deferred continuation");
  await pi.command({ type: "emit_event", event: { type: "agent_start" } }, 5000);
  assert.equal(manager.statuses()[session.id]?.type, "busy");
  await pi.command({ type: "emit_event", event: { type: "agent_end", willRetry: true } }, 5000);
  assert.equal(manager.statuses()[session.id]?.type, "busy", "retry must stay active");
  await pi.command({ type: "emit_event", event: { type: "agent_end" } }, 5000);
  assert.equal(manager.statuses()[session.id]?.type, "busy");

  const idle = nextIdle();
  await pi.command({ type: "emit_event", event: { type: "agent_idle" } }, 5000);
  await idle;
  assert.equal(manager.statuses()[session.id]?.type, "idle");
  for (const snapshot of snapshots) assert.equal(snapshot.reported, snapshot.event);
});

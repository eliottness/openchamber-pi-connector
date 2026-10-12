import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { PiRpcClient } from "../src/pi-rpc.js";
import type { LifecycleClock } from "../src/lifecycle.js";
import { SessionManager } from "../src/sessions.js";
import { SessionStore } from "../src/session-store.js";

const fixture = resolve("test/fixtures/fake-omo.mjs");
const deadline = () => AbortSignal.timeout(10_000);

class Clock implements LifecycleClock {
  time = 0;
  intervals: Array<{ callback: () => void; ms: number }> = [];
  timeouts: Array<{ callback: () => void; ms: number }> = [];
  now = () => this.time;
  setInterval = (callback: () => void, ms: number) => {
    this.intervals.push({ callback, ms });
    return setInterval(callback, 2_147_483_647);
  };
  clearInterval = clearInterval;
  setTimeout = (callback: () => void, ms: number) => {
    this.timeouts.push({ callback, ms });
    return setTimeout(callback, ms);
  };
  clearTimeout = clearTimeout;
}

interface State {
  pid: number;
  childPid: number;
  sessionId: string;
  sessionFile: string;
  resumed: boolean;
  history: string;
}

function gone(pid: number): void {
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
}

function setup(t: TestContext, maxLive = 8) {
  const dir = mkdtempSync(join(tmpdir(), "ocpi-t9-"));
  const previous = process.env.OCPI_PI_BINARY;
  process.env.OCPI_PI_BINARY = fixture;
  const clock = new Clock();
  const store = new SessionStore(join(dir, "state"));
  const manager = new SessionManager(() => undefined, store, dir, { clock, idleTimeoutMs: 100, maxLive });
  t.after(async () => {
    await manager.disposeAll();
    if (previous === undefined) delete process.env.OCPI_PI_BINARY;
    else process.env.OCPI_PI_BINARY = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  return { manager, clock, store, dir };
}

async function state(pi: PiRpcClient): Promise<State> {
  const response = await pi.command<State>({ type: "get_state" });
  assert.ok(response.data);
  return response.data;
}

test("dispose terminates the process group and is idempotent", { timeout: 15_000 }, async (t) => {
  const { dir } = setup(t);
  const pi = new PiRpcClient({ cwd: dir, piBinary: fixture, args: ["--require-group"] });
  t.after(() => pi.dispose());
  const before = await state(pi);
  const exited = once(pi, "exit", { signal: deadline() });
  await Promise.all([pi.dispose(), pi.dispose(), exited]);
  gone(before.pid);
  gone(before.childPid);
});

test("hung OmO receives SIGKILL at the injected five second deadline", { timeout: 15_000 }, async (t) => {
  const { dir, clock } = setup(t);
  const pi = new PiRpcClient({ cwd: dir, piBinary: fixture, args: ["--ignore-term"], clock });
  t.after(() => pi.dispose());
  const before = await state(pi);
  const exited = once(pi, "exit", { signal: deadline() });
  const termIgnored = new Promise<void>((resolveIgnored) => {
    pi.onEvent((event) => {
      if (event.type === "fake_term_ignored") resolveIgnored();
    });
  });
  const disposing = pi.dispose();
  await Promise.race([termIgnored, new Promise<never>((_, reject) =>
    deadline().addEventListener("abort", () => reject(new Error("SIGTERM not received")), { once: true }))]);
  const timeout = clock.timeouts.find((entry) => entry.ms === 5_000);
  assert.ok(timeout);
  timeout.callback();
  const [, signal] = await exited;
  await disposing;
  assert.equal(signal, "SIGKILL");
  gone(before.pid);
  gone(before.childPid);
});

test("reaper makes an expired session dormant and preserves registry and history", async (t) => {
  const { manager, clock, store, dir } = setup(t);
  const info = await manager.create(dir);
  await manager.prompt(info.id, "CONTEXT_TOKEN");
  const s = manager.get(info.id);
  assert.ok(s?.pi);
  const before = await state(s.pi);
  const messages = manager.messages(info.id);
  const metadata = store.get(info.id);
  assert.equal(clock.intervals[0]?.ms, 60_000);
  clock.time = 99;
  await manager.lifecycle.reap();
  assert.ok(s.pi);
  clock.time = 100;
  await manager.lifecycle.reap();
  assert.equal(s.pi, undefined);
  assert.deepEqual(s.restored, { piSessionId: before.sessionId, piPath: before.sessionFile });
  assert.equal(store.get(info.id)?.piPath, metadata?.piPath);
  assert.equal(store.get(info.id)?.piSessionId, metadata?.piSessionId);
  assert.equal(store.get(info.id)?.created, metadata?.created);
  assert.deepEqual(manager.messages(info.id), messages);
  gone(before.pid);
  gone(before.childPid);
  await manager.prompt(info.id, "RESUME_TOKEN");
  assert.ok(s.pi);
  const after = await state(s.pi);
  assert.notEqual(after.pid, before.pid);
  assert.equal(after.resumed, true);
  assert.equal(after.sessionId, before.sessionId);
  assert.match(after.history, /CONTEXT_TOKEN/);
  assert.match(after.history, /RESUME_TOKEN/);
  assert.equal(s.restored, undefined);
  assert.equal(store.get(info.id)?.piPath, metadata?.piPath);
  assert.equal(store.get(info.id)?.piSessionId, metadata?.piSessionId);
  assert.equal(store.get(info.id)?.created, metadata?.created);
});

test("reaper never disposes busy, pending-interaction or running-child sessions", async (t) => {
  const { manager, clock, dir } = setup(t);
  const infos = await Promise.all(Array.from({ length: 4 }, () => manager.create(dir)));
  const sessions = infos.map((info) => manager.get(info.id));
  const [busy, pending, children, retry] = sessions;
  assert.ok(busy && pending && children && retry);
  busy.status = { type: "busy" };
  pending.hasPendingInteraction = () => true;
  children.hasRunningChildren = () => true;
  retry.status = { type: "retry", attempt: 1, message: "retry", next: 1000 };
  clock.time = 1000;
  await manager.lifecycle.reap();
  for (const s of sessions) assert.ok(s?.pi);
});

test("cap disposes the least recently used idle session before concurrent admissions", async (t) => {
  const { manager, clock, dir } = setup(t, 2);
  const first = await manager.create(dir);
  clock.time = 1;
  const second = await manager.create(dir);
  clock.time = 2;
  await manager.prompt(first.id, "RECENT");
  const [third, fourth] = await Promise.all([manager.create(dir), manager.create(dir)]);
  assert.equal(manager.get(second.id)?.pi, undefined);
  assert.equal(manager.get(first.id)?.pi, undefined);
  assert.ok(manager.get(third.id)?.pi);
  assert.ok(manager.get(fourth.id)?.pi);
});

test("cap permits overflow rather than killing busy or protected sessions", async (t) => {
  const { manager, dir } = setup(t, 1);
  const first = await manager.create(dir);
  const s = manager.get(first.id);
  assert.ok(s);
  s.hasPendingInteraction = () => true;
  const second = await manager.create(dir);
  assert.ok(s.pi);
  assert.ok(manager.get(second.id)?.pi);
});

test("model selection revives with context and refreshes idle activity", async (t) => {
  const { manager, clock, dir } = setup(t);
  const info = await manager.create(dir);
  await manager.prompt(info.id, "MODEL_CONTEXT");
  clock.time = 100;
  await manager.lifecycle.reap();
  clock.time = 150;
  await manager.setModel(info.id, { providerID: "fake", modelID: "selected" });
  const s = manager.get(info.id);
  assert.ok(s?.pi);
  const resumed = await state(s.pi);
  assert.equal(resumed.resumed, true);
  assert.match(resumed.history, /MODEL_CONTEXT/);
  clock.time = 249;
  await manager.lifecycle.reap();
  assert.ok(s.pi);
  clock.time = 250;
  await manager.lifecycle.reap();
  assert.equal(s.pi, undefined);
});

test("shutdown during revival awaits the spawn and double shutdown leaves no process", async (t) => {
  const { manager, clock, dir } = setup(t);
  const info = await manager.create(dir);
  clock.time = 100;
  await manager.lifecycle.reap();
  const prompt = manager.prompt(info.id, "INTERRUPTED").catch((error: unknown) => error);
  const observeRevive = manager.lifecycle.run(async () => {
    const s = manager.get(info.id);
    assert.ok(s?.pi);
    return state(s.pi);
  });
  await Promise.all([manager.disposeAll(), manager.disposeAll(), prompt]);
  const resumed = await observeRevive;
  gone(resumed.pid);
  gone(resumed.childPid);
  assert.equal(manager.get(info.id), undefined);
  await assert.rejects(manager.create(dir), /stopping/);
});

test("deleting during revival removes metadata and prevents resurrection", async (t) => {
  const { manager, clock, store, dir } = setup(t);
  const info = await manager.create(dir);
  clock.time = 100;
  await manager.lifecycle.reap();
  const prompt = manager.prompt(info.id, "INTERRUPTED").catch((error: unknown) => error);
  await Promise.all([manager.remove(info.id), prompt]);
  assert.equal(manager.get(info.id), undefined);
  assert.equal(store.get(info.id), undefined);
});

test("shutdown joins an already started group disposal", async (t) => {
  const { manager, dir } = setup(t);
  const info = await manager.create(dir);
  const s = manager.get(info.id);
  assert.ok(s?.pi);
  const before = await state(s.pi);
  const disposing = manager.lifecycle.dormant(s);
  await manager.disposeAll();
  gone(before.pid);
  gone(before.childPid);
  await disposing;
});

test("connector SIGKILL closes stdin and fake OmO reaps its sleep child", { timeout: 15_000 }, async (t) => {
  const { dir } = setup(t);
  // Linux subreaper adopts OmO after its connector dies. waitpid is the exact
  // kernel exit signal, and also reaps the orphan before checking PID absence.
  const supervisor = spawn("python3", ["-c",
    `import ctypes, json, os, subprocess, sys
ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0)
connector = subprocess.Popen(sys.argv[1:], stdout=subprocess.PIPE)
state = json.loads(connector.stdout.readline())
state["connectorPid"] = connector.pid
print(json.dumps(state), flush=True)
while True:
    try:
        os.waitpid(-1, 0)
    except ChildProcessError:
        break
`, process.execPath, "--import", "tsx", "--input-type=module", "-e",
    `import {PiRpcClient} from "./src/pi-rpc.ts";
     const pi = new PiRpcClient({cwd:${JSON.stringify(dir)}, piBinary:${JSON.stringify(fixture)}});
     const state = await pi.command({type:"get_state"});
     console.log(JSON.stringify(state.data));
     pi.onExit(() => process.exit(0));`], { stdio: ["ignore", "pipe", "pipe"] });
  let result: (State & { connectorPid: number }) | undefined;
  const ready = new Promise<void>((resolveReady, reject) => {
    let buffer = "";
    supervisor.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      if (!buffer.includes("\n")) return;
      result = JSON.parse(buffer.trim());
      resolveReady();
    });
    supervisor.once("error", reject);
  });
  t.after(() => {
    if (result !== undefined) {
      for (const pid of [result.connectorPid, result.pid, result.childPid]) {
        try { process.kill(pid, "SIGKILL"); } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
        }
      }
    }
    supervisor.kill("SIGKILL");
  });
  await Promise.race([ready, new Promise<never>((_, reject) =>
    deadline().addEventListener("abort", () => reject(new Error("fixture startup timed out")), { once: true }))]);
  assert.ok(result);
  const exited = once(supervisor, "exit", { signal: deadline() });
  process.kill(result.connectorPid, "SIGKILL");
  const [code] = await exited;
  assert.equal(code, 0);
  gone(result.pid);
  gone(result.childPid);
});

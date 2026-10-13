import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownsSmokeWorkspace, processKind, SmokeContext } from "../contrib/smoke/context.js";

test("F2 B4 shutdown fails when detached hosts survive scoped cleanup", async () => {
  const survivors = [
    { pid: 101, argv: ["bun", "cli.js", "--mode", "rpc", "--multi-session"] },
    { pid: 102, argv: ["bun", "cli.js", "--internal-rpc-host-supervisor"] },
  ];
  const signals: number[] = [];
  const context = {
    capture: () => survivors,
    terminate: async (identities: typeof survivors) => { signals.push(...identities.map((identity) => identity.pid)); },
  };
  await assert.rejects(async () => Reflect.apply(SmokeContext.prototype.assertShutdownProcesses, context, []), /surviv/);
  assert.deepEqual(signals, [101, 102], "detached hosts must be cleaned before the final assertion");
});

test("F2 B4 ordinary RPC survivors fail even when fallback cleanup could terminate them", async () => {
  const context = {
    capture: () => [{ pid: 103, argv: ["bun", "cli.js", "--mode", "rpc"] }],
    terminate: async () => { throw new Error("ordinary RPC must not be hidden by fallback cleanup"); },
  };
  await assert.rejects(async () => Reflect.apply(SmokeContext.prototype.assertShutdownProcesses, context, []), /RPC/);
});

test("F2 B4 live fake detached survivor fails until the harness actually cleans its PID", { timeout: 10_000 }, async (t) => {
  const source = mkdtempSync(join(tmpdir(), "ocpi-smoke-source-"));
  const previousAgent = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = source;
  const context = new SmokeContext("/unused-omo", AbortSignal.timeout(10_000));
  if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgent;
  t.after(async () => {
    Reflect.deleteProperty(context, "terminate");
    await context.cleanup();
    rmSync(source, { recursive: true, force: true });
  });
  const child = spawn(process.execPath, ["-e", 'process.stdout.write("READY\\n"); setInterval(() => {}, 1000)', "--", "--internal-rpc-host-supervisor"], {
    cwd: context.work, detached: true, stdio: ["ignore", "pipe", "ignore"],
    env: { ...process.env, HOME: join(context.root, "home"), PI_CODING_AGENT_DIR: context.agent },
  });
  const exited = once(child, "exit");
  assert.ok(child.stdout);
  await once(child.stdout, "data", { signal: AbortSignal.timeout(5_000) });
  const pid = child.pid;
  assert.ok(pid);
  // Deliberately leave a real owned helper alive: the final assertion must fail.
  Object.defineProperty(context, "terminate", { configurable: true, value: async () => undefined });
  await assert.rejects(context.assertShutdownProcesses(), /survive scoped shutdown cleanup/);
  assert.doesNotThrow(() => process.kill(pid, 0));
  console.log(`FAKE SURVIVOR FAIL proved: pid=${child.pid} remained alive after deliberately ineffective cleanup`);
  Reflect.deleteProperty(context, "terminate");
  await context.assertShutdownProcesses();
  await exited;
  context.assertNoOwnedProcesses();
  console.log(`FAKE SURVIVOR CLEANUP PASS: pid=${child.pid} exited; no owned processes remain`);
});

test("detached ownership requires exact private environment and scoped cwd", () => {
  const root = "/tmp/ocomo-qa/smoke-run";
  const agent = `${root}/home/.omo/agent`;
  assert.equal(ownsSmokeWorkspace(`${root}/work`, [`HOME=${root}/home`], root, agent), true);
  assert.equal(ownsSmokeWorkspace(`${root}/work`, [`PI_CODING_AGENT_DIR=${agent}`], root, agent), true);
  assert.equal(ownsSmokeWorkspace(`${root}/work`, ["HOME=/home/eliott"], root, agent), false);
  assert.equal(ownsSmokeWorkspace("/home/eliott", [`HOME=${root}/home`], root, agent), false);
  assert.equal(ownsSmokeWorkspace(`${root}-other/work`, [`HOME=${root}/home`], root, agent), false);
  assert.equal(ownsSmokeWorkspace(`${root}/work`, [`HOME=${root}/home-other`], root, agent), false);
});

test("session RPC is distinct from detached task host supervisor and engine", () => {
  assert.equal(processKind(["bun", "cli.js", "--mode", "rpc", "--session", "qa.jsonl"]), "rpc");
  assert.equal(processKind(["bun", "cli.js", "--internal-rpc-host-supervisor"]), "task-host");
  assert.equal(processKind(["bun", "cli.js", "--mode", "rpc", "--multi-session"]), "task-host");
  assert.equal(processKind(["bun", "/private/plugin/runtime/lsp-daemon/dist/cli.js", "daemon"]), "detached-service");
  assert.equal(processKind(["node", "connector.js"]), "other");
});

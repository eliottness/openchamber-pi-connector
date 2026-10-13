import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownsSmokeWorkspace, processKind, SmokeContext } from "../contrib/smoke/context.js";

test("F2 B4 private task hosts fail before any harness termination can hide them", async () => {
  let survivors = [
    { pid: 101, group: 101, argv: ["bun", "cli.js", "--mode", "rpc", "--multi-session"] },
    { pid: 102, group: 102, argv: ["bun", "cli.js", "--internal-rpc-host-supervisor"] },
  ];
  const signals: number[] = [];
  const context = {
    owned: new Map(survivors.map((info) => [info.pid, info])),
    capture: () => survivors,
    terminate: async () => {
      signals.push(...survivors.map((info) => info.pid));
      survivors = [];
    },
  };
  await assert.rejects(async () => Reflect.apply(SmokeContext.prototype.assertShutdownProcesses, context, []), /SIGTERM/);
  assert.deepEqual(signals, [], "shutdown acceptance must precede all harness cleanup");
});

test("F2 B4 shutdown rejects private detached hosts without scoped cleanup", async () => {
  const survivors = [
    { pid: 101, argv: ["bun", "cli.js", "--mode", "rpc", "--multi-session"] },
    { pid: 102, argv: ["bun", "cli.js", "--internal-rpc-host-supervisor"] },
  ];
  const signals: number[] = [];
  const context = {
    owned: new Map(),
    capture: () => survivors,
    terminate: async (identities: typeof survivors) => { signals.push(...identities.map((identity) => identity.pid)); },
  };
  await assert.rejects(async () => Reflect.apply(SmokeContext.prototype.assertShutdownProcesses, context, []), /surviv/);
  assert.deepEqual(signals, [], "cleanup must never determine connector shutdown acceptance");
});

test("F2 B4 ordinary RPC survivors fail even when fallback cleanup could terminate them", async () => {
  const context = {
    owned: new Map(),
    capture: () => [{ pid: 103, argv: ["bun", "cli.js", "--mode", "rpc"] }],
    terminate: async () => { throw new Error("ordinary RPC must not be hidden by fallback cleanup"); },
  };
  await assert.rejects(async () => Reflect.apply(SmokeContext.prototype.assertShutdownProcesses, context, []), /RPC/);
});

test("F2 B4 live private survivor fails shutdown even when harness cleanup can kill it", { timeout: 10_000 }, async (t) => {
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
  await assert.rejects(context.assertShutdownProcesses(), /survive SIGTERM/);
  assert.doesNotThrow(() => process.kill(pid, 0));
  console.log(`FAKE SURVIVOR FAIL proved: pid=${child.pid} remained alive after deliberately ineffective cleanup`);
  Reflect.deleteProperty(context, "terminate");
  await assert.rejects(context.assertShutdownProcesses(), /survive SIGTERM/);
  await context.cleanup();
  await exited;
  context.assertNoOwnedProcesses();
  console.log(`FAKE SURVIVOR CLEANUP PASS: pid=${child.pid} exited; no owned processes remain`);
});

test("F2 B4 shared LSP is reported separately and is never killed by the shutdown assertion", async (t) => {
  const daemon = { pid: 201, group: 201, argv: ["bun", "/private/plugin/runtime/lsp-daemon/dist/cli.js", "daemon"] };
  const server = { pid: 202, ppid: 201, group: 202, argv: ["typescript-language-server", "--stdio"] };
  const lines: string[] = [];
  t.mock.method(console, "log", (line: string) => lines.push(line));
  const context = {
    owned: new Map(),
    capture: () => [daemon, server],
    terminate: async () => { assert.fail("shared infrastructure is not connector teardown"); },
  };
  await Reflect.apply(SmokeContext.prototype.assertShutdownProcesses, context, []);
  assert.equal(lines.length, 2);
  for (const info of [daemon, server]) {
    assert.ok(lines.some((line) => line.includes(`pid=${info.pid}`) && line.includes(info.argv.join(" ")) &&
      line.includes("NON-CONNECTOR") && line.includes("OmO-owned, outside connector scope")));
  }
});

test("F2 B4 an LSP-looking process inside a connector RPC group remains a shutdown failure", async () => {
  const rpc = { pid: 301, group: 301, argv: ["bun", "cli.js", "--mode", "rpc"] };
  const daemon = { pid: 302, group: 301, argv: ["bun", "/private/plugin/runtime/lsp-daemon/dist/cli.js", "daemon"] };
  const context = {
    owned: new Map([[rpc.pid, rpc]]),
    capture: () => [daemon],
    terminate: async () => { assert.fail("connector group survivors must fail before cleanup"); },
  };
  await assert.rejects(async () => Reflect.apply(SmokeContext.prototype.assertShutdownProcesses, context, []), /SIGTERM/);
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

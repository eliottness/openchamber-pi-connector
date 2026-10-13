import assert from "node:assert/strict";
import cp, { type SpawnOptions } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { stopSessionHosts } from "../src/session-hosts.js";

interface ProcessRecord {
  pid: number;
  start: string;
  group: number;
  argv: string[];
  alive: boolean;
}

interface SignalRecord {
  pid: number;
  signal: string;
  startAtSignal: string;
  nonOwned: boolean;
}

interface ProbeResult {
  replaced: boolean;
  signals: SignalRecord[];
  protectedAlive: boolean;
}

// The F2 reviewer used these inert PID values and replaced the engine between
// the third stat and cmdline reads. No fake PID is ever sent to an OS syscall.
for (const scenario of [
  "stable-identities",
  "reuse-before-final-stat",
  "reuse-between-final-stat-and-cmdline",
  "reuse-after-pidfd-open",
  "reuse-at-signal",
  "reuse-before-escalation",
  "same-tick-reuse-before-open",
  "stubborn-engine",
  "group-change",
  "pidfd-unavailable",
  "pidfd-permission-denied",
]) test(`B4-REUSE ${scenario} never signals the replacement`, async (t) => {
  const owner = "reviewer-inert-owner";
  const cwd = "/reviewer/inert";
  const socket = `/inert/p-${createHash("sha256").update(`p:${owner}`).digest("hex").slice(0, 16)}.sock`;
  const host = 100000001, engine = 100000002, lsp = 100000003, web = 100000004, other = 100000005;
  const table = new Map<number, ProcessRecord>([
    [host, { pid: host, start: "10", group: host, argv: ["node", "--internal-rpc-host-supervisor", "--socket", socket], alive: true }],
    [engine, { pid: engine, start: "11", group: host, argv: ["node", "--mode", "rpc", "--multi-session"], alive: true }],
    [lsp, { pid: lsp, start: "12", group: lsp, argv: ["node", "--lsp-daemon", "--socket", socket], alive: true }],
    [web, { pid: web, start: "13", group: web, argv: ["openchamber", "serve"], alive: true }],
    [other, { pid: other, start: "14", group: other, argv: ["node", "--internal-rpc-host-supervisor", "--socket", "/inert/p-other.sock"], alive: true }],
  ]);
  const original = {
    read: fs.readFileSync, dirs: fs.readdirSync, link: fs.readlinkSync,
    open: fs.openSync, close: fs.closeSync, spawn: cp.spawn,
  };
  const directories = new Map<number, ProcessRecord>();
  const counts = new Map<string, number>();
  const signals: SignalRecord[] = [];
  let replaced = false;
  let nextFd = 8000;
  let helperResult: ProbeResult | undefined;
  const replace = (): void => {
    const old = table.get(engine);
    assert.ok(old);
    old.alive = false;
    table.set(engine, { pid: engine, start: "99", group: engine, argv: ["openchamber", "unrelated-reused-pid"], alive: true });
    replaced = true;
  };
  const missing = () => Object.assign(new Error("gone"), { code: "ENOENT" });
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  t.mock.method(fs, "readdirSync", (path: fs.PathLike, ...args: unknown[]) =>
    String(path) === "/proc" ? [...table.keys()].map(String) : Reflect.apply(original.dirs, fs, [path, ...args]));
  t.mock.method(fs, "openSync", (path: fs.PathLike, ...args: unknown[]) => {
    const match = String(path).match(/^\/proc\/(10000000[1-5])$/);
    if (!match) return Reflect.apply(original.open, fs, [path, ...args]);
    const record = table.get(Number(match[1]));
    if (!record?.alive) throw missing();
    const fd = nextFd++;
    directories.set(fd, record);
    return fd;
  });
  t.mock.method(fs, "closeSync", (fd: number) => {
    if (directories.delete(fd)) return;
    return original.close(fd);
  });
  const recordAt = (path: string): ProcessRecord | undefined => {
    const bound = path.match(/^\/proc\/self\/fd\/(\d+)\//);
    if (bound) return directories.get(Number(bound[1]));
    const numeric = path.match(/^\/proc\/(10000000[1-5])\//);
    return numeric ? table.get(Number(numeric[1])) : undefined;
  };
  t.mock.method(fs, "readlinkSync", (path: fs.PathLike, ...args: unknown[]) => {
    const record = recordAt(String(path));
    if (!record) return Reflect.apply(original.link, fs, [path, ...args]);
    if (!record.alive) throw missing();
    return cwd;
  });
  t.mock.method(fs, "readFileSync", (path: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    const name = String(path);
    const record = recordAt(name);
    if (!record) return Reflect.apply(original.read, fs, [path, ...args]);
    const kind = name.endsWith("/stat") ? "stat" : "cmdline";
    const key = `${record.pid}:${kind}`;
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    if (record.pid === engine && count === 3 &&
        ((scenario === "reuse-before-final-stat" && kind === "stat") ||
         (scenario === "reuse-between-final-stat-and-cmdline" && kind === "cmdline"))) replace();
    // Open proc directories keep the old identity; numeric paths resolve anew.
    const current = recordAt(name);
    if (!current?.alive) throw missing();
    if (kind === "cmdline") return current.argv.join("\0") + "\0";
    const fields = Array<string>(20).fill("0");
    fields[0] = "S"; fields[2] = String(current.group); fields[19] = current.start;
    return `${current.pid} (fixture) ${fields.join(" ")}`;
  });
  t.mock.method(cp, "spawn", (binary: string, args: string[], options: SpawnOptions) => {
    if (binary === "tail") {
      const watcher = new EventEmitter();
      queueMicrotask(() => watcher.emit("exit", 0, null));
      return watcher;
    }
    assert.equal(binary, "/bin/python3");
    assert.ok(Array.isArray(options.stdio));
    const inherited = options.stdio.slice(3).map((fd, index) => {
      assert.equal(typeof fd, "number");
      assert.ok(typeof fd === "number");
      const record = directories.get(fd);
      assert.ok(record);
      return [index + 3, record];
    });
    const child = original.spawn("/bin/python3", [
      "-I", resolve("test/fixtures/pidfd-host-probe.py"),
      ...args.slice(args.indexOf("-c") + 1),
      JSON.stringify({ scenario, processes: [...table.values()], inherited }),
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.stdout.on("end", () => { if (output.trim()) helperResult = JSON.parse(output); });
    return child;
  });
  t.mock.method(process, "kill", (pid: number, signal: string) => {
    const current = table.get(pid);
    assert.ok(current?.alive);
    signals.push({ pid, signal, startAtSignal: current.start, nonOwned: pid !== host && (pid !== engine || current.start !== "11") });
    current.alive = false;
    return true;
  });
  syncBuiltinESMExports();

  const failClosed = ["group-change", "pidfd-unavailable", "pidfd-permission-denied"].includes(scenario);
  if (failClosed) {
    await assert.rejects(stopSessionHosts(new Map([[owner, cwd]])), /pidfd teardown failed/);
  } else {
    await stopSessionHosts(new Map([[owner, cwd]]));
  }

  const result = helperResult ?? {
    replaced, signals, protectedAlive: [lsp, web, other].every((pid) => table.get(pid)?.alive),
  };
  t.diagnostic(JSON.stringify({ scenario, ...result }));
  assert.equal(result.replaced, scenario.includes("reuse"), "the adversarial interleaving must actually run");
  assert.equal(result.protectedAlive, true);
  assert.deepEqual(result.signals.filter((entry) => entry.nonOwned), [], "no signal may reach a replacement process");
  if (scenario === "stable-identities") assert.deepEqual(result.signals.map((entry) => entry.pid).sort(), [host, engine]);
  if (failClosed) assert.deepEqual(result.signals, [], "acquisition must fail before any host is signalled");
  if (scenario === "stubborn-engine") {
    assert.deepEqual(result.signals.filter((entry) => entry.pid === engine).map((entry) => entry.signal), ["SIGTERM", "SIGKILL"]);
  }
  assert.equal(directories.size, 0, "close every captured proc directory");
});

async function startFixture(t: TestContext, cwd: string, args: readonly string[]) {
  const child = cp.spawn(process.execPath, args, { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(child, "exit");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await exited;
  });
  const [data] = await once(child.stdout, "data", { signal: AbortSignal.timeout(10_000) });
  assert.ok(child.pid);
  return { child, pid: child.pid, exited, data: String(data) };
}

const hostArgs = (directory: string, owner: string) => [
  resolve("test/fixtures/fake-omo-host.mjs"), "--internal-rpc-host-supervisor", "--socket",
  join(directory, `p-${createHash("sha256").update(`p:${owner}`).digest("hex").slice(0, 16)}.sock`),
] as const;

test("B4-REUSE real owned group exits while unrelated, shared LSP, OpenChamber and another session survive", { timeout: 15_000 }, async (t) => {
  const directory = fs.mkdtempSync(join(tmpdir(), "ocpi-reuse-real-"));
  const owner = randomUUID();
  try {
    const owned = await startFixture(t, directory, hostArgs(directory, owner));
    const other = await startFixture(t, directory, hostArgs(directory, randomUUID()));
    const spectators = [];
    for (const marker of ["unrelated", "--lsp-daemon", "openchamber"]) {
      spectators.push(await startFixture(t, directory, [
        "-e", 'process.stdout.write("READY\\n"); setInterval(() => {}, 2147483647)',
        "--", marker, "--socket", hostArgs(directory, owner)[3],
      ]));
    }
    const identity: { pid: number; enginePid: number } = JSON.parse(owned.data);
    const otherIdentity: { pid: number; enginePid: number } = JSON.parse(other.data);
    const ownedPids = [identity.pid, identity.enginePid];
    const protectedPids = [otherIdentity.pid, otherIdentity.enginePid, ...spectators.map((entry) => entry.pid)];
    for (const pid of [...ownedPids, ...protectedPids]) {
      assert.doesNotMatch(fs.readFileSync(`/proc/${pid}/cgroup`, "utf8"), /\/openchamber\.service/);
    }

    await stopSessionHosts(new Map([[owner, directory]]));
    await owned.exited;

    for (const pid of ownedPids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    for (const pid of protectedPids) assert.doesNotThrow(() => process.kill(pid, 0));
    t.diagnostic(JSON.stringify({ ownedGone: ownedPids, protectedAlive: protectedPids }));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("B4-REUSE unavailable Python reports an error and leaves every owned member alive", { timeout: 15_000 }, async (t) => {
  const directory = fs.mkdtempSync(join(tmpdir(), "ocpi-reuse-no-python-"));
  const owner = randomUUID();
  const originalSpawn = cp.spawn;
  try {
    const owned = await startFixture(t, directory, hostArgs(directory, owner));
    const identity: { pid: number; enginePid: number } = JSON.parse(owned.data);
    t.mock.method(cp, "spawn", (binary: string, args: string[], options: SpawnOptions) => {
      assert.equal(binary, "/bin/python3");
      return originalSpawn(join(directory, "missing-python3"), args, options);
    });
    syncBuiltinESMExports();

    await assert.rejects(stopSessionHosts(new Map([[owner, directory]])), { code: "ENOENT" });

    assert.doesNotThrow(() => process.kill(identity.pid, 0));
    assert.doesNotThrow(() => process.kill(identity.enginePid, 0));
    t.diagnostic(JSON.stringify({ pythonUnavailable: true, ownedAlive: [identity.pid, identity.enginePid] }));
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

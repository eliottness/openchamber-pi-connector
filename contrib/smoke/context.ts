import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { OCEvent, OCMessageWithParts, OCSession } from "../../src/types.js";
import { SseCollector } from "./core.js";

interface ProcessIdentity {
  pid: number;
  ppid: number;
  group: number;
  start: string;
  state: string;
}

function processInfo(pid: number): ProcessIdentity | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return { pid, ppid: Number(fields[1]), group: Number(fields[2]), start: fields[19] ?? "", state: fields[0] ?? "" };
  } catch (error) {
    if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ESRCH")) return undefined;
    throw error;
  }
}

function alive(identity: ProcessIdentity): boolean {
  const current = processInfo(identity.pid);
  return current !== undefined && current.start === identity.start && current.state !== "Z";
}

function signalOwned(identity: ProcessIdentity, signal: NodeJS.Signals): void {
  if (!alive(identity)) return;
  try {
    process.kill(identity.pid === identity.group ? -identity.group : identity.pid, signal);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
}

function childExit(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
}

async function bounded<T>(promise: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  const deadline = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  combined.throwIfAborted();
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      abort = () => reject(combined.reason);
      combined.addEventListener("abort", abort, { once: true });
    })]);
  } finally {
    if (abort) combined.removeEventListener("abort", abort);
  }
}

async function freePort(): Promise<number> {
  for (let port = 57182; port <= 57189; port++) {
    const server = createServer();
    const available = await new Promise<boolean>((resolve) => {
      server.once("error", () => resolve(false));
      server.listen(port, "127.0.0.1", () => resolve(true));
    });
    if (available) {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      return port;
    }
  }
  throw new Error("no free connector port in 57182-57189");
}

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const MODEL = { providerID: "anthropic", modelID: "claude-haiku-4-5" };

export class SmokeContext {
  readonly root: string;
  readonly work: string;
  readonly state: string;
  readonly agent: string;
  readonly sourceAgent: string;
  readonly marker = `OCOMO-${Date.now()}-${process.pid}`;
  readonly shutdownSignal: AbortSignal;
  session: OCSession | undefined;
  sse = new SseCollector();
  url = "";
  connectorPid: number | undefined;
  private readonly wrapper: string;
  private launcher: ChildProcess | undefined;
  private exited: Promise<number | null> | undefined;
  private owned = new Map<number, ProcessIdentity>();
  private observer: ReturnType<typeof setInterval> | undefined;
  private output = "";

  constructor(binary: string, shutdownSignal: AbortSignal) {
    mkdirSync("/tmp/ocomo-qa", { recursive: true });
    this.root = mkdtempSync(`/tmp/ocomo-qa/smoke-${Date.now()}-`);
    this.work = join(this.root, "work");
    this.state = join(this.root, "state");
    const home = join(this.root, "home");
    this.agent = join(home, ".omo", "agent");
    this.sourceAgent = process.env.PI_CODING_AGENT_DIR ?? "/home/eliott/.omo/agent";
    this.shutdownSignal = shutdownSignal;
    for (const directory of [this.work, this.state, this.agent]) mkdirSync(directory, { recursive: true, mode: 0o700 });
    // Copy, never symlink, mutable credentials/config. No sessions or memory are copied.
    for (const file of ["auth.json", "settings.json", "models.json", "models-store.json", "credential-pool-state.json", "trust.json", "mcp.json"]) {
      const source = join(this.sourceAgent, file);
      if (existsSync(source)) copyFileSync(source, join(this.agent, file));
    }
    for (const file of ["omo.json", "omo.jsonc"]) {
      const source = join(dirname(this.sourceAgent), file);
      if (existsSync(source)) copyFileSync(source, join(home, ".omo", file));
    }
    // Speculative task hosts are shared daemons, not session processes. Part A
    // exercises no task calls: do not warm unrelated hosts in this QA project.
    // Task execution remains enabled for the part B modules.
    mkdirSync(join(this.work, ".omo"), { mode: 0o700 });
    writeFileSync(join(this.work, ".omo", "omo.jsonc"),
      JSON.stringify({ task: { host_shard_prewarm: "off" } }) + "\n", { mode: 0o600 });
    this.wrapper = join(this.root, "omo-isolated");
    writeFileSync(this.wrapper, [
      "#!/bin/sh",
      `export HOME=${shellQuote(home)}`,
      `export OMO_CODING_AGENT_DIR=${shellQuote(this.agent)}`,
      `export SENPI_CODING_AGENT_DIR=${shellQuote(this.agent)}`,
      `export PI_CODING_AGENT_DIR=${shellQuote(this.agent)}`,
      `exec ${shellQuote(binary)} "$@" --model anthropic/claude-haiku-4-5 --thinking off`,
      "",
    ].join("\n"), { mode: 0o700 });
    console.log(`workspace: ${this.root}`);
  }

  private capture(): ProcessIdentity[] {
    const all = readdirSync("/proc").filter((name) => /^\d+$/.test(name)).flatMap((name) => {
      const info = processInfo(Number(name));
      return info ? [info] : [];
    });
    const roots = new Set([...this.owned.values()].filter(alive).map((info) => info.pid));
    if (this.launcher?.pid) roots.add(this.launcher.pid);
    let changed = true;
    while (changed) {
      changed = false;
      for (const info of all) {
        if (roots.has(info.ppid) && !roots.has(info.pid)) {
          roots.add(info.pid);
          changed = true;
        }
      }
    }
    for (const info of all) if (roots.has(info.pid)) this.owned.set(info.pid, info);
    return all.filter((info) => roots.has(info.pid) && info.state !== "Z");
  }

  agentPids(): ProcessIdentity[] {
    return this.capture().filter((info) => info.pid === info.group && info.pid !== this.launcher?.pid);
  }

  async start(signal: AbortSignal, isolatedDiscovery = false, idleTimeoutMs = 900_000): Promise<void> {
    const port = await freePort();
    this.output = "";
    const cwd = fileURLToPath(new URL("../../", import.meta.url));
    // A harness launched inside OmO must not inherit its caller's host sockets,
    // watchdog fd, or cleanup paths (some point into the real agent directory).
    const environment = { ...process.env };
    for (const key of Object.keys(environment)) {
      if (/^(OMO|SENPI|PI)_RPC_/.test(key)) delete environment[key];
    }
    this.launcher = spawn("npx", ["--no-install", "tsx", "src/cli.ts", "serve", "--hostname", "127.0.0.1", "--port", String(port), "--directory", this.work], {
      cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...environment,
        HOME: join(this.root, "home"),
        OCPI_PI_BINARY: this.wrapper,
        OCPI_STATE_DIR: this.state,
        PI_CODING_AGENT_DIR: isolatedDiscovery ? this.agent : this.sourceAgent,
        OCPI_IDLE_TIMEOUT_MS: String(idleTimeoutMs),
        OCPI_MAX_LIVE: "8",
      },
    });
    this.exited = childExit(this.launcher);
    void this.exited.catch(() => undefined);
    this.capture();
    // Sampling tracks descendants for teardown, never decides a check's PASS.
    this.observer ??= setInterval(() => this.capture(), 100);
    const ready = new Promise<void>((resolve, reject) => {
      this.launcher?.stdout?.on("data", (chunk: Buffer) => {
        this.output = (this.output + chunk.toString()).slice(-16_384);
        if (this.output.includes(`opencode server listening on http://127.0.0.1:${port}`)) resolve();
      });
      this.launcher?.stderr?.on("data", (chunk: Buffer) => { this.output = (this.output + chunk.toString()).slice(-16_384); });
      this.launcher?.once("error", reject);
      this.launcher?.once("exit", (code) => reject(new Error(`connector exited before listening: code=${code}\n${this.output}`)));
    });
    await bounded(ready, 30_000, signal);
    this.url = `http://127.0.0.1:${port}`;
    const processes = this.capture();
    this.connectorPid = processes.find((info) => {
      try {
        const args = readFileSync(`/proc/${info.pid}/cmdline`, "utf8");
        return args.includes("src/cli.ts") && args.includes("loader");
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
        throw error;
      }
    })?.pid;
    assert.ok(this.connectorPid, "actual connector CLI pid must be present in its process tree");
    this.sse = new SseCollector();
    await this.sse.start(this.url, this.shutdownSignal);
    console.log(`connector: ${this.url} pid=${this.connectorPid} discovery=${isolatedDiscovery ? "isolated" : "existing read-only"}`);
  }

  async api<T>(path: string, signal: AbortSignal, body?: unknown): Promise<T> {
    const response = await fetch(`${this.url}${path}`, {
      method: body === undefined ? "GET" : "POST",
      ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(90_000)]),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}: ${text}`);
    return JSON.parse(text || "null");
  }

  sessionId(): string {
    assert.ok(this.session, "only the smoke-created session may receive actions");
    assert.equal(this.session.directory, this.work);
    return this.session.id;
  }

  waitForEvent(predicate: (event: OCEvent) => boolean, timeoutMs: number, signal: AbortSignal): Promise<OCEvent> {
    return this.sse.waitForEvent(predicate, timeoutMs, signal);
  }

  idle(signal: AbortSignal, timeoutMs = 120_000): Promise<OCEvent> {
    const id = this.sessionId();
    return this.waitForEvent((event) => event.type === "session.idle" && event.properties.sessionID === id, timeoutMs, signal);
  }

  delta(signal: AbortSignal): Promise<OCEvent> {
    const id = this.sessionId();
    return this.waitForEvent((event) => event.type === "message.part.updated" &&
      event.properties.part.sessionID === id && event.properties.part.type === "text" &&
      typeof event.properties.delta === "string" && event.properties.delta.length > 0, 120_000, signal);
  }

  async prompt(text: string, signal: AbortSignal): Promise<void> {
    await this.api(`/session/${this.sessionId()}/prompt_async`, signal, { model: MODEL, parts: [{ type: "text", text }] });
  }

  async messages(signal: AbortSignal): Promise<OCMessageWithParts[]> {
    return this.api(`/session/${this.sessionId()}/message`, signal);
  }

  /** GNU tail subscribes to PID death; no fixed sleep can make this check pass. */
  waitForDeath(identities: readonly ProcessIdentity[], timeoutMs: number, signal: AbortSignal): Promise<void> {
    const wait = Promise.all(identities.filter(alive).map(async (identity) => {
      const watcher = spawn("tail", [`--pid=${identity.pid}`, "--sleep-interval=0.1", "-f", "/dev/null"], {
        stdio: "ignore",
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
      });
      assert.equal(await childExit(watcher), 0, `PID watcher failed for ${identity.pid}`);
      assert.equal(alive(identity), false, `owned pid ${identity.pid} must disappear`);
    })).then(() => undefined);
    void wait.catch(() => undefined);
    return wait;
  }

  async stop(signal: AbortSignal): Promise<void> {
    this.capture();
    await this.sse.stop();
    if (this.connectorPid) {
      const identity = this.owned.get(this.connectorPid);
      if (identity) signalOwned(identity, "SIGTERM");
    }
    if (this.exited) assert.equal(await bounded(this.exited, 15_000, signal), 0, "connector must shut down cleanly");
    this.launcher = undefined;
    this.connectorPid = undefined;
    this.exited = undefined;
  }

  assertNoOwnedProcesses(): void {
    const remaining = [...this.owned.values()].filter(alive);
    assert.deepEqual(remaining.map((identity) => identity.pid), [], "no connector-owned processes may survive");
  }

  async cleanup(): Promise<void> {
    clearInterval(this.observer);
    this.capture();
    await this.sse.stop();
    const identities = [...this.owned.values()].filter(alive);
    const death = this.waitForDeath(identities, 15_000, AbortSignal.timeout(16_000));
    for (const identity of identities) signalOwned(identity, "SIGTERM");
    const escalation = setTimeout(() => {
      for (const identity of identities) signalOwned(identity, "SIGKILL");
    }, 6_000);
    try {
      await death;
      this.assertNoOwnedProcesses();
      console.log("CLEANUP PASS: no owned connector or OmO processes remain");
    } finally {
      clearTimeout(escalation);
      rmSync(this.root, { recursive: true, force: true });
    }
  }

  diagnostics(): string {
    return this.output;
  }
}

export function assistantText(messages: readonly OCMessageWithParts[]): string {
  return messages.filter((message) => message.info.role === "assistant")
    .flatMap((message) => message.parts)
    .filter((part) => part.type === "text")
    .map((part) => part.text).join("\n");
}

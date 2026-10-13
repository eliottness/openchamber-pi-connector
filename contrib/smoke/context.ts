import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { OCMessageWithParts, OCSession } from "../../src/types.js";
import { SseCollector, type SmokeEvent } from "./core.js";

interface ProcessIdentity {
  pid: number;
  ppid: number;
  group: number;
  start: string;
  state: string;
  argv: string[];
}

export function processKind(argv: readonly string[]): "rpc" | "task-host" | "detached-service" | "other" {
  if (argv.includes("--internal-rpc-host-supervisor") || argv.includes("--multi-session")) return "task-host";
  if (argv.some((arg) => arg.includes("/plugin/runtime/lsp-daemon/dist/cli.js")) && argv.includes("daemon")) {
    return "detached-service";
  }
  return argv.some((arg, i) => arg === "--mode" && argv[i + 1] === "rpc") ? "rpc" : "other";
}

/** Reparented hosts need both a private cwd and an exact private environment. */
export function ownsSmokeWorkspace(cwd: string, environment: readonly string[], root: string, agent: string): boolean {
  return (cwd === root || cwd.startsWith(`${root}/`)) &&
    environment.some((entry) => entry === `HOME=${root}/home` ||
      ["PI_CODING_AGENT_DIR", "OMO_CODING_AGENT_DIR", "SENPI_CODING_AGENT_DIR"].some((key) => entry === `${key}=${agent}`));
}

function processInfo(pid: number): ProcessIdentity | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
    return { pid, ppid: Number(fields[1]), group: Number(fields[2]), start: fields[19] ?? "", state: fields[0] ?? "", argv };
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
    assert.ok(!readFileSync(`/proc/${identity.pid}/cgroup`, "utf8").includes("/openchamber.service"),
      `refusing to signal live service pid=${identity.pid}`);
    process.kill(identity.pid, signal);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && (error.code === "ESRCH" || error.code === "ENOENT"))) throw error;
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
    // Detached task hosts do not inherit the wrapper's CLI flags. Seed OmO's
    // private first-run marker so their first turn is the requested smoke task,
    // not onboarding. This never touches the user's agent directory.
    const onboardingState = join(this.agent, "omo-senpi", "omo-native");
    mkdirSync(onboardingState, { recursive: true, mode: 0o700 });
    writeFileSync(join(onboardingState, "onboarding-completed"),
      JSON.stringify({ completedAt: new Date().toISOString(), version: 1 }), { mode: 0o600 });
    // Copy, never symlink, mutable credentials/config. No sessions or memory are copied.
    for (const file of ["auth.json", "settings.json", "models.json", "models-store.json", "credential-pool-state.json", "trust.json", "mcp.json"]) {
      const source = join(this.sourceAgent, file);
      if (existsSync(source)) copyFileSync(source, join(this.agent, file));
    }
    for (const file of ["omo.json", "omo.jsonc"]) {
      const source = join(dirname(this.sourceAgent), file);
      if (existsSync(source)) copyFileSync(source, join(home, ".omo", file));
    }
    this.wrapper = join(this.root, "omo-isolated");
    writeFileSync(this.wrapper, [
      "#!/bin/sh",
      `export HOME=${shellQuote(home)}`,
      `export OMO_CODING_AGENT_DIR=${shellQuote(this.agent)}`,
      `export SENPI_CODING_AGENT_DIR=${shellQuote(this.agent)}`,
      `export PI_CODING_AGENT_DIR=${shellQuote(this.agent)}`,
      `exec ${shellQuote(binary)} "$@" --model anthropic/claude-haiku-4-5 --thinking off --omo-senpi-onboarding-disabled`,
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
    // Detached task hosts can be reparented before the first descendant sample.
    // Never adopt on a broad cmdline match: prove the private cwd AND environment.
    for (const info of all) {
      if (roots.has(info.pid) || info.state === "Z") continue;
      try {
        const cwd = readlinkSync(`/proc/${info.pid}/cwd`);
        if (cwd !== this.root && !cwd.startsWith(`${this.root}/`)) continue;
        const environment = readFileSync(`/proc/${info.pid}/environ`, "utf8").split("\0");
        if (ownsSmokeWorkspace(cwd, environment, this.root, this.agent)) roots.add(info.pid);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && ["ENOENT", "ESRCH", "EACCES"].includes(String(error.code)))) throw error;
      }
    }
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
    return this.capture().filter((info) => processKind(info.argv) === "rpc");
  }

  async assertShutdownProcesses(signal: AbortSignal = AbortSignal.timeout(16_000)): Promise<void> {
    const remaining = this.capture();
    for (const info of remaining.filter((candidate) => processKind(candidate.argv) === "task-host")) {
      console.log(`CLEANUP detached task-host pid=${info.pid} cmdline=${info.argv.join(" ")}; expected self-expiry 15 minutes after last client leaves; terminating now`);
    }
    for (const info of remaining.filter((candidate) => processKind(candidate.argv) === "detached-service")) {
      console.log(`CLEANUP detached OmO service pid=${info.pid} cmdline=${info.argv.join(" ")}; terminating now`);
    }
    assert.deepEqual(remaining.filter((info) => {
      const kind = processKind(info.argv);
      return kind !== "task-host" && kind !== "detached-service";
    }).map((info) => ({
      pid: info.pid, cmdline: info.argv.join(" "),
    })), [], "connector-spawned RPC and unknown processes must disappear after SIGTERM");
    await this.terminate(remaining, signal);
    assert.deepEqual(this.capture().map((info) => ({
      pid: info.pid, cmdline: info.argv.join(" "),
    })), [], "owned processes must not survive scoped shutdown cleanup");
  }

  async start(signal: AbortSignal, isolatedDiscovery = false, idleTimeoutMs = 900_000, piArgs = process.env.OCPI_PI_ARGS ?? ""): Promise<void> {
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
        OCPI_PI_ARGS: piArgs,
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

  waitForEvent(predicate: (event: SmokeEvent) => boolean, timeoutMs: number, signal: AbortSignal): Promise<SmokeEvent> {
    return this.sse.waitForEvent(predicate, timeoutMs, signal);
  }

  idle(signal: AbortSignal, timeoutMs = 120_000): Promise<SmokeEvent> {
    const id = this.sessionId();
    return this.waitForEvent((event) => event.type === "session.idle" &&
      event.properties.sessionID === id, timeoutMs, signal);
  }

  turnIdle(signal: AbortSignal, timeoutMs = 120_000): Promise<SmokeEvent> {
    const id = this.sessionId();
    let busy = false;
    return this.waitForEvent((event) => {
      if (event.type === "session.status" && event.properties.sessionID === id &&
          event.properties.status.type === "busy") {
        busy = true;
      }
      return busy && event.type === "session.idle" && event.properties.sessionID === id;
    }, timeoutMs, signal);
  }

  delta(signal: AbortSignal): Promise<SmokeEvent> {
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
    const remaining = this.capture();
    assert.deepEqual(remaining.map((identity) => identity.pid), [], "no connector-owned processes may survive");
  }

  /** Subscribe to death before signalling exact, start-time-checked owned PIDs. */
  private async terminate(identities: readonly ProcessIdentity[], signal: AbortSignal): Promise<void> {
    const death = this.waitForDeath(identities, 15_000, signal);
    for (const identity of identities) signalOwned(identity, "SIGTERM");
    const escalation = setTimeout(() => {
      for (const identity of identities) signalOwned(identity, "SIGKILL");
    }, 6_000);
    try {
      await death;
    } finally {
      clearTimeout(escalation);
    }
  }

  async cleanup(): Promise<void> {
    clearInterval(this.observer);
    await this.sse.stop();
    try {
      // A task host can detach while the connector is shutting down, after the
      // first ownership snapshot. Drain successive exact-PID waves so cleanup
      // cannot remove the private root and strand a late supervisor.
      for (let wave = 0; wave < 4; wave++) {
        this.capture();
        const identities = [...this.owned.values()].filter(alive);
        if (identities.length === 0) break;
        await this.terminate(identities, AbortSignal.timeout(16_000));
      }
      this.assertNoOwnedProcesses();
      console.log("CLEANUP PASS: no owned connector or OmO processes remain");
    } finally {
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

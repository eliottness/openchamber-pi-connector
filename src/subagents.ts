/** OmO task cards and read-only views of their independently persisted sessions. */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { basename, dirname, join } from "node:path";
import { piAgentDir } from "./agent-dir.js";
import { ocIdFor, SessionPersistenceError, type SessionStore } from "./session-store.js";
import { mapTool, resultText, toolMappers, type ToolResult } from "./tool-map.js";
import type { ManagedSession } from "./sessions.js";
import type { OCEvent, OCMessageWithParts, OCToolPart } from "./types.js";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function taskId(value: unknown): value is string {
  return typeof value === "string" && /^st_[a-zA-Z0-9_-]+$/.test(value);
}

export function stripTaskSuffix(text: string): string {
  return text.replace(/\s*\[task_id:\s*st_[^\]]*\]/g, "").trimEnd();
}

function active(status: unknown): boolean {
  return ["running", "queued", "pending", "starting", "suspended"].includes(String(status));
}

function terminal(status: unknown): boolean {
  return ["completed", "failed", "error", "cancelled", "canceled", "killed", "lost", "denied", "plan_error"].includes(String(status));
}

toolMappers.task = (args, result) => {
  const input = {
    description: args.task_summary ?? args.name ?? args.description,
    prompt: args.prompt,
    subagent_type: args.subagent_type ?? args.category,
  };
  const details = record(result?.details) ? result.details : {};
  return {
    tool: "task", input, title: typeof input.description === "string" ? input.description : "task",
    ...(taskId(details.task_id) ? { metadata: { sessionID: ocIdFor(details.task_id), taskID: details.task_id, task: details } } : {}),
    ...(result !== undefined ? { output: stripTaskSuffix(resultText(result.content)) } : {}),
  };
};

/** One stable renderer part per item, with the batch defaults inherited. */
export function taskParts(template: OCToolPart, args: Record<string, unknown>): OCToolPart[] {
  const items = Array.isArray(args.tasks) && args.tasks.length > 0 ? args.tasks : [args];
  return items.map((item, index) => {
    const mapped = mapTool("task", { ...args, ...(record(item) ? item : {}) });
    return {
      ...template, id: `prt_task_${template.callID}_${index}`, tool: "task",
      state: {
        status: "running", input: mapped.input, title: mapped.title,
        time: { start: template.state.status === "pending" ? Date.now() : template.state.time.start },
      },
    };
  });
}

/** Keep task status independent of the parent tool returning a background handle. */
export function updateTaskParts(parts: OCToolPart[], result: ToolResult, ended: boolean, now: number): void {
  const details = record(result.details) ? result.details : {};
  const items = Array.isArray(details.items) ? details.items : undefined;
  parts.forEach((part, index) => {
    const previous = part.state.status !== "pending" ? part.state.metadata : undefined;
    const old = record(previous?.task) ? previous.task : {};
    const item = items?.[index];
    const current = items !== undefined ? (record(item) ? item : {}) : index === 0 ? details : {};
    const data = { ...old, ...current };
    const output = stripTaskSuffix(typeof data.final_response === "string" ? data.final_response :
      parts.length === 1 ? resultText(result.content) : typeof data.output === "string" ? data.output : "");
    const input = part.state.input;
    const title = typeof input.description === "string" ? input.description : "task";
    const start = part.state.status === "pending" ? now : part.state.time.start;
    const metadata = {
      ...previous, task: data,
      ...(taskId(data.task_id) ? { sessionID: ocIdFor(data.task_id), taskID: data.task_id } : {}),
    };
    // Preserve a final result for the fallback even after the parent JSONL is gone.
    if (ended && output !== "" && !active(data.status)) data.final_response = output;
    if (active(data.status) || (!ended && !terminal(data.status))) {
      part.state = { status: "running", input, title, metadata, time: { start } };
    } else if (result.isError || (terminal(data.status) && data.status !== "completed")) {
      part.state = { status: "error", input, error: output || String(data.status ?? "task failed"), metadata, time: { start, end: now } };
    } else {
      part.state = { status: "completed", input, output, title, metadata, time: { start, end: now } };
    }
  });
}

/** Wake messages carry arrays of completion envelopes, not a flat details object. */
export function taskCompletions(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(taskCompletions);
  if (!record(value)) return [];
  if (taskId(value.task_id)) return [value];
  return taskCompletions(value.details);
}

function optionalFile(path: string): string | undefined {
  try { return readFileSync(path, "utf8"); }
  catch (error) {
    if (error instanceof Error && "code" in error && ["ENOENT", "ENOTDIR", "EACCES"].includes(String(error.code))) return undefined;
    throw error;
  }
}

function jsonObject(path: string): Record<string, unknown> | undefined {
  const raw = optionalFile(path);
  if (raw === undefined) return undefined;
  try { const value: unknown = JSON.parse(raw); return record(value) ? value : undefined; }
  catch (error) { if (error instanceof SyntaxError) return undefined; throw error; }
}

function directories(path: string): string[] {
  try { return readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => join(path, entry.name)); }
  catch (error) {
    if (error instanceof Error && "code" in error && ["ENOENT", "ENOTDIR", "EACCES"].includes(String(error.code))) return [];
    throw error;
  }
}

export function findTask(id: string, parentPiId: string): { path: string; data: Record<string, unknown> } | undefined {
  if (!taskId(id)) return undefined;
  const agent = piAgentDir();
  const registry = jsonObject(join(agent, "rpc", "task-stores.json"));
  const stores = new Set([
    ...Object.keys(record(registry?.stores) ? registry.stores : {}),
    ...directories(join(agent, "projects")).map((project) => join(project, "senpi-task")),
  ]);
  for (const store of stores) {
    const path = join(store, "tasks", `${id}.json`);
    const data = jsonObject(path);
    if (data?.task_id === id && data.parent_session_id === parentPiId) return { path, data };
  }
  return undefined;
}

/** Byte offsets and a byte carry retain split UTF-8 characters and torn JSON lines. */
export class JsonlTail {
  private offset = 0;
  private inode = 0;
  private carry: Buffer = Buffer.alloc(0);
  text = "";

  read(path: string): boolean {
    let fd: number;
    try { fd = openSync(path, "r"); }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
      throw error;
    }
    try {
      const stat = statSync(path);
      if (stat.ino !== this.inode || stat.size < this.offset) {
        this.inode = stat.ino; this.offset = 0; this.carry = Buffer.alloc(0); this.text = "";
      }
      const buffer = Buffer.alloc(stat.size - this.offset);
      const size = readSync(fd, buffer, 0, buffer.length, this.offset);
      this.offset += size;
      this.carry = Buffer.concat([this.carry, buffer.subarray(0, size)]);
      const end = this.carry.lastIndexOf(10);
      if (end < 0) return false;
      this.text += this.carry.subarray(0, end + 1).toString("utf8");
      this.carry = this.carry.subarray(end + 1);
      return true;
    } finally { closeSync(fd); }
  }
}

export interface ChildTask {
  id: string;
  parentPiId: string;
  input: Record<string, unknown>;
  details: Record<string, unknown>;
  terminalAt?: number;
}

interface Child {
  session: ManagedSession;
  task: ChildTask;
  parts: Map<string, OCToolPart>;
  tail: JsonlTail;
  livePath: string | undefined;
  recordPath: string | undefined;
  watchers: Map<string, FSWatcher>;
  loaded: boolean;
  live: boolean;
}

type ParseHistory = (session: ManagedSession, raw: string) => OCMessageWithParts[];

export class SubagentBridge {
  private readonly children = new Map<string, Child>();
  private readonly calls = new Map<string, OCToolPart[]>();

  constructor(
    private readonly store: SessionStore,
    private readonly sessions: Map<string, ManagedSession>,
    private readonly emit: (directory: string, event: OCEvent) => void,
    private readonly parse: ParseHistory,
  ) {}

  private archive(id: string): string { return join(this.store.stateDir, "children", `${id}.jsonl`); }

  wire(parent: ManagedSession): void {
    parent.hasRunningChildren = () => [...this.children.values()]
      .some((child) => child.session.info.parentID === parent.info.id && child.session.status.type === "busy");
  }

  start(parent: ManagedSession, original: OCToolPart, args: Record<string, unknown>): void {
    const owner = parent.messages?.find((message) => message.info.id === original.messageID);
    const parts = taskParts(original, args);
    const index = owner?.parts.indexOf(original) ?? -1;
    if (owner && index >= 0) owner.parts.splice(index, 1, ...parts);
    this.calls.set(`${parent.info.id}|${original.callID}`, parts);
    parent.toolByCallId.delete(original.callID);
    for (const part of parts) this.emitPart(parent, part);
  }

  result(parent: ManagedSession, callID: string, result: ToolResult, ended: boolean): boolean {
    const parts = this.calls.get(`${parent.info.id}|${callID}`);
    if (parts === undefined) return false;
    updateTaskParts(parts, result, ended, Date.now());
    this.discoverParts(parent, parts, true);
    for (const part of parts) this.emitPart(parent, part);
    if (ended) this.calls.delete(`${parent.info.id}|${callID}`);
    return true;
  }

  wake(parent: ManagedSession, event: Record<string, unknown>): void {
    const message = record(event.message) ? event.message : event;
    if (message.customType !== "omo-senpi:wake") return;
    for (const data of taskCompletions(message.details)) {
      const child = this.children.get(ocIdFor(String(data.task_id)));
      if (child?.session.info.parentID !== parent.info.id) continue;
      child.task.details = { ...child.task.details, ...data };
      if (terminal(data.status)) child.task.terminalAt = Date.now();
      this.refresh(child, true, false);
    }
  }

  discover(parent: ManagedSession, messages: OCMessageWithParts[]): void {
    this.discoverParts(parent, messages.flatMap((message) => message.parts), false);
  }

  private discoverParts(parent: ManagedSession, parts: OCMessageWithParts["parts"], live: boolean): void {
    this.wire(parent);
    for (const part of parts) {
      if (part.type !== "tool" || part.tool !== "task" || part.state.status === "pending") continue;
      const metadata = part.state.metadata;
      if (!taskId(metadata?.taskID)) continue;
      const id = metadata.taskID;
      const details = record(metadata.task) ? metadata.task : {};
      let child = this.children.get(ocIdFor(id));
      if (!child) {
        child = this.create(parent, {
          id, parentPiId: parent.piSessionId ?? parent.restored?.piSessionId ?? "",
          input: part.state.input, details,
        });
      } else {
        // A repeated history read must not overwrite a newer completion wake.
        if (!terminal(child.task.details.status) || terminal(details.status)) child.task.details = { ...child.task.details, ...details };
      }
      child.live ||= live;
      if (terminal(details.status) && part.state.status !== "running") child.task.terminalAt = part.state.time.end;
      child.parts.set(part.id, part);
      this.refresh(child, true);
    }
  }

  private create(parent: ManagedSession, task: ChildTask): Child {
    const session: ManagedSession = {
      info: {
        id: ocIdFor(task.id), parentID: parent.info.id, projectID: parent.info.projectID, directory: parent.info.directory,
        title: typeof task.input.description === "string" ? task.input.description : task.id,
        version: parent.info.version, time: { ...parent.info.time },
      },
      pi: undefined, messages: undefined, model: undefined, streaming: undefined, status: { type: "idle" },
      toolByCallId: new Map(), tree: { messageEntries: {} }, hasPendingInteraction: () => false, hasRunningChildren: () => false,
    };
    const child: Child = { session, task, parts: new Map(), tail: new JsonlTail(), watchers: new Map(), livePath: undefined, recordPath: undefined, loaded: false, live: false };
    this.children.set(session.info.id, child);
    this.sessions.set(session.info.id, session);
    this.wire(session);
    this.emit(session.info.directory, { type: "session.created", properties: { info: session.info } });
    return child;
  }

  restore(id: string): ManagedSession | undefined {
    const known = this.children.get(id);
    if (known) return known.session;
    const entry = this.store.get(id);
    if (!entry?.task || !entry.parentID) return undefined;
    const parent: ManagedSession = {
      info: { id: entry.parentID, projectID: entry.directory, directory: entry.directory, title: "", version: "0.1.0", time: { created: entry.created, updated: entry.updated } },
      pi: undefined, messages: undefined, model: undefined, streaming: undefined, status: { type: "idle" },
      toolByCallId: new Map(), tree: { messageEntries: {} }, hasPendingInteraction: () => false, hasRunningChildren: () => false,
    };
    const child = this.create(parent, entry.task);
    child.session.info.title = entry.title ?? child.session.info.title;
    return child.session;
  }

  restoreAll(): void { for (const id of this.store.childIds()) this.restore(id); }

  owns(id: string): boolean { return this.children.has(id); }

  messages(id: string): OCMessageWithParts[] {
    const child = this.children.get(id);
    if (!child) return [];
    if (!child.loaded) this.refresh(child, false);
    return child.session.messages ?? [];
  }

  private watch(child: Child, path: string): void {
    const dir = dirname(path);
    if (child.watchers.has(dir) || !existsSync(dir)) return;
    const watcher = watch(dir, { persistent: false }, (_event, name) => {
      if (name === null || name.toString() === basename(child.livePath ?? "") || name.toString() === basename(child.recordPath ?? "")) this.refresh(child, true);
    });
    watcher.on("error", (error) => {
      console.error(`[subagents] watcher ${dir}: ${error.message}`);
      watcher.close(); child.watchers.delete(dir);
    });
    child.watchers.set(dir, watcher);
  }

  private refresh(child: Child, publish: boolean, useRecord = true): void {
    const archive = this.archive(child.task.id);
    const found = findTask(child.task.id, child.task.parentPiId);
    if (found) {
      child.recordPath = found.path;
      const updated = typeof found.data.updated_at === "string" ? Date.parse(found.data.updated_at) : NaN;
      const retainedTerminal = Math.max(child.task.terminalAt ?? 0, existsSync(archive) ? statSync(archive).mtimeMs : 0);
      const staleRunning = active(found.data.status) && terminal(child.task.details.status) &&
        updated <= retainedTerminal;
      if (useRecord && !staleRunning) child.task.details = { ...child.task.details, ...found.data };
      const host = found.data.host_session;
      if (record(host) && typeof host.session_path === "string") child.livePath = host.session_path;
      else if (typeof found.data.child_session_id === "string" && found.data.child_session_id !== "") {
        // In-process agents persist under the task store but have no RPC host_session.
        // Match the recorded session, not another retained run in the same directory.
        const sessions = join(dirname(dirname(found.path)), "children", child.task.id, "sessions", child.task.id);
        try {
          const file = readdirSync(sessions, { withFileTypes: true }).find((entry) =>
            entry.isFile() && entry.name.endsWith(`_${found.data.child_session_id}.jsonl`));
          child.livePath = file ? join(sessions, file.name) : undefined;
        } catch (error) {
          if (!(error instanceof Error && "code" in error && ["ENOENT", "ENOTDIR", "EACCES"].includes(String(error.code)))) throw error;
          child.livePath = undefined;
        }
      }
    }
    const running = active(child.task.details.status) && (found !== undefined || child.live);
    const previousMessages = child.session.messages ?? [];
    const previousStatus = child.session.status.type;
    // A resumed live task can be newer than its archive; completed history prefers the archive.
    const liveRun = running || previousStatus === "busy";
    let raw = liveRun ? undefined : optionalFile(archive);
    if (running && child.recordPath) this.watch(child, child.recordPath);
    if (raw === undefined && child.livePath !== undefined) {
      if (running) {
        this.watch(child, child.livePath);
      }
      child.tail.read(child.livePath);
      if (child.tail.text !== "") raw = child.tail.text;
    }
    if (raw !== undefined) {
      const headerLine = raw.split("\n", 1)[0];
      try {
        const header: unknown = JSON.parse(headerLine ?? "");
        if (record(header) && typeof header.id === "string") child.session.piSessionId = header.id;
      } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
      child.session.messages = this.parse(child.session, raw);
      this.discover(child.session, child.session.messages);
      if (!running && terminal(child.task.details.status) && (liveRun || !existsSync(archive))) this.saveArchive(archive, raw);
    } else {
      child.session.messages = this.fallback(child);
    }
    child.loaded = true;
    child.session.status = { type: running ? "busy" : "idle" };
    if (!running) this.closeWatchers(child);
    for (const part of child.parts.values()) {
      updateTaskParts([part], {
        details: child.task.details,
        content: [{ type: "text", text: child.task.details.final_response ?? "" }],
      }, !running, Date.now());
      if (publish) this.emitPart(child.session, part);
    }
    this.persist(child);
    if (!publish) return;
    const before = new Map(previousMessages.map((message) => [message.info.id, JSON.stringify(message)]));
    for (const message of child.session.messages) {
      if (before.get(message.info.id) === JSON.stringify(message)) continue;
      this.emit(child.session.info.directory, { type: "message.updated", properties: { info: message.info } });
      for (const part of message.parts) this.emitPart(child.session, part);
    }
    if (previousStatus !== child.session.status.type) {
      this.emit(child.session.info.directory, { type: "session.status", properties: { sessionID: child.session.info.id, status: child.session.status } });
      if (!running) this.emit(child.session.info.directory, { type: "session.idle", properties: { sessionID: child.session.info.id } });
    }
  }

  private saveArchive(path: string, raw: string): void {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, raw);
    renameSync(temporary, path);
  }

  private fallback(child: Child): OCMessageWithParts[] {
    const data = child.task.details;
    const stats = record(data.run_stats) ? data.run_stats : {};
    const resolved = record(data.resolved_model) ? data.resolved_model : {};
    const model = typeof data.model === "string" ? data.model : `${resolved.provider ?? "unknown"}/${resolved.model_id ?? "unknown"}`;
    const text = [
      stripTaskSuffix(typeof data.final_response === "string" ? data.final_response : ""),
      `Model: ${model}\nRuntime: ${stats.runtime_ms ?? data.duration_ms ?? 0} ms\nTokens: ${stats.total_tokens ?? 0}\nCost: $${stats.cost_usd ?? 0}`,
      "Full transcript was not retained by OmO.",
    ].filter(Boolean).join("\n\n");
    // OpenChamber groups assistant output by a user turn. The original task
    // prompt is retained by the parent even when the child transcript is gone.
    const request = JSON.stringify({
      type: "message", id: "request", timestamp: child.session.info.time.created,
      message: { role: "user", content: [{ type: "text", text: child.task.input.prompt ?? child.task.input.description ?? child.task.id }] },
    });
    const response = JSON.stringify({
      type: "message", id: "result", parentId: "request", timestamp: child.session.info.time.updated,
      message: { role: "assistant", provider: resolved.provider ?? model.split("/")[0], model: resolved.model_id ?? model.split("/").slice(1).join("/"),
        content: [{ type: "text", text }], usage: { input: stats.input_tokens, output: stats.output_tokens, cacheRead: stats.cache_read_tokens, cacheWrite: stats.cache_write_tokens, cost: { total: stats.cost_usd } } },
    });
    return this.parse(child.session, `${request}\n${response}\n`);
  }

  private persist(child: Child): void {
    const { info } = child.session;
    try {
      this.store.set(info.id, {
        piSessionId: child.session.piSessionId ?? child.task.id, piPath: this.archive(child.task.id),
        directory: info.directory, title: info.title, parentID: info.parentID, task: child.task,
        created: info.time.created, updated: info.time.updated,
      });
    } catch (error) {
      if (!(error instanceof SessionPersistenceError)) throw error;
      this.emit(info.directory, {
        type: "session.error",
        properties: { sessionID: info.id, error: { name: error.name, data: { message: error.message } } },
      });
    }
  }

  private emitPart(session: ManagedSession, part: OCToolPart | OCMessageWithParts["parts"][number]): void {
    this.emit(session.info.directory, { type: "message.part.updated", properties: { part } });
  }

  private closeWatchers(child: Child): void {
    for (const watcher of child.watchers.values()) watcher.close();
    child.watchers.clear();
  }

  finishCalls(parentID: string, cancelled = false): void {
    for (const [key, parts] of this.calls) {
      if (!key.startsWith(`${parentID}|`)) continue;
      const parent = this.sessions.get(parentID);
      for (const part of parts) {
        const childID = part.state.status !== "pending" ? part.state.metadata?.sessionID : undefined;
        if (!cancelled && typeof childID === "string" && this.children.get(childID)?.session.status.type === "busy") continue;
        updateTaskParts([part], {
          isError: true, details: { status: cancelled ? "cancelled" : "failed" },
          content: [{ type: "text", text: cancelled ? "Task cancelled" : "run ended without a tool result" }],
        }, true, Date.now());
        if (parent) this.emitPart(parent, part);
      }
      this.calls.delete(key);
    }
  }

  stopParent(parentID: string): void {
    this.finishCalls(parentID, true);
    for (const child of this.children.values()) {
      if (child.session.info.parentID !== parentID) continue;
      this.stopParent(child.session.info.id);
      if (child.session.status.type === "busy") {
        child.task.details = { ...child.task.details, status: "cancelled" };
        this.refresh(child, true, false);
      }
      this.closeWatchers(child);
    }
  }

  remove(id: string): void {
    const child = this.children.get(id);
    if (!child) return;
    this.closeWatchers(child);
    child.parts.clear();
    this.children.delete(id);
  }

  dispose(): void {
    for (const child of this.children.values()) {
      this.closeWatchers(child);
      child.parts.clear();
    }
  }
}

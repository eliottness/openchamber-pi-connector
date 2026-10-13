/// <reference types="node" />
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { AdapterServer } from "../src/server.js";
import { SessionManager, type ManagedSession } from "../src/sessions.js";
import { ocIdFor, piSessionDir, SessionStore } from "../src/session-store.js";
import { findTask, JsonlTail, stripTaskSuffix } from "../src/subagents.js";
import type { OCEvent, OCMessageWithParts, OCToolPart } from "../src/types.js";

const fixture = JSON.parse(readFileSync("test/fixtures/omo-tools/task.json", "utf8"));
const rpc = readFileSync("test/fixtures/omo-rpc/run1.jsonl", "utf8").trim().split("\n")
  .map((line) => JSON.parse(line) as Record<string, unknown>);

function put(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
}

function transcript(text: string, childId = "child-pi"): string {
  return [
    { type: "session", version: 3, id: childId, cwd: "/tmp/test", timestamp: "2026-10-12T00:00:00.000Z" },
    { type: "message", id: "u", parentId: null, timestamp: 1, message: { role: "user", content: [{ type: "text", text: "Do the child job" }] } },
    { type: "message", id: "a", parentId: "u", timestamp: 2, message: { role: "assistant", provider: "anthropic", model: "haiku", content: [
      { type: "thinking", thinking: "Read the file first." },
      { type: "toolCall", id: "read-1", name: "read", arguments: { path: "child.txt" } },
    ] } },
    { type: "message", id: "r", parentId: "a", timestamp: 3, message: { role: "toolResult", toolCallId: "read-1", toolName: "read", content: [{ type: "text", text: "contents" }] } },
    { type: "message", id: "z", parentId: "r", timestamp: 4, message: { role: "assistant", provider: "anthropic", model: "haiku", content: [{ type: "text", text }] } },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
}

function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "ocpi-subagents-"));
  const agent = join(dir, "agent");
  const state = join(dir, "state");
  const previousAgent = process.env.PI_CODING_AGENT_DIR;
  const previousState = process.env.OCPI_STATE_DIR;
  process.env.PI_CODING_AGENT_DIR = agent;
  process.env.OCPI_STATE_DIR = state;
  const directory = join(dir, "work");
  mkdirSync(directory);
  const parentPath = join(piSessionDir(directory), "parent.jsonl");
  put(parentPath, JSON.stringify({ type: "session", version: 3, id: "parent-pi", cwd: directory, timestamp: "2026-10-12T00:00:00.000Z" }) + "\n");
  const bus = new EventEmitter();
  const events: OCEvent[] = [];
  const manager = new SessionManager((_directory, event) => {
    events.push(structuredClone(event) as OCEvent);
    bus.emit("event", event as OCEvent);
  }, new SessionStore(state), directory);
  const parent = manager.get(ocIdFor("parent-pi"));
  assert.ok(parent);
  manager.messages(parent.info.id);
  const store = join(agent, "projects", "work-hash", "senpi-task");
  mkdirSync(join(store, "tasks"), { recursive: true });
  put(join(agent, "rpc", "task-stores.json"), { version: 1, stores: { [store]: {} } });
  t.after(async () => {
    await manager.disposeAll();
    if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgent;
    if (previousState === undefined) delete process.env.OCPI_STATE_DIR;
    else process.env.OCPI_STATE_DIR = previousState;
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, agent, state, directory, parentPath, parent, manager, bus, events, store };
}

function start(manager: SessionManager, parent: ManagedSession, args: Record<string, unknown>, callID = "spawn"): void {
  manager["onPiEvent"](parent, { type: "message_start", message: { role: "assistant" } });
  manager["onPiEvent"](parent, { type: "message_update", assistantMessageEvent: {
    type: "toolcall_start", contentIndex: 0, id: callID, toolName: "task",
  } });
  manager["onPiEvent"](parent, { type: "message_update", assistantMessageEvent: {
    type: "toolcall_end", contentIndex: 0, toolCall: { id: callID, name: "task", arguments: args },
  } });
  manager["onPiEvent"](parent, { type: "tool_execution_start", toolCallId: callID, toolName: "task", args });
}

function result(manager: SessionManager, parent: ManagedSession, details: Record<string, unknown>, text = "done", ended = true, callID = "spawn"): void {
  const payload = { details, content: [{ type: "text", text }] };
  manager["onPiEvent"](parent, ended
    ? { type: "tool_execution_end", toolCallId: callID, toolName: "task", result: payload }
    : { type: "tool_execution_update", toolCallId: callID, toolName: "task", partialResult: payload });
}

function parts(messages: OCMessageWithParts[] | undefined): OCToolPart[] {
  return (messages ?? []).flatMap((message) => message.parts).filter((part): part is OCToolPart => part.type === "tool");
}

function texts(messages: OCMessageWithParts[] | undefined): string {
  return (messages ?? []).flatMap((message) => message.parts).filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

function liveRecord(store: string, id = "st_child", status = "running", text = "child result") {
  const path = join(store, "children", id, "sessions", id, "child.jsonl");
  put(path, transcript(text));
  const data = { task_id: id, parent_session_id: "parent-pi", status, host_session: { session_path: path }, final_response: text };
  const recordPath = join(store, "tasks", `${id}.json`);
  put(recordPath, data);
  return { path, recordPath, data };
}

function eventWhen(bus: EventEmitter, predicate: (event: OCEvent) => boolean): Promise<OCEvent> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { bus.off("event", listener); clearTimeout(timer); };
    const timeout = () => { cleanup(); reject(new Error("Expected bridge event was not emitted")); };
    const listener = (event: OCEvent) => { if (predicate(event)) { cleanup(); resolve(event); } };
    bus.on("event", listener);
    // The bridge watchers are nonpersistent; this wait must keep its deadline alive.
    const timer = setTimeout(timeout, 5000);
  });
}

test("single real RPC task creates a linked nested session and strips the suffix", (t) => {
  const { manager, parent, events } = setup(t);
  for (const event of rpc) manager["onPiEvent"](parent, event);
  const task = parts(parent.messages).find((part) => part.tool === "task");
  assert.ok(task && task.state.status === "completed");
  assert.equal(task.state.output, "quick task done");
  const childID = ocIdFor("st_01a13227");
  assert.equal(task.state.metadata.sessionID, childID);
  assert.equal(manager.get(childID)?.info.parentID, parent.info.id);
  assert.ok(events.some((event) => event.type === "session.created" && event.properties.info.id === childID));
  assert.ok(texts(manager.messages(childID)).includes("quick task done"));
});

test("F2 B3 child registry save failure emits a visible session error", (t) => {
  const { manager, parent, events, state } = setup(t);
  mkdirSync(join(state, "sessions.json"), { recursive: true });
  start(manager, parent, { description: "save failure", prompt: "child job", category: "quick" });
  result(manager, parent, { task_id: "st_save_failure", status: "completed", final_response: "done" });
  assert.ok(events.some((event) => event.type === "session.error" &&
    event.properties.sessionID === ocIdFor("st_save_failure") &&
    event.properties.error?.name === "SessionPersistenceError"));
});

test("real tasks array yields stable parts and separately fetchable children", (t) => {
  const { manager, parent, directory } = setup(t);
  const batch = fixture.samples[1];
  start(manager, parent, batch.arguments, "batch");
  manager["onPiEvent"](parent, { type: "tool_execution_end", toolCallId: "batch", result: batch });
  const cards = parts(parent.messages);
  assert.equal(cards.length, 4);
  cards.forEach((card, index) => {
    assert.equal(card.id, `prt_task_batch_${index}`);
    assert.equal(card.state.input.description, batch.arguments.tasks[index].task_summary);
    assert.equal(card.state.input.subagent_type, "deep-low");
    assert.notEqual(card.state.status, "pending");
    if (card.state.status === "pending") return;
    const childID = ocIdFor(batch.details.items[index].task_id);
    assert.equal(card.state.metadata?.sessionID, childID);
    assert.equal(manager.get(childID)?.info.parentID, parent.info.id);
    assert.ok(manager.list(directory).some((session) => session.id === childID));
    assert.ok(manager.messages(childID));
  });
});

test("rediscovery replaces one logical task card while keeping batch cards distinct", (t) => {
  const { manager, parent, events } = setup(t);
  start(manager, parent, { task_summary: "Stable child", prompt: "work" });
  result(manager, parent, { task_id: "st_stable", status: "completed", final_response: "done" });
  const original = parts(parent.messages)[0];
  assert.ok(original);
  const child = manager.subagents["children"].get(ocIdFor("st_stable"));
  assert.ok(child);
  events.splice(0);
  for (let index = 0; index < 3; index++) {
    manager.subagents.discover(parent, [{ info: parent.messages![0]!.info, parts: [structuredClone(original)] }]);
  }
  assert.equal(child.parts.size, 1);
  assert.equal(events.filter((event) => event.type === "message.part.updated").length, 3);

  const batch = fixture.samples[1];
  start(manager, parent, batch.arguments, "distinct-batch");
  manager["onPiEvent"](parent, { type: "tool_execution_end", toolCallId: "distinct-batch", result: batch });
  const batchChildren = (batch.details.items as Array<{ task_id: string }>).map((item) =>
    manager.subagents["children"].get(ocIdFor(item.task_id)));
  assert.equal(batchChildren.length, 4);
  assert.ok(batchChildren.every((batchChild: { parts: Map<string, OCToolPart> } | undefined) => batchChild?.parts.size === 1));
});

test("terminal record atomically archives and emits idle after streaming shared tool cards", async (t) => {
  const { manager, parent, store, state, bus } = setup(t);
  const child = liveRecord(store);
  start(manager, parent, { category: "quick", task_summary: "Child", prompt: "work" });
  result(manager, parent, { task_id: "st_child", status: "running" }, "", false);
  assert.equal(parent.hasRunningChildren(), true);
  const childID = ocIdFor("st_child");
  assert.equal(manager.get(childID)?.status.type, "busy");
  const read = parts(manager.messages(childID)).find((part) => part.tool === "read");
  assert.deepEqual(read?.state.input, { filePath: "child.txt", offset: undefined, limit: undefined });
  assert.equal(read?.state.status, "completed");
  assert.ok(manager.messages(childID)?.some((message) => message.parts.some((part) => part.type === "reasoning")));
  const idle = eventWhen(bus, (event) => event.type === "session.idle" && event.properties.sessionID === childID);
  put(`${child.recordPath}.tmp`, { ...child.data, status: "completed" });
  renameSync(`${child.recordPath}.tmp`, child.recordPath);
  await idle;
  assert.equal(parent.hasRunningChildren(), false);
  assert.equal(readFileSync(join(state, "children", "st_child.jsonl"), "utf8"), readFileSync(child.path, "utf8"));
  assert.deepEqual(readdirSync(join(state, "children")), ["st_child.jsonl"]);
});

test("history prefers archive over a conflicting completed live transcript", (t) => {
  const { manager, parent, store, state } = setup(t);
  liveRecord(store, "st_child", "completed", "stale live transcript");
  put(join(state, "children", "st_child.jsonl"), transcript("authoritative archive"));
  start(manager, parent, { task_summary: "Archived child" });
  result(manager, parent, { task_id: "st_child", status: "completed" });
  assert.ok(texts(manager.messages(ocIdFor("st_child"))).includes("authoritative archive"));
  assert.ok(!texts(manager.messages(ocIdFor("st_child"))).includes("stale live transcript"));
});

test("in-process child_session_id streams tools and archives without host_session", async (t) => {
  const { manager, parent, store, state, bus, directory } = setup(t);
  const child = liveRecord(store);
  const path = join(dirname(child.path), "2026-10-13T00-00-00-000Z_child-pi.jsonl");
  renameSync(child.path, path);
  // A different retained run must never be mistaken for the current session.
  put(join(dirname(path), "2026-10-14T00-00-00-000Z_other-pi.jsonl"), transcript("other run", "other-pi"));
  const data = {
    task_id: "st_child", parent_session_id: "parent-pi", status: "running",
    execution_mode: "in-process", child_session_id: "child-pi",
  };
  put(child.recordPath, data);
  start(manager, parent, { subagent_type: "explore", task_summary: "In-process child" });
  result(manager, parent, { task_id: "st_child", status: "running" }, "", false);
  const childID = ocIdFor("st_child");
  assert.equal(parts(manager.messages(childID)).filter((part) => part.tool === "read").length, 1);
  assert.equal(manager.get(childID)?.status.type, "busy");
  const streamed = eventWhen(bus, (event) => event.type === "message.part.updated" &&
    event.properties.part.sessionID === childID && event.properties.part.type === "text" &&
    event.properties.part.text === "IN_PROCESS_STREAM");
  appendFileSync(path, JSON.stringify({ type: "message", id: "live", parentId: "z", timestamp: 5,
    message: { role: "assistant", content: [{ type: "text", text: "IN_PROCESS_STREAM" }] } }) + "\n");
  await streamed;
  const idle = eventWhen(bus, (event) => event.type === "session.idle" && event.properties.sessionID === childID);
  put(`${child.recordPath}.tmp`, { ...data, status: "completed" });
  renameSync(`${child.recordPath}.tmp`, child.recordPath);
  await idle;
  assert.equal(readFileSync(join(state, "children", "st_child.jsonl"), "utf8"), readFileSync(path, "utf8"));
  await manager.disposeAll();
  rmSync(store, { recursive: true });
  const restarted = new SessionManager(() => {}, new SessionStore(state), directory);
  t.after(() => restarted.disposeAll());
  assert.equal(parts(restarted.messages(childID)).filter((part) => part.tool === "read").length, 1);
  assert.match(texts(restarted.messages(childID)), /IN_PROCESS_STREAM/);
});

test("in-process transcript discovery follows late child session publication", async (t) => {
  const { manager, parent, store, bus } = setup(t);
  const recordPath = join(store, "tasks", "st_child.json");
  const data = { task_id: "st_child", parent_session_id: "parent-pi", status: "running", execution_mode: "in-process" };
  put(recordPath, data);
  start(manager, parent, { subagent_type: "explore", task_summary: "Starting child" });
  result(manager, parent, { task_id: "st_child", status: "running" }, "", false);
  const childID = ocIdFor("st_child");
  const arrived = eventWhen(bus, (event) => event.type === "message.part.updated" &&
    event.properties.part.sessionID === childID && event.properties.part.type === "tool" &&
    event.properties.part.tool === "read");
  put(join(store, "children", "st_child", "sessions", "st_child", "2026-10-13T00-00-00-000Z_child-pi.jsonl"),
    transcript("late session"));
  put(`${recordPath}.tmp`, { ...data, child_session_id: "child-pi" });
  renameSync(`${recordPath}.tmp`, recordPath);
  await arrived;
  assert.equal(parts(manager.messages(childID)).filter((part) => part.tool === "read").length, 1);
});

test("live store history is archived even when no prior archive exists", (t) => {
  const { manager, parent, store, state } = setup(t);
  liveRecord(store, "st_child", "completed", "retained live history");
  start(manager, parent, { task_summary: "Stored child" });
  result(manager, parent, { task_id: "st_child", status: "completed" });
  assert.ok(texts(manager.messages(ocIdFor("st_child"))).includes("retained live history"));
  assert.ok(existsSync(join(state, "children", "st_child.jsonl")));
});

test("missing transcript renders final response usage and retention notice", (t) => {
  const { manager, parent } = setup(t);
  start(manager, parent, { task_summary: "Evicted child" });
  result(manager, parent, { task_id: "st_missing", status: "completed", model: "anthropic/haiku", run_stats: {
    runtime_ms: 123, total_tokens: 50, input_tokens: 30, output_tokens: 20, cost_usd: 0.01,
  } }, "preserved result\n\n[task_id: st_missing - continue with task_send(...)]");
  const messages = manager.messages(ocIdFor("st_missing"));
  assert.equal(messages?.filter((message) => message.info.role === "assistant").length, 1);
  assert.match(texts(messages), /preserved result/);
  assert.match(texts(messages), /Full transcript was not retained by OmO\./);
  const info = messages?.find((message) => message.info.role === "assistant")?.info;
  assert.ok(info?.role === "assistant");
  assert.equal(info.parentID, messages?.find((message) => message.info.role === "user")?.info.id);
  assert.equal(info.cost, 0.01);
  assert.equal(info.tokens.input, 30);
  assert.equal(info.modelID, "haiku");
  assert.ok(!texts(messages).includes("[task_id:"));
});

test("nested background completion wake updates the parent card and archives the child", (t) => {
  const { manager, parent, store, state } = setup(t);
  liveRecord(store);
  start(manager, parent, { run_in_background: true, task_summary: "Background child" });
  result(manager, parent, { task_id: "st_child", status: "running" }, "Started");
  manager["onPiEvent"](parent, { type: "message_end", message: {
    role: "custom", customType: "omo-senpi:wake",
    details: [{ customType: "senpi-task.completion", details: [{ task_id: "st_child", status: "completed", final_response: "wake result" }] }],
  } });
  assert.equal(manager.get(ocIdFor("st_child"))?.status.type, "idle");
  assert.equal(parent.hasRunningChildren(), false);
  const card = parts(parent.messages)[0];
  assert.ok(card?.state.status === "completed");
  assert.equal(card.state.output, "wake result");
  assert.ok(existsSync(join(state, "children", "st_child.jsonl")));
});

test("partial lines and split UTF8 stream only after the terminating newline", async (t) => {
  const { manager, parent, store, bus } = setup(t);
  const child = liveRecord(store);
  start(manager, parent, { task_summary: "Tailed child" });
  result(manager, parent, { task_id: "st_child", status: "running" }, "", false);
  const entry = Buffer.from(JSON.stringify({ type: "message", id: "new", parentId: "z", timestamp: 5,
    message: { role: "assistant", content: [{ type: "text", text: "new café result" }] } }) + "\n");
  const cut = entry.indexOf(Buffer.from("é")) + 1;
  appendFileSync(child.path, entry.subarray(0, cut));
  // The pure tail reader establishes the exact partial-byte state without timing luck.
  const tail = new JsonlTail();
  tail.read(child.path);
  assert.ok(!tail.text.includes('"id":"new"'));
  const arrived = eventWhen(bus, (event) => event.type === "message.part.updated" && event.properties.part.type === "text" && event.properties.part.text === "new café result");
  appendFileSync(child.path, entry.subarray(cut));
  await arrived;
  tail.read(child.path);
  assert.ok(tail.text.includes("new café result"));
  assert.ok(texts(manager.messages(ocIdFor("st_child"))).includes("new café result"));
});

test("corrupt registry and records are tolerated with project directory fallback", (t) => {
  const { agent, store } = setup(t);
  const child = liveRecord(store);
  put(join(agent, "rpc", "task-stores.json"), "{truncated");
  assert.equal(findTask("st_child", "parent-pi")?.path, child.recordPath);
  assert.equal(findTask("st_child", "different-parent"), undefined);
  put(child.recordPath, "{truncated");
  assert.equal(findTask("st_child", "parent-pi"), undefined);
  assert.equal(findTask("../../escape", "parent-pi"), undefined);
});

test("resumed running child supersedes stale archive and replaces it at terminal status", async (t) => {
  const { manager, parent, store, state, bus } = setup(t);
  put(join(state, "children", "st_child.jsonl"), transcript("old run"));
  const child = liveRecord(store, "st_child", "running", "resumed run");
  start(manager, parent, { task_summary: "Resumed child" });
  result(manager, parent, { task_id: "st_child", status: "running", run_epoch: 1 }, "", false);
  assert.ok(texts(manager.messages(ocIdFor("st_child"))).includes("resumed run"));
  const idle = eventWhen(bus, (event) => event.type === "session.idle");
  put(child.recordPath, { ...child.data, status: "completed", run_epoch: 1 });
  await idle;
  assert.ok(readFileSync(join(state, "children", "st_child.jsonl"), "utf8").includes("resumed run"));
});

test("aborting a parent ends child status and closes every child watcher", async (t) => {
  const { manager, parent, store } = setup(t);
  liveRecord(store);
  start(manager, parent, { task_summary: "Cancelled child" });
  result(manager, parent, { task_id: "st_child", status: "running" }, "", false);
  await manager.abort(parent.info.id);
  assert.equal(parent.hasRunningChildren(), false);
  assert.equal(manager.get(ocIdFor("st_child"))?.status.type, "idle");
  for (const child of manager.subagents["children"].values()) assert.equal(child.watchers.size, 0);
});

test("restart resolves archived children by id through real session and message routes", async (t) => {
  const { manager, parent, store, directory } = setup(t);
  liveRecord(store, "st_child", "completed", "survives eviction");
  start(manager, parent, { task_summary: "Archived child" });
  result(manager, parent, { task_id: "st_child", status: "completed" });
  await manager.disposeAll();
  rmSync(store, { recursive: true });
  const server = new AdapterServer({ port: 0, host: "127.0.0.1", defaultDirectory: directory });
  await server.start();
  t.after(() => server.stop());
  const childID = ocIdFor("st_child");
  const info = await fetch(`${server.url}/session/${childID}`).then((response) => response.json());
  assert.equal(info.parentID, parent.info.id);
  const history = await fetch(`${server.url}/session/${childID}/message`).then((response) => response.json());
  assert.match(texts(history), /survives eviction/);
  const roots = await fetch(`${server.url}/experimental/session?roots=true`).then((response) => response.json());
  const all = await fetch(`${server.url}/experimental/session?roots=false`).then((response) => response.json());
  assert.ok(!roots.some((session: { id: string }) => session.id === childID));
  assert.ok(all.some((session: { id: string; parentID?: string }) => session.id === childID && session.parentID === parent.info.id));
});

test("dormant parent rebuilds batch children and applies trailing wake results", (t) => {
  const { manager, parent, parentPath } = setup(t);
  const batch = fixture.samples[1];
  appendFileSync(parentPath, [
    { type: "message", id: "a", parentId: null, timestamp: 1, message: { role: "assistant", content: [{ type: "toolCall", id: "batch", name: "task", arguments: batch.arguments }] } },
    { type: "message", id: "r", parentId: "a", timestamp: 2, message: { role: "toolResult", toolName: "task", toolCallId: "batch", ...batch } },
    { type: "custom_message", id: "wake", parentId: "r", timestamp: 3, customType: "omo-senpi:wake", details: [
      { customType: "senpi-task.completion", details: [{ task_id: "st_01a12ba2", status: "completed", final_response: "historical final response", run_stats: { runtime_ms: 17 } }] },
    ] },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  parent.messages = undefined;
  const cards = parts(manager.messages(parent.info.id));
  assert.equal(cards.length, 4);
  assert.equal(cards[0]?.state.status, "completed");
  assert.ok(texts(manager.messages(ocIdFor("st_01a12ba2"))).includes("historical final response"));
});

test("task suffix removal preserves ordinary output and strips each batch continuation", () => {
  assert.equal(stripTaskSuffix("answer\n\n[task_id: st_one - continue with task_send(...)]"), "answer");
  assert.equal(stripTaskSuffix("first [task_id: st_one]\nsecond [task_id: st_two]"), "first\nsecond");
  assert.equal(stripTaskSuffix("task_id: inside ordinary prose"), "task_id: inside ordinary prose");
});

test("restored child message and part identifiers cannot collide across sessions", (t) => {
  const { manager, parent, store } = setup(t);
  for (const id of ["st_first", "st_second"]) {
    liveRecord(store, id, "completed", id);
    start(manager, parent, { task_summary: id }, id);
    result(manager, parent, { task_id: id, status: "completed" }, id, true, id);
  }
  const ids = (task: string) => manager.messages(ocIdFor(task))?.flatMap((message) =>
    [message.info.id, ...message.parts.map((part) => part.id)]) ?? [];
  const first = new Set(ids("st_first"));
  assert.ok(ids("st_second").every((id) => !first.has(id)));
});

test("an older running record cannot resurrect an archived terminal child", (t) => {
  const { manager, parent, store, state } = setup(t);
  const child = liveRecord(store, "st_child", "running", "stale running result");
  put(child.recordPath, { ...child.data, updated_at: "2020-01-01T00:00:00.000Z" });
  put(join(state, "children", "st_child.jsonl"), transcript("archived terminal result"));
  start(manager, parent, { task_summary: "Archived child" });
  result(manager, parent, { task_id: "st_child", status: "completed" });
  assert.equal(manager.get(ocIdFor("st_child"))?.status.type, "idle");
  assert.equal(parent.hasRunningChildren(), false);
  assert.ok(texts(manager.messages(ocIdFor("st_child"))).includes("archived terminal result"));
});

test("abort before the task id arrives ends the card and allows a fresh run", async (t) => {
  const { manager, parent, store } = setup(t);
  start(manager, parent, { task_summary: "Not yet spawned" });
  await manager.abort(parent.info.id);
  assert.equal(parts(parent.messages)[0]?.state.status, "error");
  liveRecord(store);
  start(manager, parent, { task_summary: "Resumed parent task" }, "resumed");
  result(manager, parent, { task_id: "st_child", status: "running" }, "", false, "resumed");
  assert.equal(parent.hasRunningChildren(), true);
  await manager.abort(parent.info.id);
  assert.equal(parent.hasRunningChildren(), false);
  assert.ok(parts(parent.messages).every((part) => part.state.status === "error"));
});

test("cancellation ends every unlinked batch card after partial progress", async (t) => {
  const { manager, parent } = setup(t);
  start(manager, parent, { category: "quick", tasks: [{ task_summary: "First" }, { task_summary: "Second" }] });
  result(manager, parent, { items: [{ status: "running" }, { status: "running" }] }, "", false);
  await manager.abort(parent.info.id);
  assert.deepEqual(parts(parent.messages).map((part) => part.state.status), ["error", "error"]);
});

test("agent end finalizes resultless task calls but leaves running background children protected", (t) => {
  const { manager, parent, store } = setup(t);
  start(manager, parent, { task_summary: "Resultless" });
  manager["onPiEvent"](parent, { type: "agent_end" });
  assert.equal(parts(parent.messages)[0]?.state.status, "error");
  liveRecord(store);
  start(manager, parent, { task_summary: "Background", run_in_background: true }, "background");
  result(manager, parent, { task_id: "st_child", status: "running" }, "Started", true, "background");
  manager["onPiEvent"](parent, { type: "agent_end" });
  assert.equal(parent.hasRunningChildren(), true);
  assert.equal(manager.get(ocIdFor("st_child"))?.status.type, "busy");
});

test("persisted completion without an archive survives an older running record after restart", async (t) => {
  const { manager, parent, store, state, directory } = setup(t);
  put(join(store, "tasks", "st_child.json"), {
    task_id: "st_child", parent_session_id: "parent-pi", status: "running", updated_at: "2020-01-01T00:00:00.000Z",
  });
  start(manager, parent, { task_summary: "Evicted background" });
  result(manager, parent, { task_id: "st_child", status: "running" });
  manager["onPiEvent"](parent, { type: "custom_message", customType: "omo-senpi:wake",
    details: [{ task_id: "st_child", status: "completed", final_response: "retained completion" }] });
  await manager.disposeAll();
  const restarted = new SessionManager(() => {}, new SessionStore(state), directory);
  t.after(() => restarted.disposeAll());
  assert.match(texts(restarted.messages(ocIdFor("st_child"))), /retained completion/);
  assert.equal(restarted.get(ocIdFor("st_child"))?.status.type, "idle");
  assert.ok(!existsSync(join(state, "children", "st_child.jsonl")));
});

test("removing a child closes its own watchers and cannot restore the deleted view", async (t) => {
  const { manager, parent, store } = setup(t);
  liveRecord(store);
  start(manager, parent, { task_summary: "Removed child" });
  result(manager, parent, { task_id: "st_child", status: "running" }, "", false);
  const childID = ocIdFor("st_child");
  const tracked = manager.subagents["children"].get(childID);
  assert.ok(tracked && tracked.watchers.size > 0);
  assert.equal(await manager.remove(childID), true);
  assert.equal(tracked.watchers.size, 0);
  assert.equal(manager.get(childID), undefined);
});

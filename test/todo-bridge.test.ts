import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { flattenTodos, TodoBridge, type TodoUpdated } from "../src/todo-bridge.js";
import { SessionManager, type ManagedSession } from "../src/sessions.js";
import { SessionStore, ocIdFor, piSessionDir } from "../src/session-store.js";
import { AdapterServer } from "../src/server.js";
import { mapTool } from "../src/tool-map.js";
import type { OCEvent, OCToolPart } from "../src/types.js";

const rpc: Record<string, unknown>[] = readFileSync("test/fixtures/omo-rpc/run1.jsonl", "utf8").trim().split("\n").map((line) => JSON.parse(line));
const stateEntries = rpc.filter((event) => event.type === "entry_appended")
  .map((event) => event.entry as Record<string, unknown>).filter((entry) => entry.customType === "senpi.todo-state");
const state = (status = "pending") => ({ type: "custom", customType: "senpi.todo-state",
  data: { phases: [{ name: "First", tasks: [{ content: "One", status }] }, { name: "Second", tasks: [{ content: "Two", status: "pending" }] }] } });

function session(piPath: string): ManagedSession {
  return {
    info: { id: "ses_test", projectID: "/tmp/test", directory: "/tmp/test", title: "Todos", version: "test", time: { created: 0, updated: 0 } },
    pi: undefined, messages: [], status: { type: "idle" }, model: undefined, streaming: undefined,
    toolByCallId: new Map(), tree: { messageEntries: {} }, piPath, hasPendingInteraction: () => false, hasRunningChildren: () => false,
  };
}

test("flattening produces stable phase-aware ids and all disk statuses", () => {
  const statuses = ["pending", "in_progress", "completed", "abandoned", "dropped", "cancelled", "unexpected"];
  const data = { phases: [{ name: "Phase", tasks: statuses.map((status) => ({ content: status, status })) }] };
  const todos = flattenTodos("ses_test", data);
  assert.deepEqual(todos.map((todo) => todo.status), ["pending", "in_progress", "completed", "cancelled", "cancelled", "cancelled", "pending"]);
  assert.equal(todos[0]?.id, createHash("md5").update("ses_test|Phase|pending").digest("hex").slice(0, 16));
  assert.ok(todos.every((todo) => todo.priority === "medium" && !todo.content.includes(":")));
  assert.notEqual(todos[0]?.id, flattenTodos("ses_other", data)[0]?.id);
  assert.deepEqual(flattenTodos("ses_test", state().data).map((todo) => todo.content), ["First: One", "Second: Two"]);
  assert.equal(flattenTodos("ses_test", state().data)[0]?.id, flattenTodos("ses_test", state("completed").data)[0]?.id);
});

test("malformed state is empty or skips invalid tasks and unknown statuses default pending", () => {
  for (const data of [null, {}, { phases: null }, { phases: [null, {}, { name: "Phase" }] }]) assert.deepEqual(flattenTodos("s", data), []);
  assert.deepEqual(flattenTodos("s", { phases: [{ name: "Phase", tasks: [null, {}, { content: "valid", status: 42 }] }] })
    .map((todo) => todo.status), ["pending"]);
  const fixture = JSON.parse(readFileSync("test/fixtures/omo-tools/todo-state.json", "utf8"));
  assert.ok(fixture.entries.length > 0);
  for (const entry of fixture.entries) assert.doesNotThrow(() => flattenTodos("s", entry.data));
});

test("todo fixture operations map to todowrite without parsing success output as state", () => {
  const fixture = JSON.parse(readFileSync("test/fixtures/omo-tools/todo.json", "utf8"));
  for (const sample of fixture.samples) {
    const mapped = mapTool("todo", sample.arguments, sample);
    assert.equal(mapped.tool, "todowrite");
    assert.deepEqual(mapped.input, { todos: [] });
  }
});

test("state after toolResult patches only that card and emits every state update", () => {
  const bridge = new TodoBridge("ses_test");
  const part: OCToolPart = { id: "p", sessionID: "ses_test", messageID: "m", type: "tool", callID: "c", tool: "todowrite",
    state: { status: "completed", input: {}, output: "success but not state", title: "Todos", metadata: {}, time: { start: 0, end: 1 } } };
  bridge.track(part, { op: "init" });
  bridge.finish(part, false);
  assert.deepEqual(bridge.entry(state())?.properties.todos, flattenTodos("ses_test", state().data));
  const previous = part.state.input.todos;
  assert.equal(bridge.entry(state("completed"))?.properties.todos[0]?.status, "completed");
  assert.equal(part.state.input.todos, previous);
  assert.equal(bridge.entry({ type: "custom", customType: "other" }), undefined);
  assert.deepEqual(bridge.entry({ type: "custom", customType: "senpi.todo-state", data: {} })?.properties.todos, []);
});

test("real RPC emits six todo events and restores identical per-call snapshots including trailing state", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ocpi-todo-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const live = session(join(dir, "session.jsonl"));
  const events: (OCEvent | TodoUpdated)[] = [];
  const manager = new SessionManager((_directory, event) => events.push(structuredClone(event)), new SessionStore(join(dir, "registry.json")));
  t.after(() => manager.disposeAll());
  for (const event of rpc) manager["onPiEvent"](live, event);
  const updates = events.filter((event): event is TodoUpdated => event.type === "todo.updated");
  assert.equal(updates.length, 6);
  assert.deepEqual(updates.map((event) => event.properties.todos), stateEntries.map((entry) => flattenTodos("ses_test", entry.data)));
  const entries = rpc.filter((event) => event.type === "entry_appended").map((event) => event.entry);
  writeFileSync(live.piPath!, entries.map((entry) => JSON.stringify(entry)).join("\n"));
  const restored = session(live.piPath!);
  restored.messages = undefined;
  const history = manager["ensureMessages"](restored);
  const cards = (messages: typeof history) => messages.flatMap((message) => message.parts)
    .filter((part): part is OCToolPart => part.type === "tool" && part.tool === "todowrite");
  assert.equal(cards(history).length, 6);
  assert.deepEqual(cards(history).map((part) => part.state.input), cards(live.messages!).map((part) => part.state.input));
  assert.notDeepEqual(cards(history)[0]?.state.input, cards(history).at(-1)?.state.input);
  assert.deepEqual(restored.todoBridge?.todos, live.todoBridge?.todos);
});

test("fetching restored messages hydrates the todo panel through SSE", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ocpi-todo-hydrate-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const s = session(join(dir, "session.jsonl"));
  writeFileSync(s.piPath!, JSON.stringify(state("completed")));
  s.messages = undefined;
  const events: (OCEvent | TodoUpdated)[] = [];
  const manager = new SessionManager((_directory, event) => events.push(event), new SessionStore(join(dir, "registry.json")));
  t.after(() => manager.disposeAll());
  t.mock.method(manager, "get", () => s);
  manager.messages(s.info.id);
  assert.deepEqual(events, [{ type: "todo.updated", properties: { sessionID: s.info.id, todos: flattenTodos(s.info.id, state("completed").data) } }]);
});

test("live result-before-state event order updates the completed card and route state", (t) => {
  const s = session("/nonexistent");
  const manager = new SessionManager(() => {});
  t.after(() => manager.disposeAll());
  manager["onPiEvent"](s, { type: "message_start", message: { role: "assistant" } });
  manager["onPiEvent"](s, { type: "message_update", assistantMessageEvent: { type: "toolcall_end", contentIndex: 0,
    toolCall: { id: "todo-call", name: "todo", arguments: { op: "init" } } } });
  manager["onPiEvent"](s, { type: "tool_execution_end", toolCallId: "todo-call", result: { content: [{ type: "text", text: "success" }] } });
  manager["onPiEvent"](s, { type: "entry_appended", entry: state("completed") });
  const part = s.messages?.[0]?.parts[0];
  assert.ok(part?.type === "tool");
  assert.deepEqual(part.state.input.todos, flattenTodos("ses_test", state("completed").data));
});

test("both HTTP flavors return dormant JSONL state after restart and empty sessions return 200", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ocpi-todo-route-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  });
  const sessionDir = piSessionDir(dir);
  mkdirSync(sessionDir, { recursive: true });
  const header = (id: string) => JSON.stringify({ type: "session", version: 3, id, cwd: dir, timestamp: "2026-10-12T00:00:00.000Z" }) + "\n";
  const piPath = join(sessionDir, "session.jsonl");
  writeFileSync(piPath, header("pi-todo") + [state(), state("completed")].map((entry) => JSON.stringify(entry)).join("\n"));
  const store = new SessionStore(join(dir, "registry.json"));
  store.set(ocIdFor("pi-todo"), { piSessionId: "pi-todo", piPath, directory: dir, created: 0, updated: 0 });
  const emptyPath = join(sessionDir, "empty.jsonl");
  writeFileSync(emptyPath, header("pi-empty"));
  store.set(ocIdFor("pi-empty"), { piSessionId: "pi-empty", piPath: emptyPath, directory: dir, created: 0, updated: 0 });
  for (let restart = 0; restart < 2; restart++) {
    const server = new AdapterServer({ host: "127.0.0.1", port: 0, defaultDirectory: dir });
    server["sessions"] = new SessionManager(() => {}, store, dir);
    await server.start();
    try {
      for (const prefix of ["", "/api"]) {
        for (const [piID, expected] of [["pi-todo", flattenTodos(ocIdFor("pi-todo"), state("completed").data)], ["pi-empty", []]] as const) {
          const response = await fetch(`${server.url}${prefix}/session/${ocIdFor(piID)}/todo`);
          assert.equal(response.status, 200);
          const body = await response.json();
          assert.deepEqual(prefix === "" ? body : body.data, expected);
        }
      }
    } finally { await server.stop(); }
  }
});

test("HTTP SSE subscribers receive v1 properties and v2 data todo events", async () => {
  const server = new AdapterServer({ host: "127.0.0.1", port: 0, defaultDirectory: "/tmp/test" });
  await server.start();
  const controllers: AbortController[] = [];
  try {
    for (const path of ["/event", "/api/event"]) {
      const controller = new AbortController();
      controllers.push(controller);
      const response = await fetch(`${server.url}${path}`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]) });
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const readEvent = async () => {
        while (!buffer.includes("\n\n")) {
          const chunk = await reader.read();
          assert.equal(chunk.done, false, "SSE stream ended before its event");
          buffer += decoder.decode(chunk.value, { stream: true });
        }
        const boundary = buffer.indexOf("\n\n");
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        return JSON.parse(frame.replace(/^data: /, ""));
      };
      assert.equal((await readEvent()).type, "server.connected"); // subscribe before triggering the entry
      const s = session("/nonexistent");
      server["sessions"]["onPiEvent"](s, { type: "entry_appended", entry: state() });
      const event = await readEvent();
      assert.equal(event.type, "todo.updated");
      assert.deepEqual(path === "/event" ? event.properties : event.data, {
        sessionID: "ses_test", todos: flattenTodos("ses_test", state().data),
      });
      if (path === "/api/event") assert.deepEqual(event.location, { directory: "/tmp/test" });
      await reader.cancel();
      controller.abort();
    }
  } finally {
    controllers.forEach((controller) => controller.abort());
    await server.stop();
  }
});

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { mapTool, toolMappers } from "../src/tool-map.js";
import { SessionManager, type ManagedSession } from "../src/sessions.js";
import { SessionStore } from "../src/session-store.js";
import type { OCToolPart } from "../src/types.js";

const fixtures = join(process.cwd(), "test/fixtures/omo-tools");
const keys: Record<string, string[]> = {
  read: ["filePath", "offset", "limit"],
  write: ["filePath", "content"],
  edit: ["filePath", "oldString", "newString"],
  multiedit: ["filePath", "edits"],
  eval: ["language", "code", "description"],
  question: ["questions"],
  task: ["description", "prompt", "subagent_type"],
};

for (const file of readdirSync(fixtures).filter((name) => name.endsWith(".json") && name !== "todo-state.json")) {
  const fixture = JSON.parse(readFileSync(join(fixtures, file), "utf8")) as {
    tool: string;
    samples: Array<{ arguments: Record<string, unknown>; content: unknown; details: Record<string, unknown>; isError: boolean }>;
  };
  test(`real ${fixture.tool} fixtures map renderer inputs and text output`, () => {
    for (const sample of fixture.samples) {
      const mapped = mapTool(fixture.tool, sample.arguments, sample);
      if (keys[mapped.tool] !== undefined) assert.deepEqual(Object.keys(mapped.input), keys[mapped.tool]);
      else assert.deepEqual(mapped.input, sample.arguments);
      const blocks = sample.content as Array<{ type: string; text?: string }>;
      assert.equal(mapped.output, blocks.filter((block) => block.type === "text").map((block) => block.text ?? "").join(""));
      if (fixture.tool === "edit") {
        assert.deepEqual(mapped.metadata?.filediff, { file: sample.arguments.path });
        assert.equal(mapped.metadata?.patch, sample.details.patch);
        assert.equal(mapped.metadata?.diff, sample.details.diff);
      }
      if (fixture.tool === "read" || fixture.tool === "write") assert.equal(mapped.input.filePath, sample.arguments.path);
      if (fixture.tool === "eval") assert.equal(mapped.title, sample.arguments.summary);
      if (fixture.tool === "task") {
        assert.equal(mapped.input.description, sample.arguments.task_summary ?? sample.arguments.name ?? sample.arguments.description);
        assert.equal(mapped.input.subagent_type, sample.arguments.subagent_type ?? sample.arguments.category);
        assert.equal(mapped.metadata, undefined);
      }
    }
  });
}

test("single and multiple edits carry renderer strings and file metadata", () => {
  const first = { oldText: "before", newText: "after" };
  assert.deepEqual(mapTool("edit", { path: "a.txt", edits: [first] }), {
    tool: "edit", input: { filePath: "a.txt", oldString: "before", newString: "after" },
    title: "a.txt", metadata: { filediff: { file: "a.txt" } },
  });
  assert.deepEqual(mapTool("edit", { path: "a.txt", edits: [first, first] }).input, {
    filePath: "a.txt", edits: Array(2).fill({ filePath: "a.txt", oldString: "before", newString: "after" }),
  });
});

test("write completion emits content-only metadata even when the result contains diffs", () => {
  const mapped = mapTool("write", { path: "out.txt", content: "initial" }, {
    content: [{ type: "text", text: "Successfully wrote to out.txt" }],
    details: {
      patch: "--- out.txt\n+++ out.txt\n@@ -1 +1 @@\n-updated\n+initial\n",
      diff: "-updated\n+initial",
      filediff: { file: "out.txt", before: "updated", after: "initial" },
    },
  });
  assert.deepEqual(mapped.input, { filePath: "out.txt", content: "initial" });
  assert.equal(mapped.metadata, undefined);
  assert.equal(mapped.output, "Successfully wrote to out.txt");
});

test("bash and questions use native renderer contracts", () => {
  assert.deepEqual(mapTool("bash", { command: "pwd", description: "Working directory" }).input,
    { command: "pwd", description: "Working directory" });
  const options = [{ label: "Yes", description: "Proceed" }];
  assert.deepEqual(mapTool("ask_user_question", {
    questions: [{ question: "Proceed?", header: "Choice", options, multiSelect: true }],
  }).input, { questions: [{ question: "Proceed?", header: "Choice", options, multiple: true }] });
});

test("unknown tools and todo pass through with prioritized bounded titles", () => {
  const args = { summary: "s".repeat(70), description: "lower priority", other: 1 };
  assert.deepEqual(mapTool("unknown", args), { tool: "unknown", input: args, title: "s".repeat(60) });
  assert.deepEqual(mapTool("todo", { op: "view" }), { tool: "todo", input: { op: "view" }, title: "todo" });
  assert.equal(mapTool("toString", {}).tool, "toString");
  assert.equal(mapTool("unknown", { url: "https://example.org" }).title, "https://example.org");
});

test("malformed and missing arguments never throw or invent an edit diff", () => {
  for (const name of ["read", "write", "edit", "bash", "eval", "ask_user_question", "task", "unknown"]) {
    for (const args of [undefined, null, [], 42, "bad"]) assert.doesNotThrow(() => mapTool(name, args));
  }
  for (const edits of [[], [null], [{}], "bad"]) {
    const args = { path: "a.txt", edits };
    const mapped = mapTool("edit", args);
    assert.deepEqual(mapped.input, args);
    assert.equal(mapped.metadata, undefined);
  }
  assert.equal(mapTool("unknown", {}, { content: [{ type: "image", text: "not text" }, { type: "text", text: "one" }, { type: "text", text: "two" }] }).output, "onetwo");
});

test("later bridges can register todo and task handlers", () => {
  const previous = toolMappers.todo;
  try {
    toolMappers.todo = (args) => ({ tool: "todowrite", input: { todos: args.items }, title: "Todos" });
    assert.equal(mapTool("todo", { items: [] }).tool, "todowrite");
  } finally {
    if (previous === undefined) delete toolMappers.todo;
    else toolMappers.todo = previous;
  }
});

function session(piPath: string): ManagedSession {
  return {
    info: { id: "ses_test", projectID: "/tmp/test", directory: "/tmp/test", title: "Tools", version: "test", time: { created: 0, updated: 0 } },
    pi: undefined, messages: [], status: { type: "idle" }, model: undefined, streaming: undefined,
    toolByCallId: new Map(), piPath,
    hasPendingInteraction: () => false, hasRunningChildren: () => false,
  };
}

function comparable(part: OCToolPart): unknown {
  const { id, messageID, ...rest } = part;
  return JSON.parse(JSON.stringify(rest));
}

for (const executionEvents of [true, false]) {
test(`real RPC ${executionEvents ? "execution" : "turn_end-only"} events and JSONL history produce identical tool parts`, (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ocpi-tool-map-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  t.mock.method(Date, "now", () => 1000);
  const piPath = join(dir, "session.jsonl");
  const live = session(piPath);
  const manager = new SessionManager(() => {}, new SessionStore(join(dir, "registry.json")));
  const events = readFileSync(join(process.cwd(), "test/fixtures/omo-rpc/run1.jsonl"), "utf8")
    .trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  const entries: Record<string, unknown>[] = [];
  for (const event of events) {
    if (!executionEvents && String(event.type).startsWith("tool_execution_")) continue;
    manager["onPiEvent"](live, event);
    if (event.type !== "message_end") continue;
    const message = event.message as Record<string, unknown>;
    if (!["user", "assistant", "toolResult"].includes(String(message.role))) continue;
    const parentId = entries.length > 0 ? String(entries[entries.length - 1]?.id) : null;
    entries.push({ type: "message", id: `e${entries.length}`, parentId, timestamp: 1000, message });
  }
  writeFileSync(piPath, entries.map((entry) => JSON.stringify(entry)).join("\n"));
  const restored = session(piPath);
  restored.messages = undefined;
  const history = manager["ensureMessages"](restored);
  const liveParts = live.messages?.flatMap((message) => message.parts).filter((part): part is OCToolPart => part.type === "tool") ?? [];
  const historyParts = history.flatMap((message) => message.parts).filter((part): part is OCToolPart => part.type === "tool");
  assert.ok(liveParts.length >= 5);
  assert.deepEqual(liveParts.map(comparable), historyParts.map(comparable));
  assert.ok(liveParts.some((part) => part.tool === "read"));
  assert.ok(liveParts.some((part) => part.tool === "write"));
  assert.ok(liveParts.some((part) => part.tool === "edit"));
  for (const part of [...liveParts, ...historyParts].filter((part) => part.tool === "write")) {
    assert.ok(part.state.status === "completed");
    assert.deepEqual(part.state.metadata, {});
  }
});
}

for (const resultEvent of ["tool_execution_end", "turn_end"]) {
test(`${resultEvent} errors preserve mapped input metadata and error text`, () => {
  const s = session("/nonexistent");
  const manager = new SessionManager(() => {});
  manager["onPiEvent"](s, { type: "message_start", message: { role: "assistant" } });
  manager["onPiEvent"](s, { type: "message_update", assistantMessageEvent: {
    type: "toolcall_end", contentIndex: 0,
    toolCall: { id: "failed", name: "edit", arguments: { path: "x", edits: [{ oldText: "a", newText: "b" }] } },
  } });
  const result = { toolCallId: "failed", isError: true, content: [{ type: "text", text: "edit failed" }] };
  manager["onPiEvent"](s, resultEvent === "turn_end"
    ? { type: resultEvent, toolResults: [result] }
    : { type: resultEvent, ...result, result });
  const part = s.messages?.[0]?.parts[0];
  assert.ok(part?.type === "tool" && part.state.status === "error");
  assert.equal(part.state.error, "edit failed");
  assert.deepEqual(part.state.input, { filePath: "x", oldString: "a", newString: "b" });
  assert.deepEqual(part.state.metadata, { filediff: { file: "x" } });
});
}

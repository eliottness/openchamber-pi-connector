/// <reference types="node" />
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager, type ManagedSession } from "../src/sessions.js";
import { SessionStore } from "../src/session-store.js";
import { AdapterServer } from "../src/server.js";
import { providerToolParts } from "../src/tool-map.js";
import { spawnSync } from "node:child_process";
import type { OCPart, OCToolPart } from "../src/types.js";

const fixture: { content: Array<Record<string, unknown>> } = JSON.parse(
  readFileSync(new URL("./fixtures/omo-server-tools.json", import.meta.url), "utf8"),
);

function session(piPath: string): ManagedSession {
  return {
    info: { id: "ses_server", projectID: "/tmp/test", directory: "/tmp/test", title: "Server tools", version: "test", time: { created: 1000, updated: 1000 } },
    pi: undefined, messages: [], status: { type: "idle" }, model: undefined, streaming: undefined,
    toolByCallId: new Map(), tree: { messageEntries: {} }, piPath,
    hasPendingInteraction: () => false, hasRunningChildren: () => false,
  };
}

function tools(parts: OCPart[]): OCToolPart[] {
  return parts.filter((part): part is OCToolPart => part.type === "tool");
}

function comparable(part: OCToolPart): unknown {
  const { messageID, ...rest } = part;
  return rest;
}

for (const rawFormat of ["object", "json", "repr"]) {
  test(`server cards pair by id and match live/history with ${rawFormat} raw`, async (t) => {
    // Given: sanitized real-shaped calls with reversed result order.
    const dir = mkdtempSync(join(tmpdir(), "ocpi-server-tools-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const piPath = join(dir, "session.jsonl");
    const content = fixture.content.map((block) => {
      if (block.type !== "providerNative" || rawFormat === "object") return block;
      const json = JSON.stringify(block.raw);
      return { ...block, raw: rawFormat === "json" ? json : json.replace(/"([^"]*)"/g, "'$1'").replace(/null/g, "None") };
    });
    const message = { role: "assistant", content, timestamp: 1000 };
    writeFileSync(piPath, JSON.stringify({ type: "message", id: "assistant", message }));
    const manager = new SessionManager(() => {}, new SessionStore(join(dir, "state")));
    t.after(() => manager.disposeAll());
    const live = session(piPath);
    // When: full snapshots arrive via updates and then message_end.
    manager["onPiEvent"](live, { type: "message_start", message });
    manager["onPiEvent"](live, { type: "message_update", message, assistantMessageEvent: { type: "text_start", contentIndex: 7, partial: message } });
    for (const [contentIndex, block] of content.entries()) {
      if (block.type === "text" || block.type === "thinking") {
        manager["onPiEvent"](live, { type: "message_update", message, assistantMessageEvent: {
          type: `${block.type}_end`, contentIndex, content: block.text ?? block.thinking, partial: message,
        } });
      }
    }
    manager["onPiEvent"](live, { type: "message_end", message });
    manager["onPiEvent"](live, { type: "agent_end" });
    const restored = session(piPath);
    restored.messages = undefined;
    const history = manager["ensureMessages"](restored);
    const liveParts = live.messages?.[0]?.parts ?? [];
    const historyParts = history[0]?.parts ?? [];
    // Then: one card per call, unchanged adjacent parts, stable ids after restart.
    assert.equal(tools(liveParts).length, 3);
    assert.deepEqual(tools(liveParts).map(comparable), tools(historyParts).map(comparable));
    assert.deepEqual(historyParts.map((part) => part.type), ["text", "tool", "reasoning", "tool", "tool", "text"]);
    assert.deepEqual(liveParts.map((part) => part.type), historyParts.map((part) => part.type));
    assert.deepEqual(liveParts.filter((part) => part.type !== "tool").map((part) => part.text),
      ["Before search.", "Compare sources.", "After search."]);
    const [web, search, openai] = tools(historyParts);
    assert.ok(web?.state.status === "completed");
    assert.equal(web.tool, "websearch");
    assert.deepEqual(web.state.input, { query: "Twitch dark theme color tokens" });
    assert.equal(web.state.title, "Twitch dark theme color tokens");
    assert.equal(web.state.output, "Twitch Colors - Hex and RGB Color Codes - https://www.codeofcolors.com/twitch-colors.html");
    assert.ok(search?.state.status === "completed");
    assert.equal(search.tool, "tool_search_tool_bm25");
    assert.equal(search.state.title, "monitor command background completion");
    assert.equal(search.state.output, "bash_output\nmemory");
    assert.ok(openai?.state.status === "completed");
    assert.equal(openai.tool, "websearch");
    assert.equal(openai.state.title, "site.noctua.at fan does not spin\nsite.asus.com Q Fan fan stop");
    assert.equal(openai.state.output, "");
    restored.messages = undefined;
    assert.deepEqual(manager["ensureMessages"](restored)[0]?.parts, historyParts);
  });
}

test("message_end alone maps server cards and skips malformed or unrelated native blocks", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ocpi-server-errors-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const piPath = join(dir, "session.jsonl");
  const manager = new SessionManager(() => {}, new SessionStore(join(dir, "state")));
  t.after(() => manager.disposeAll());
  const live = session(piPath);
  const message = { role: "assistant", timestamp: 1000, content: [
    fixture.content[1],
    { type: "providerNative", subtype: "web_search_tool_result", raw: {
      tool_use_id: "srvtoolu_web", content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" },
    } },
    { type: "providerNative", subtype: "web_search_call", raw: { id: "failed", status: "failed", action: { query: "fail query" } } },
    { type: "providerNative", subtype: "server_tool_use", raw: "not parseable" },
    { type: "providerNative", subtype: "server_tool_use", raw: "{'id': __import__('os').system('bad')}" },
    { type: "providerNative", subtype: "fallback", raw: { id: "marker" } },
  ] };
  writeFileSync(piPath, JSON.stringify({ type: "message", id: "error", message }));
  manager["onPiEvent"](live, { type: "message_start", message });
  manager["onPiEvent"](live, { type: "message_end", message });
  manager["onPiEvent"](live, { type: "agent_end" });
  const cards = tools(live.messages?.[0]?.parts ?? []);
  assert.equal(cards.length, 2);
  assert.ok(cards[0]?.state.status === "error");
  assert.equal(cards[0].state.error, "max_uses_exceeded");
  assert.ok(cards[1]?.state.status === "error");
});

test("incremental partial snapshots update a single card without changing its id", () => {
  const manager = new SessionManager(() => {});
  const live = session("/nonexistent");
  const message = { role: "assistant", timestamp: 1000, content: fixture.content.slice(0, 2) };
  manager["onPiEvent"](live, { type: "message_start", message });
  manager["onPiEvent"](live, { type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: message } });
  const initial = tools(live.messages?.[0]?.parts ?? []);
  assert.equal(initial.length, 1);
  assert.equal(initial[0]?.state.status, "running");
  const callId = initial[0]?.id;
  const ended = { ...message, content: fixture.content };
  manager["onPiEvent"](live, { type: "message_update", assistantMessageEvent: { type: "done", partial: ended } });
  manager["onPiEvent"](live, { type: "message_end", message: ended });
  const cards = tools(live.messages?.[0]?.parts ?? []);
  assert.equal(cards.length, 3);
  assert.equal(cards[0]?.id, callId);
  assert.equal(cards[0]?.state.status, "completed");
});

test("server result in a later assistant message completes the original card live and after restart", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ocpi-server-later-result-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const piPath = join(dir, "session.jsonl");
  const messages = [
    { role: "assistant", timestamp: 1000, content: [fixture.content[1]] },
    { role: "assistant", timestamp: 2000, content: [fixture.content[5], { type: "text", text: "Found it." }] },
  ];
  writeFileSync(piPath, messages.map((message, index) => JSON.stringify({
    type: "message", id: `e${index}`, parentId: index === 0 ? null : "e0", message,
  })).join("\n"));
  const manager = new SessionManager(() => {}, new SessionStore(join(dir, "state")));
  t.after(() => manager.disposeAll());
  const live = session(piPath);
  for (const message of messages) {
    manager["onPiEvent"](live, { type: "message_start", message });
    manager["onPiEvent"](live, { type: "message_end", message });
    if (message.timestamp === 1000) assert.equal(tools(live.messages?.[0]?.parts ?? [])[0]?.state.status, "running");
  }
  manager["onPiEvent"](live, { type: "agent_end" });
  const restored = session(piPath);
  restored.messages = undefined;
  const history = manager["ensureMessages"](restored);
  const cards = tools(live.messages?.flatMap((m) => m.parts) ?? []);
  assert.equal(cards.length, 1);
  assert.ok(cards[0]?.state.status === "completed");
  assert.equal(cards[0].state.output, "Twitch Colors - Hex and RGB Color Codes - https://www.codeofcolors.com/twitch-colors.html");
  assert.deepEqual(cards[0].state.time, { start: 1000, end: 2000 });
  assert.deepEqual(cards.map(comparable), tools(history.flatMap((m) => m.parts)).map(comparable));
  assert.equal(history[1]?.parts.length, 1);
  assert.equal(history[1]?.parts[0]?.type, "text");
});

for (const count of [1, 2]) {
  for (const withNative of [false, true]) {
    test(`messages route preserves ${count} expanded task cards with native=${withNative}`, async (t) => {
      const dir = mkdtempSync(join(tmpdir(), "ocpi-mixed-cards-"));
      const piPath = join(dir, "session.jsonl");
      writeFileSync(piPath, JSON.stringify({ type: "message", id: "a", message: { role: "assistant", content: [] } }));
      const manager = new SessionManager(() => {}, new SessionStore(join(dir, "state")));
      const server = new AdapterServer({ host: "127.0.0.1", port: 0, defaultDirectory: dir });
      await server["sessions"].disposeAll();
      server["sessions"] = manager;
      t.after(async () => { await server.stop(); rmSync(dir, { recursive: true, force: true }); });
      const live = session(piPath);
      manager["sessions"].set(live.info.id, live);
      await server.start();
      const items = Array.from({ length: count }, (_, i) => ({ description: `child ${i}`, prompt: `prompt ${i}` }));
      const args = count === 1 ? items[0] : { tasks: items };
      const content: Array<Record<string, unknown>> = [
        { type: "text", text: "Before" }, { type: "toolCall", id: "task_call", name: "task", arguments: args },
      ];
      const message = { role: "assistant", timestamp: 1000, content };
      manager["onPiEvent"](live, { type: "message_start", message });
      manager["onPiEvent"](live, { type: "message_update", message, assistantMessageEvent: {
        type: "text_end", contentIndex: 0, content: "Before", partial: message,
      } });
      for (const type of ["toolcall_start", "toolcall_end"]) {
        manager["onPiEvent"](live, { type: "message_update", message, assistantMessageEvent: {
          type, contentIndex: 1, id: "task_call", toolName: "task",
          toolCall: { id: "task_call", name: "task", arguments: args }, partial: message,
        } });
      }
      const original = tools(live.messages?.[0]?.parts ?? []).filter((part) => part.tool === "task");
      assert.equal(original.length, count);
      if (withNative) content.push(fixture.content[1] ?? {}, fixture.content[5] ?? {});
      content.push({ type: "text", text: "After" });
      manager["onPiEvent"](live, { type: "message_update", message, assistantMessageEvent: {
        type: "text_end", contentIndex: content.length - 1, content: "After", partial: message,
      } });
      manager["onPiEvent"](live, { type: "message_end", message });
      const details = count === 1
        ? { status: "completed", final_response: "done 0" }
        : { items: items.map((_, i) => ({ status: "completed", final_response: `done ${i}` })) };
      manager["onPiEvent"](live, { type: "tool_execution_end", toolCallId: "task_call",
        result: { details, content: [{ type: "text", text: "done 0" }] } });
      manager["onPiEvent"](live, { type: "agent_end" });
      const response = await fetch(`${server.url}/session/${live.info.id}/message`);
      assert.equal(response.status, 200);
      const messages: Array<{ parts: OCPart[] }> = await response.json();
      const returned = tools(messages.flatMap((m) => m.parts)).filter((part) => part.tool === "task");
      assert.deepEqual(returned.map((part) => part.id), original.map((part) => part.id));
      returned.forEach((part, i) => {
        assert.equal(part.id, `prt_task_task_call_${i}`);
        assert.equal(part.state.input.description, `child ${i}`);
        assert.equal(part.state.input.prompt, `prompt ${i}`);
        assert.ok(part.state.status === "completed");
        assert.equal(part.state.output, `done ${i}`);
      });
      assert.deepEqual(messages[0]?.parts.filter((p) => p.type === "text").map((p) => p.text), ["Before", "After"]);
      assert.deepEqual(messages[0]?.parts.map((part) => part.type),
        ["text", ...Array(count).fill("tool"), ...(withNative ? ["tool"] : []), "text"]);
    });
  }
}

test("malformed repr parsing is bounded even for escaped quotes without a closing quote", { timeout: 3000 }, () => {
  // Run in a child so the watchdog can stop the old synchronous quadratic scan.
  const probe = `
    import { providerToolParts } from './src/tool-map.ts';
    const started = performance.now();
    for (const length of [32000, 256000, 2000000]) {
      const raw = String.fromCharCode(92, 34).repeat(length / 2);
      if (providerToolParts([{type:'providerNative',subtype:'server_tool_use',raw}], 's','m',0).size !== 0) process.exit(2);
    }
    console.log(JSON.stringify({ms:performance.now()-started}));
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", probe], {
    cwd: process.cwd(), encoding: "utf8", timeout: 2000,
  });
  assert.equal(result.error, undefined, `parser exceeded watchdog: ${result.error?.message}`);
  assert.equal(result.status, 0, result.stderr);
  const timing: { ms: number } = JSON.parse(result.stdout);
  assert.ok(timing.ms < 500, `malformed parser took ${timing.ms}ms`);
  // A query exceeding the explicit raw cap is not parsed even when valid.
  assert.equal(providerToolParts([{ type: "providerNative", subtype: "server_tool_use",
    raw: JSON.stringify({ id: "large", name: "web_search", input: { query: "a".repeat(2_000_000) } }) }],
  "s", "m", 0).size, 0);
});

test("Python repr escapes preserve the exact query rather than dropping valid calls", () => {
  const fixture: Array<{ raw: string; query: string }> = JSON.parse(
    readFileSync(new URL("./fixtures/provider-python-repr.json", import.meta.url), "utf8"));
  for (const sample of fixture) {
    const part = providerToolParts([{ type: "providerNative", subtype: "server_tool_use", raw: sample.raw }],
      "s", "m", 0).get(0);
    assert.ok(part, sample.raw);
    assert.equal(part.state.input.query, sample.query);
  }
  for (const query of [String.raw`\xGG`, String.raw`\u123`, String.raw`\U00110000`]) {
    assert.equal(providerToolParts([{ type: "providerNative", subtype: "server_tool_use",
      raw: `{'id':'bad','name':'web_search','input':{'query':'${query}'}}` }], "s", "m", 0).size, 0);
  }
});

for (const reason of ["toolUse", "stop", "aborted", "error"]) {
  test(`unresolved server call with ${reason} is never successful live or in history`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "ocpi-native-incomplete-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const piPath = join(dir, "session.jsonl");
    const message = { role: "assistant", timestamp: 1000, stopReason: reason, content: [fixture.content[1]] };
    writeFileSync(piPath, JSON.stringify({ type: "message", id: "a", message }));
    const manager = new SessionManager(() => {}, new SessionStore(join(dir, "state")));
    t.after(() => manager.disposeAll());
    const live = session(piPath);
    manager["onPiEvent"](live, { type: "message_start", message });
    manager["onPiEvent"](live, { type: "message_end", message });
    if (reason === "toolUse" || reason === "stop") {
      assert.equal(tools(live.messages?.[0]?.parts ?? [])[0]?.state.status, "running");
    }
    if (reason !== "toolUse") manager["onPiEvent"](live, { type: "agent_end" });
    const restored = session(piPath);
    restored.messages = undefined;
    for (const cards of [tools(live.messages?.[0]?.parts ?? []), tools(manager["ensureMessages"](restored)[0]?.parts ?? [])]) {
      const part = cards[0];
      assert.ok(part);
      assert.notEqual(part.state.status, "completed");
      if (reason === "toolUse") assert.equal(part.state.status, "running");
      else {
        assert.ok(part.state.status === "error");
        assert.equal(part.state.error, reason === "aborted" ? "Cancelled" : "No result");
      }
    }
  });
}

#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const sessionId = randomUUID();
const sessionDirectory = join(process.env.PI_CODING_AGENT_DIR, "sessions", `--${process.cwd().replace(/^[/\\]+/, "").replace(/[\\/:\u0000]/g, "-")}--`);
mkdirSync(sessionDirectory, { recursive: true });
const sessionFile = join(sessionDirectory, `${sessionId}.jsonl`);
writeFileSync(sessionFile, JSON.stringify({ type: "session", version: 3, id: sessionId, cwd: process.cwd(), timestamp: new Date().toISOString() }) + "\n");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
let leaf = null;
const entries = [];
const record = (message) => {
  const id = randomUUID();
  const entry = { type: "message", id, parentId: leaf, timestamp: new Date().toISOString(), message };
  appendFileSync(sessionFile, JSON.stringify(entry) + "\n");
  entries.push(entry);
  leaf = id;
};
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const command = JSON.parse(line);
  let data = {};
  if (command.type === "get_state") data = { sessionId, sessionFile, model: { provider: "fake", id: "fake" } };
  if (command.type === "get_entries") data = { entries, leafId: leaf };
  if (command.type === "prompt") {
    record({ role: "user", content: [{ type: "text", text: command.message }] });
    const changes = JSON.parse(command.message);
    send({ type: "agent_start" });
    const content = changes.map((change, index) => ({
      type: "toolCall", id: `call-${index}`, name: change.tool ?? "write",
      arguments: { path: change.path, content: change.content },
    }));
    send({ type: "message_start", message: { role: "assistant", content: [], provider: "fake", model: "fake" } });
    for (const [index, call] of content.entries()) {
      send({ type: "message_update", assistantMessageEvent: { type: "toolcall_end", contentIndex: index, toolCall: call } });
      writeFileSync(join(process.cwd(), call.arguments.path), call.arguments.content);
      send({ type: "tool_execution_end", toolCallId: call.id, isError: false, result: { content: [{ type: "text", text: "written" }] } });
    }
    send({ type: "turn_end", toolResults: [] });
    send({ type: "message_end", message: { role: "assistant", content } });
    record({ role: "assistant", content, provider: "fake", model: "fake" });
    for (const call of content) record({ role: "toolResult", toolCallId: call.id, toolName: call.name, isError: false,
      content: [{ type: "text", text: "written" }] });
    send({ type: "agent_end" });
  }
  send({ type: "response", id: command.id, command: command.type, success: true, data });
});
input.on("close", () => process.exit(0));

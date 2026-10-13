#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const sessionId = randomUUID();
const sessionFile = join(process.cwd(), `fake-endpoints-${sessionId}.jsonl`);
const noSession = process.argv.includes("--no-session");
let leaf;
let timestamp = Date.now();
let hasPrompt = false;
let pendingBash;
let holdEntries = false;
let pendingEntries;
let compactions = 0;
const entries = [];

if (!noSession) {
  writeFileSync(
    sessionFile,
    `${JSON.stringify({
      type: "session",
      version: 3,
      id: sessionId,
      cwd: process.cwd(),
      timestamp: new Date().toISOString(),
    })}\n`,
  );
}

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function reply(command, success, data, error) {
  send({
    type: "response",
    id: command.id,
    command: command.type,
    success,
    ...(data !== undefined ? { data } : {}),
    ...(error !== undefined ? { error } : {}),
  });
}

function recordMessage(role, text) {
  const entry = {
    type: "message",
    id: randomUUID(),
    parentId: leaf,
    timestamp: timestamp++,
    message: {
      role,
      content: [{ type: "text", text }],
      provider: "fake",
      model: "fake-model",
    },
  };
  leaf = entry.id;
  entries.push(entry);
  appendFileSync(sessionFile, `${JSON.stringify(entry)}\n`);
  return entry.message;
}

const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const command = JSON.parse(line);
  switch (command.type) {
    case "get_state":
      reply(command, true, {
        model: { provider: "fake", id: "fake-model" },
        sessionId,
        sessionFile,
        isStreaming: false,
      });
      return;
    case "get_entries":
      if (holdEntries) {
        pendingEntries = command;
        send({ type: "fixture_entries_pending" });
        return;
      }
      reply(command, true, { entries, leafId: leaf ?? null });
      return;
    case "get_commands":
      reply(command, true, {
        commands: [{ name: "fixture", description: "Fixture command", template: "Original template" }],
      });
      return;
    case "prompt": {
      const text = command.message;
      hasPrompt = true;
      if (text === "/notify-fixture") {
        send({ type: "extension_ui_request", id: randomUUID(), method: "notify", message: "Print-only command output", notifyType: "info" });
        reply(command, true, { disposition: "handled" });
        return;
      }
      if (text === "/fixture") {
        recordMessage("assistant", "Slash command output without agent events");
        reply(command, true, {});
        return;
      }
      recordMessage("user", text);
      const assistant = recordMessage("assistant", `reply: ${text}`);
      send({ type: "agent_start" });
      send({ type: "message_start", message: assistant });
      send({
        type: "message_update",
        assistantMessageEvent: { type: "text_end", contentIndex: 0, content: assistant.content[0].text },
      });
      send({ type: "message_end", message: assistant });
      send({ type: "agent_end" });
      reply(command, true, {});
      return;
    }
    case "compact":
      if (!hasPrompt) {
        reply(command, false, undefined, "Nothing to compact (session too small)");
        return;
      }
      compactions++;
      if (process.env.FAKE_OMO_BROKEN_V2_COMPACT === "1" && compactions === 2) {
        reply(command, true, true);
        return;
      }
      recordMessage("assistant", `Compacted summary ${compactions}`);
      reply(command, true, true);
      return;
    case "bash": {
      if (command.command === "fixture-reload-pending") holdEntries = true;
      if (command.command === "echo RELEASE_ENTRIES") {
        holdEntries = false;
        if (pendingEntries !== undefined) {
          reply(pendingEntries, true, { entries, leafId: leaf ?? null });
          pendingEntries = undefined;
        }
      }
      if (command.command === "fixture-cancelled") {
        reply(command, true, { output: "", cancelled: true, truncated: false });
        return;
      }
      if (command.command === "sleep 600" || command.command === "sleep 600 late") {
        pendingBash = command;
        send({ type: "fixture_bash_pending" });
        return;
      }
      if (command.command === "echo RELEASE_LATE" && pendingBash !== undefined) {
        reply(pendingBash, true, { output: "STALE_SUCCESS", exitCode: 0, cancelled: false, truncated: false });
        pendingBash = undefined;
      }
      const match = command.command.match(/^exit\s+(\d+)$/);
      recordMessage("assistant", `Persisted shell output: ${command.command}`);
      reply(command, true, {
        output: "SHELL_OUTPUT",
        exitCode: match ? Number(match[1]) : 0,
        cancelled: false,
        truncated: false,
      });
      return;
    }
    case "abort_bash":
      send({ type: "fixture_abort_bash" });
      if (pendingBash !== undefined && pendingBash.command === "sleep 600") {
        const bash = pendingBash;
        pendingBash = undefined;
        reply(bash, true, { output: "", cancelled: true, truncated: false });
      }
      reply(command, true, true);
      return;
    case "abort":
      reply(command, true, true);
      return;
    case "set_model":
      reply(command, true, { provider: command.provider, id: command.modelId });
      return;
    default:
      reply(command, true, {});
  }
});

input.on("close", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

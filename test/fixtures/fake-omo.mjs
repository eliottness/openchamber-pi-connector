#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const resumeIndex = process.argv.indexOf("--session");
const sessionFile = resumeIndex === -1 ? join(process.cwd(), `${randomUUID()}.jsonl`) : process.argv[resumeIndex + 1];
const header = existsSync(sessionFile) ? JSON.parse(readFileSync(sessionFile, "utf8").split("\n")[0]) :
  { type: "session", version: 3, id: randomUUID(), cwd: process.cwd(), timestamp: new Date().toISOString() };
if (!existsSync(sessionFile)) writeFileSync(sessionFile, JSON.stringify(header) + "\n");
const child = spawn("sleep", ["300"], { stdio: "ignore" });
const ignoring = process.argv.includes("--ignore-term");
const requireGroup = process.argv.includes("--require-group");
let stopping = false;
let leaf = null;
const records = readFileSync(sessionFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
for (const record of records) if (record.type === "message") leaf = record.id;
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const stop = (eof = false) => {
  if (eof && requireGroup) return;
  if (ignoring) {
    if (child.exitCode !== null || child.signalCode !== null) send({ type: "fake_term_ignored" });
    else child.once("exit", () => send({ type: "fake_term_ignored" }));
    return;
  }
  if (stopping) return;
  stopping = true;
  // The group-kill fixture must not hide a root-only kill by killing its child.
  // EOF cleanup is a separate contract exercised by the connector SIGKILL test.
  if (eof) child.kill("SIGTERM");
  if (child.exitCode !== null || child.signalCode !== null) process.exit(0);
  else child.once("exit", () => process.exit(0));
};
process.on("SIGTERM", () => stop());
process.on("SIGINT", () => stop());
const input = createInterface({ input: process.stdin });
input.on("close", () => stop(true));
let model = { provider: "fake", id: "fake-model" };
const record = (role, text) => {
  const entry = { type: "message", id: randomUUID(), parentId: leaf, timestamp: Date.now(),
    message: { role, content: [{ type: "text", text }], provider: model.provider, model: model.id } };
  leaf = entry.id;
  appendFileSync(sessionFile, JSON.stringify(entry) + "\n");
  return entry.message;
};
input.on("line", (line) => {
  const command = JSON.parse(line);
  let data = {};
  if (command.type === "get_state") data = { model, sessionId: header.id, sessionFile, isStreaming: false,
    pid: process.pid, childPid: child.pid, resumed: resumeIndex !== -1, history: readFileSync(sessionFile, "utf8") };
  if (command.type === "set_model") {
    model = { provider: command.provider, id: command.modelId };
    data = model;
  }
  if (command.type === "prompt") {
    record("user", command.message);
    send({ type: "agent_start" });
    const message = record("assistant", `history:${records.filter((r) => r.type === "message").length};${command.message}`);
    send({ type: "message_start", message });
    send({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: message.content[0].text } });
    send({ type: "message_end", message });
    send({ type: "agent_end" });
  }
  send({ type: "response", id: command.id, command: command.type, success: true, data });
});

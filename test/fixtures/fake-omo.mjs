#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const resumeIndex = process.argv.indexOf("--session");
let sessionFile = resumeIndex === -1 ? join(process.cwd(), `${randomUUID()}.jsonl`) : process.argv[resumeIndex + 1];
let header = existsSync(sessionFile) ? JSON.parse(readFileSync(sessionFile, "utf8").split("\n")[0]) :
  { type: "session", version: 3, id: randomUUID(), cwd: process.cwd(), timestamp: new Date().toISOString() };
if (!existsSync(sessionFile)) writeFileSync(sessionFile, JSON.stringify(header) + "\n");
const child = spawn("sleep", ["300"], { stdio: "ignore" });
const ignoring = process.argv.includes("--ignore-term");
const requireGroup = process.argv.includes("--require-group");
let stopping = false;
let bashRun;
let leaf = null;
let records = readFileSync(sessionFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
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
  if (bashRun) process.kill(-bashRun.proc.pid, "SIGTERM");
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
let thinkingLevel = "medium";
let thinkingCalls = 0;
const thinkingModels = [
  { provider: "fake", id: "fake-model", reasoning: true, supportedThinkingLevels: ["off", "low", "medium", "high"] },
  { provider: "fake", id: "mapped", reasoning: true, thinkingLevelMap: { off: null, minimal: null, low: "low", high: "high" } },
  { provider: "fake", id: "plain", reasoning: false, supportedThinkingLevels: ["off"] },
  { provider: "fake", id: "unknown", reasoning: true },
];
const record = (role, text) => {
  const entry = { type: "message", id: randomUUID(), parentId: leaf, timestamp: Date.now(),
    message: { role, content: [{ type: "text", text }], provider: model.provider, model: model.id, thinkingLevel } };
  leaf = entry.id;
  appendFileSync(sessionFile, JSON.stringify(entry) + "\n");
  records.push(entry);
  return entry.message;
};
const branch = (target = leaf) => {
  const result = [];
  for (let entry = records.find((r) => r.id === target); entry?.type !== "session" && entry; entry = records.find((r) => r.id === entry.parentId)) result.push(entry);
  return result.reverse();
};
input.on("line", (line) => {
  const command = JSON.parse(line);
  let data = {};
  if (command.type === "emit_event") send(command.event);
  if (command.type === "switch_session") {
    sessionFile = command.sessionPath;
    records = readFileSync(sessionFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    header = records[0];
    leaf = records.filter((record) => record.type === "message").at(-1)?.id ?? null;
    data = { cancelled: false };
  }
  if (command.type === "get_entries") data = { entries: records.filter((r) => r.type !== "session"), leafId: leaf };
  if (command.type === "get_tree") {
    const nodes = records.filter((r) => r.type !== "session").map((entry) => ({ entry, children: [] }));
    for (const node of nodes) nodes.find((n) => n.entry.id === node.entry.parentId)?.children.push(node);
    data = { tree: nodes.filter((n) => n.entry.parentId === null), leafId: leaf };
  }
  if (command.type === "navigate_tree") {
    const entry = records.find((r) => r.id === command.targetId && r.type !== "session");
    if (!entry) {
      send({ type: "response", id: command.id, command: command.type, success: false, error: `Entry ${command.targetId} not found` });
      return;
    }
    leaf = command.intent === "resume" || entry.message?.role !== "user" ? entry.id : entry.parentId;
    data = { cancelled: false, leafId: leaf };
  }
  if (command.type === "fork") {
    const entry = records.find((r) => r.id === command.entryId && r.type !== "session");
    if (!entry || (command.position !== "at" && entry.message?.role !== "user")) {
      send({ type: "response", id: command.id, command: command.type, success: false, error: "Invalid entry ID for forking" });
      return;
    }
    leaf = command.position === "at" ? entry.id : entry.parentId;
    const entries = branch();
    header = { ...header, id: randomUUID(), parentSession: sessionFile };
    sessionFile = join(process.cwd(), `${header.id}.jsonl`);
    records = [header, ...entries];
    writeFileSync(sessionFile, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
    data = { cancelled: false };
  }
  if (command.type === "get_available_models") data = { models: thinkingModels };
  if (command.type === "set_thinking_level") {
    thinkingCalls++;
    if (command.level === "max") {
      send({ type: "response", id: command.id, command: command.type, success: false, error: "unsupported thinking level" });
      return;
    }
    thinkingLevel = command.level === "minimal" ? "low" : command.level;
    appendFileSync(sessionFile, JSON.stringify({ type: "thinking_level_change", thinkingLevel }) + "\n");
    send({ type: "thinking_level_changed", level: thinkingLevel });
  }
  if (command.type === "get_state") data = { model, thinkingLevel, thinkingCalls, sessionId: header.id, sessionFile, isStreaming: false,
    pid: process.pid, childPid: child.pid, resumed: resumeIndex !== -1, history: readFileSync(sessionFile, "utf8") };
  if (command.type === "set_model") {
    model = { provider: command.provider, id: command.modelId };
    data = model;
  }
  if (command.type === "compact") record("assistant", "Compacted summary");
  if (command.type === "bash") {
    const proc = spawn("/bin/bash", ["-c", command.command], { cwd: process.cwd(), detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const run = { proc, cancelled: false, output: "" };
    bashRun = run;
    proc.stdout.on("data", (chunk) => { run.output += chunk.toString(); });
    proc.stderr.on("data", (chunk) => { run.output += chunk.toString(); });
    proc.on("close", (exitCode) => {
      bashRun = undefined;
      const result = { output: run.output, exitCode, cancelled: run.cancelled, truncated: false };
      const entry = { type: "message", id: randomUUID(), parentId: leaf, timestamp: Date.now(),
        message: { role: "bashExecution", command: command.command, ...result } };
      leaf = entry.id;
      records.push(entry);
      appendFileSync(sessionFile, JSON.stringify(entry) + "\n");
      send({ type: "fake_bash_finished", command: command.command });
      send({ type: "response", id: command.id, command: command.type, success: true, data: result });
    });
    send({ type: "fake_bash_started", command: command.command });
    return;
  }
  if (command.type === "abort_bash" && bashRun) {
    bashRun.cancelled = true;
    process.kill(-bashRun.proc.pid, "SIGTERM");
  }
  if (command.type === "prompt") {
    record("user", command.message);
    send({ type: "agent_start" });
    if (["pending-question", "pending-permission", "pending-turn"].includes(command.message)) {
      if (command.message !== "pending-turn") send({
        type: "extension_ui_request", id: "pending", method: "select",
        title: command.message === "pending-question" ? "Choose?" : "Permission required: read",
        options: command.message === "pending-question" ? ["A", "B"] : ["Allow once", "Allow always", "Deny", "Deny with feedback"],
      });
      send({ type: "response", id: command.id, command: command.type, success: true, data });
      return;
    }
    const message = record("assistant", `history:${branch().filter((r) => r.type === "message").length};${command.message}`);
    send({ type: "message_start", message });
    send({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: message.content[0].text } });
    send({ type: "message_end", message });
    send({ type: "agent_end" });
    send({ type: "agent_idle" });
  }
  if (command.type === "abort") {
    send({ type: "agent_end" });
    send({ type: "agent_idle" });
  }
  send({ type: "response", id: command.id, command: command.type, success: true, data });
});

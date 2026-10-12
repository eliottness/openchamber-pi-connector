/**
 * Record one permission-gated real OmO RPC turn for protocol fixtures.
 *
 * Writes only redacted agent stdout. Requests sent to stdin are intentionally
 * not included because the fixture is for the connector's incoming protocol.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";

const WORK_DIR = "/tmp/ocomo-qa/t4/work";
const OUTPUT = join(process.cwd(), "test", "fixtures", "omo-rpc", "run1.jsonl");
const OMO = "/home/eliott/.bun/install/global/node_modules/.bin/omo";
const SECRET_KEY = /key|token|secret|password|auth|cookie/i;
const FORBIDDEN = /sk-[A-Za-z0-9]{10,}|gh[pousr]_[A-Za-z0-9]{20,}/g;
const PRIVATE_KEY = "BEGIN" + " PRIVATE KEY";

function redact(value: unknown, key?: string): unknown {
  if (key && SECRET_KEY.test(key)) return undefined;
  if (typeof value === "string") {
    const clipped = value.length > 400 ? `${value.slice(0, 400)}…` : value;
    return clipped.replace(FORBIDDEN, "[REDACTED]").replaceAll(PRIVATE_KEY, "BEGIN [REDACTED] KEY");
  }
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([childKey]) => !SECRET_KEY.test(childKey))
        .map(([childKey, childValue]) => [childKey, redact(childValue, childKey)]),
    );
  }
  return value;
}

const prompt = [
  "Use the todo tool to create a two-phase todo list with one task in each phase.",
  "Read /tmp/ocomo-qa/t4/work/seed.txt.",
  "Write /tmp/ocomo-qa/t4/work/note.txt with exactly the text initial.",
  "Edit that file so its complete content is updated.",
  "Run one foreground subagent with the task tool using category quick and a trivial prompt.",
  "Finally ask the user one question using ask_user_question.",
  "Do not use tools other than those needed for these instructions.",
].join(" ");

async function main(): Promise<void> {
  mkdirSync(WORK_DIR, { recursive: true });
  writeFileSync(join(WORK_DIR, "seed.txt"), "fixture seed\n");
  const child = spawn(OMO, ["--mode", "rpc", "--model", "anthropic/claude-haiku-4-5", "--permission-preset", "ask"], {
    cwd: WORK_DIR,
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });
  const lines: string[] = [];
  let buffer = "";
  let settled = false;
  let promptNumber = 1;
  const finish = (code: number): void => {
    if (settled) return;
    settled = true;
    mkdirSync(join(process.cwd(), "test", "fixtures", "omo-rpc"), { recursive: true });
    writeFileSync(OUTPUT, `${lines.join("\n")}${lines.length > 0 ? "\n" : ""}`);
    process.exitCode = code;
    if (!child.killed) child.kill("SIGTERM");
  };
  const timer = setTimeout(() => finish(1), 6 * 60_000);
  timer.unref();

  child.stderr.on("data", (chunk: Buffer) => process.stderr.write(chunk));
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const raw = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!raw) continue;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        continue;
      }
      lines.push(JSON.stringify(redact(event)));

      if (event.type === "extension_ui_request" && typeof event.id === "string") {
        const title = typeof event.title === "string" ? event.title : "";
        const response =
          event.method === "select" && title.startsWith("Permission required:")
            ? { type: "extension_ui_response", id: event.id, value: "Allow once" }
            : { type: "extension_ui_response", id: event.id, cancelled: true };
        child.stdin.write(`${JSON.stringify(response)}\n`);
      }
      if (event.type === "turn_end") {
        const message = event.message as Record<string, unknown> | undefined;
        if (message?.stopReason === "toolUse" && promptNumber < 10) {
          promptNumber++;
          child.stdin.write(
            `${JSON.stringify({
              id: `p${promptNumber}`,
              type: "prompt",
              message: "Continue and finish every remaining step from the original instruction.",
            })}\n`,
          );
        } else {
          clearTimeout(timer);
          finish(0);
        }
      }
      if (event.type === "response" && event.id === "p1" && event.success === false) {
        clearTimeout(timer);
        finish(1);
      }
    }
  });
  child.on("error", () => finish(1));
  child.on("exit", (code) => {
    if (!settled) {
      clearTimeout(timer);
      finish(code === 0 ? 0 : 1);
    }
  });
  child.stdin.write(`${JSON.stringify({ id: "p1", type: "prompt", message: prompt })}\n`);
}

void main();

/**
 * Extract redacted OmO tool-result fixtures from persisted session JSONL files.
 *
 * Usage:
 *   npx tsx contrib/omo-fixtures.ts
 *
 * Environment:
 *   PI_CODING_AGENT_DIR      OmO agent root (default: ~/.omo/agent)
 *   OMO_FIXTURES_OUTPUT_DIR  destination directory (default: test/fixtures/omo-tools)
 */

import { createReadStream, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".omo", "agent");
const SESSIONS_DIR = join(AGENT_DIR, "sessions");
const OUTPUT_DIR = process.env.OMO_FIXTURES_OUTPUT_DIR || join(process.cwd(), "test", "fixtures", "omo-tools");
const SECRET_KEY = /key|token|secret|password|auth|cookie/i;
const FORBIDDEN = /sk-[A-Za-z0-9]{10,}|gh[pousr]_[A-Za-z0-9]{20,}/;
const PRIVATE_KEY = "BEGIN" + " PRIVATE KEY";

interface ToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

interface ToolResult {
  toolCallId: string;
  toolName: string;
  content: unknown;
  details: unknown;
  isError: boolean;
}

interface Sample {
  arguments: unknown;
  content: unknown;
  details: unknown;
  isError: boolean;
}

interface ToolFixture {
  tool: string;
  samples: Sample[];
}

interface TodoFixture {
  customType: "senpi.todo-state";
  data: unknown;
}

function sessionFiles(): string[] {
  if (!existsSync(SESSIONS_DIR)) return [];
  return readdirSync(SESSIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const dir = join(SESSIONS_DIR, entry.name);
      return readdirSync(dir, { withFileTypes: true })
        .filter((file) => file.isFile() && file.name.endsWith(".jsonl"))
        .map((file) => join(dir, file.name));
    })
    .sort();
}

function containsForbidden(value: unknown): boolean {
  if (typeof value === "string") return value.includes(PRIVATE_KEY) || FORBIDDEN.test(value);
  if (Array.isArray(value)) return value.some(containsForbidden);
  if (value && typeof value === "object") return Object.values(value).some(containsForbidden);
  return false;
}

function redact(value: unknown, key?: string): unknown {
  if (key && SECRET_KEY.test(key)) return undefined;
  if (typeof value === "string") return value.length > 400 ? `${value.slice(0, 400)}…` : value;
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

function signature(value: unknown): string {
  return JSON.stringify(value);
}

function addSample(byTool: Map<string, Sample[]>, name: string, sample: Sample): void {
  const samples = byTool.get(name) ?? [];
  const sampleSignature = signature(sample.arguments);
  if (samples.some((existing) => signature(existing.arguments) === sampleSignature) || samples.length >= 3) return;
  samples.push(sample);
  byTool.set(name, samples);
}

async function scanFile(file: string, byTool: Map<string, Sample[]>, todos: TodoFixture[]): Promise<void> {
  const calls = new Map<string, ToolCall>();
  const input = createReadStream(file, "utf8");
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    if (record.type === "custom" && record.customType === "senpi.todo-state" && todos.length < 3 && !containsForbidden(record.data)) {
      todos.push({ customType: "senpi.todo-state", data: redact(record.data) });
      continue;
    }
    if (record.type !== "message" || !record.message || typeof record.message !== "object") continue;
    const message = record.message as Record<string, unknown>;
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (!block || typeof block !== "object") continue;
        const candidate = block as Record<string, unknown>;
        if (
          candidate.type === "toolCall" &&
          typeof candidate.id === "string" &&
          typeof candidate.name === "string" &&
          "arguments" in candidate
        ) {
          calls.set(candidate.id, { id: candidate.id, name: candidate.name, arguments: candidate.arguments });
        }
      }
      continue;
    }
    if (message.role !== "toolResult" || typeof message.toolCallId !== "string" || typeof message.toolName !== "string") continue;
    const result = message as unknown as ToolResult;
    const call = calls.get(result.toolCallId);
    if (!call || containsForbidden(call.arguments) || containsForbidden(result.content) || containsForbidden(result.details)) continue;
    addSample(byTool, call.name, {
      arguments: redact(call.arguments) ?? null,
      content: redact(result.content) ?? null,
      details: redact(result.details) ?? null,
      isError: result.isError === true,
    });
  }
}

async function main(): Promise<void> {
  const byTool = new Map<string, Sample[]>();
  const todos: TodoFixture[] = [];
  const files = sessionFiles();
  for (const file of files) await scanFile(file, byTool, todos);

  if (byTool.size === 0 && todos.length === 0) {
    console.log(`No OmO fixtures found under ${SESSIONS_DIR}.`);
    return;
  }

  rmSync(OUTPUT_DIR, { recursive: true, force: true });
  mkdirSync(OUTPUT_DIR, { recursive: true });
  for (const [tool, samples] of [...byTool.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    writeFileSync(join(OUTPUT_DIR, `${tool}.json`), `${JSON.stringify({ tool, samples } satisfies ToolFixture, null, 2)}\n`);
  }
  if (todos.length > 0) {
    writeFileSync(join(OUTPUT_DIR, "todo-state.json"), `${JSON.stringify({ entries: todos }, null, 2)}\n`);
  }
  console.log(`Wrote ${byTool.size} tool fixture files and ${todos.length} todo-state entries to ${dirname(OUTPUT_DIR)}.`);
  console.log(`Tools: ${[...byTool.keys()].sort().join(", ")}`);
}

void main();

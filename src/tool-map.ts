import type { OCToolPart } from "./types.js";

/** OmO arguments translated to OpenChamber's renderer contracts. */
export interface MappedTool {
  tool: string;
  input: Record<string, unknown>;
  title: string;
  metadata?: Record<string, unknown>;
  output?: string;
}

export interface ToolResult {
  content?: unknown;
  details?: unknown;
  isError?: boolean;
}

export type ToolMapper = (args: Record<string, unknown>, result?: ToolResult) => MappedTool;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function generic(tool: string, input: Record<string, unknown>): MappedTool {
  const hint = [input.summary, input.description, input.query, input.url, input.path, input.command]
    .find((value): value is string => typeof value === "string" && value !== "");
  return { tool, input, title: (hint ?? tool).slice(0, 60) };
}

/** Mutable registry: todos 6/7 can assign handlers for `todo` and `task`. */
export const toolMappers: Record<string, ToolMapper> = {
  read: (args) => typeof args.path === "string"
    ? { tool: "read", input: { filePath: args.path, offset: args.offset, limit: args.limit }, title: args.path }
    : generic("read", args),
  write: (args) => typeof args.path === "string" && typeof args.content === "string"
    ? { tool: "write", input: { filePath: args.path, content: args.content }, title: args.path }
    : generic("write", args),
  edit: (args) => {
    if (typeof args.path !== "string" || !Array.isArray(args.edits) || args.edits.length === 0 ||
      !args.edits.every((edit) => record(edit) && typeof edit.oldText === "string" && typeof edit.newText === "string")) {
      return generic("edit", args);
    }
    const edits = args.edits.map((edit: Record<string, unknown>) => ({
      filePath: args.path, oldString: edit.oldText, newString: edit.newText,
    }));
    const first = edits[0];
    return {
      tool: edits.length === 1 ? "edit" : "multiedit",
      input: edits.length === 1 && first !== undefined ? first : { filePath: args.path, edits },
      title: args.path,
      metadata: { filediff: { file: args.path } },
    };
  },
  bash: (args) => typeof args.command === "string"
    ? { tool: "bash", input: { command: args.command, description: args.description }, title: args.command.slice(0, 60) }
    : generic("bash", args),
  eval: (args) => typeof args.code === "string"
    ? { tool: "eval", input: { language: args.language, code: args.code, description: args.summary }, title: typeof args.summary === "string" ? args.summary : "eval" }
    : generic("eval", args),
  ask_user_question: (args) => {
    if (!Array.isArray(args.questions) || !args.questions.every(record)) return generic("ask_user_question", args);
    const questions = args.questions.map((question) => ({
      question: question.question, header: question.header, options: question.options, multiple: question.multiSelect,
    }));
    return { tool: "question", input: { questions }, title: `Asked ${questions.length} questions` };
  },
  task: (args) => {
    const input = {
      description: args.task_summary ?? args.name ?? args.description,
      prompt: args.prompt,
      subagent_type: args.subagent_type ?? args.category,
    };
    return { tool: "task", input, title: typeof input.description === "string" ? input.description : "task" };
  },
};

/** Text blocks only; images and structured details are not tool output text. */
export function resultText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content.filter(record).filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text).join("");
}

/** Only edit cards need patch metadata; write cards already preview input.content. */
export function resultMetadata(tool: string, result: ToolResult): Record<string, unknown> {
  if (tool !== "edit" && tool !== "multiedit") return {};
  const details = record(result.details) ? result.details : {};
  return {
    ...(typeof details.patch === "string" ? { patch: details.patch } : {}),
    ...(typeof details.diff === "string" ? { diff: details.diff } : {}),
  };
}

export function mapTool(omoName: string, args: unknown, result?: ToolResult): MappedTool {
  const input = record(args) ? args : {};
  const handler = Object.hasOwn(toolMappers, omoName) ? toolMappers[omoName] : undefined;
  const mapped = handler !== undefined ? handler(input, result) : generic(omoName, input);
  if (result === undefined) return mapped;
  const metadata = { ...mapped.metadata, ...resultMetadata(mapped.tool, result) };
  return {
    ...mapped, output: mapped.output ?? resultText(result.content),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}

/** JSON first, then the literal-only Python repr used by older session files.
 * Never execute provider content; invalid or incomplete literals are skipped.
 */
function providerRaw(value: unknown): Record<string, unknown> | undefined {
  if (record(value)) return value;
  // Provider raw strings are display data, not an unbounded parser workload.
  if (typeof value !== "string" || value.length > 1024 * 1024) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    // Scan once from left to right. An unterminated string never causes a
    // retry at every escaped quote, unlike an unanchored string regex.
    const tokens: string[] = [];
    const simple: Record<string, string> = {
      a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\x0b",
      "\\": "\\", "'": "'", '"': '"',
    };
    let cursor = 0;
    while (cursor < value.length) {
      const char = value[cursor++];
      if (char === "'" || char === '"') {
        let decoded = "";
        let closed = false;
        while (cursor < value.length) {
          const next = value[cursor++];
          if (next === char) { closed = true; break; }
          if (next !== "\\") {
            if (next === "\n" || next === "\r") return undefined;
            decoded += next;
            continue;
          }
          const escape = value[cursor++];
          if (escape === undefined) return undefined;
          if (Object.hasOwn(simple, escape)) {
            decoded += simple[escape];
          } else if (escape === "x" || escape === "u" || escape === "U") {
            const length = escape === "x" ? 2 : escape === "u" ? 4 : 8;
            const hex = value.slice(cursor, cursor + length);
            if (hex.length !== length || !/^[0-9a-fA-F]+$/.test(hex)) return undefined;
            const code = Number.parseInt(hex, 16);
            if (code > 0x10ffff) return undefined;
            decoded += String.fromCodePoint(code);
            cursor += length;
          } else if (/[0-7]/.test(escape)) {
            let octal = escape;
            while (octal.length < 3 && cursor < value.length && /[0-7]/.test(value[cursor] ?? "")) {
              octal += value[cursor++];
            }
            decoded += String.fromCodePoint(Number.parseInt(octal, 8));
          } else if (escape === "\n") {
            // Python backslash-newline continuation contributes no character.
          } else if (escape === "\r") {
            if (value[cursor] === "\n") cursor++;
          } else {
            // Python preserves unrecognized escape sequences verbatim.
            decoded += `\\${escape}`;
          }
        }
        if (!closed) return undefined;
        tokens.push(JSON.stringify(decoded));
      } else if (char !== undefined && /[A-Za-z_]/.test(char)) {
        const start = cursor - 1;
        while (cursor < value.length && /[A-Za-z_]/.test(value[cursor] ?? "")) cursor++;
        const token = value.slice(start, cursor);
        tokens.push(token === "None" ? "null" : token === "True" ? "true" : token === "False" ? "false" : token);
      } else if (char !== undefined) {
        tokens.push(char);
      }
    }
    try {
      parsed = JSON.parse(tokens.join(""));
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return undefined;
    }
  }
  return record(parsed) ? parsed : undefined;
}

/** One card at each call's original block index; result blocks are not cards.
 * Shared by RPC snapshots and history so ids and renderer state survive reloads.
 */
export function providerToolParts(
  content: unknown, sessionID: string, messageID: string, timestamp: number,
): Map<number, OCToolPart> {
  const parts = new Map<number, OCToolPart>();
  if (!Array.isArray(content)) return parts;
  const blocks = content.map((block: unknown) => record(block) && block.type === "providerNative"
    ? { subtype: block.subtype, raw: providerRaw(block.raw) } : undefined);
  blocks.forEach((block, index) => {
    const raw = block?.raw;
    if (raw === undefined || typeof raw.id !== "string" || raw.id === "") return;
    let tool: string;
    let input: Record<string, unknown>;
    let title: string;
    let output = "";
    let error: string | undefined;
    let complete = false;
    switch (block?.subtype) {
      case "server_tool_use": {
        if (typeof raw.name !== "string") return;
        input = record(raw.input) ? raw.input : {};
        title = typeof input.query === "string" ? input.query : raw.name;
        tool = raw.name === "web_search" ? "websearch" : raw.name;
        break;
      }
      case "web_search_call": {
        const action = record(raw.action) ? raw.action : {};
        const queries = Array.isArray(action.queries) ? action.queries.filter((q): q is string => typeof q === "string") : [];
        title = queries.length > 0 ? queries.join("\n") : typeof action.query === "string" ? action.query : "";
        tool = action.type === "open_page" ? "webfetch" : "websearch";
        input = tool === "webfetch" ? { url: action.url } : { query: title };
        if (tool === "webfetch" && typeof action.url === "string") title = action.url;
        complete ||= raw.status === "completed";
        if (raw.status === "failed" || raw.status === "error" || raw.status === "cancelled") {
          error = typeof raw.error === "string" ? raw.error : `Web search ${raw.status}`;
        }
        break;
      }
      default:
        return;
    }
    const time = { start: timestamp, end: timestamp };
    parts.set(index, {
      id: `prt_${sessionID}_provider_${raw.id}`, sessionID, messageID,
      type: "tool", callID: raw.id, tool,
      state: error !== undefined
        ? { status: "error", input, error, time }
        : complete
          ? { status: "completed", input, title, output, metadata: {}, time }
          : { status: "running", input, title, time: { start: timestamp } },
    });
  });
  applyProviderToolResults(content, parts.values(), timestamp);
  return parts;
}

/** OmO can append a server result in a later assistant message, not just the
 * call's message. Mutate the original card so ownership and id stay intact.
 */
export function applyProviderToolResults(content: unknown, parts: Iterable<OCToolPart>, timestamp: number): OCToolPart[] {
  const updated: OCToolPart[] = [];
  if (!Array.isArray(content)) return updated;
  const byCallID = new Map([...parts].map((part) => [part.callID, part]));
  for (const block of content) {
    if (!record(block) || block.type !== "providerNative" ||
      (block.subtype !== "web_search_tool_result" && block.subtype !== "tool_search_tool_result")) continue;
    const raw = providerRaw(block.raw);
    if (typeof raw?.tool_use_id !== "string") continue;
    const part = byCallID.get(raw.tool_use_id);
    if (part === undefined) continue;
    const result = raw.content;
    let output = "";
    let error: string | undefined;
    if (Array.isArray(result)) {
      output = result.filter(record)
        .filter((item) => typeof item.title === "string" && typeof item.url === "string")
        .map((item) => `${item.title} - ${item.url}`).join("\n");
    } else if (record(result)) {
      if (typeof result.type === "string" && result.type.endsWith("_error")) {
        error = typeof result.error_code === "string" ? result.error_code : "Server tool failed";
      } else if (Array.isArray(result.tool_references)) {
        output = result.tool_references.filter(record).map((item) => item.tool_name)
          .filter((name): name is string => typeof name === "string").join("\n");
      }
    }
    const state = part.state;
    const time = { start: state.status === "pending" ? timestamp : state.time.start, end: timestamp };
    part.state = error !== undefined
      ? { status: "error", input: state.input, error, time }
      : {
          status: "completed", input: state.input, output, metadata: {},
          title: state.status === "running" || state.status === "completed" ? state.title ?? part.tool : part.tool,
          time,
        };
    updated.push(part);
  }
  return updated;
}

/** Only an actual result (or a self-contained provider status) means success. */
export function finishProviderToolParts(parts: Iterable<OCToolPart>, timestamp: number, error = "No result"): OCToolPart[] {
  const updated: OCToolPart[] = [];
  for (const part of parts) {
    if (!part.id.includes("_provider_") || (part.state.status !== "pending" && part.state.status !== "running")) continue;
    const start = part.state.status === "pending" ? timestamp : part.state.time.start;
    part.state = { status: "error", input: part.state.input, error, time: { start, end: timestamp } };
    updated.push(part);
  }
  return updated;
}

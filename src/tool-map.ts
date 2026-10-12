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

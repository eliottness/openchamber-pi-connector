import { randomUUID } from "node:crypto";
import { PiRpcClient } from "./pi-rpc.js";
import { getAgentName } from "./agent-name.js";
import type { ManagedSession, SessionManager } from "./sessions.js";
import type { OCAssistantMessage, OCEvent, OCMessageWithParts, OCToolPart, OCTextPart } from "./types.js";

export type CommandDescriptor = { name: string; description: string; template: "" };
export type SlashCommandInput = { command: string; arguments: string };
export type ShellResult = { output: string; exitCode: number | null; cancelled: boolean; truncated: boolean };
export type ShellMessage = OCMessageWithParts & { info: OCAssistantMessage; parts: [OCToolPart] };

export type ShareNoticeMessage = OCMessageWithParts & { info: OCAssistantMessage; parts: [OCTextPart] };

export type ShellExecution =
  | { kind: "completed"; message: ShellMessage }
  | { kind: "error"; message: string };

export interface ShellCommandContext {
  sessions: SessionManager;
  session: ManagedSession;
  command: string;
  emit: (directory: string, event: OCEvent) => void;
}

export interface ShareNoticeContext {
  sessions: SessionManager;
  session: ManagedSession;
  emit: (directory: string, event: OCEvent) => void;
}

export type CompactResult = { kind: "compacted" } | { kind: "error"; message: string };

// OpenChamber drops rejected Share actions, so emit a visible session notice too.
export const unsupportedShare = {
  name: "BadRequestError",
  data: { message: "Sharing is not available with OmO" },
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function id(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function shellTitle(command: string): string {
  const short = command.length > 60 ? `${command.slice(0, 57)}…` : command;
  return `bash: ${short}`;
}

function assistantMessage(session: ManagedSession): OCAssistantMessage {
  const created = Date.now();
  const parentID = [...(session.messages ?? [])].reverse().find((message) => message.info.role === "user")?.info.id ?? "";
  return {
    id: id("msg"),
    sessionID: session.info.id,
    role: "assistant",
    time: { created },
    parentID,
    modelID: session.model?.modelID ?? "unknown",
    providerID: session.model?.providerID ?? "unknown",
    mode: getAgentName(),
    path: { cwd: session.info.directory, root: session.info.directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
}

function shellEvent(context: ShellCommandContext, event: OCEvent): void {
  context.emit(context.session.info.directory, event);
}

function setShellStatus(context: ShellCommandContext, type: "busy" | "idle"): void {
  const { session, sessions } = context;
  session.status = { type };
  sessions.lifecycle.touch(session);
  shellEvent(context, {
    type: "session.status",
    properties: { sessionID: session.info.id, status: session.status },
  });
  if (type === "idle") {
    shellEvent(context, { type: "session.idle", properties: { sessionID: session.info.id } });
  }
}

function emitShellMessage(context: ShellCommandContext, message: ShellMessage): void {
  shellEvent(context, { type: "message.updated", properties: { info: message.info } });
  shellEvent(context, { type: "message.part.updated", properties: { part: message.parts[0] } });
}

function mapCommands(data: unknown): CommandDescriptor[] {
  if (!isRecord(data) || !Array.isArray(data.commands)) {
    throw new Error("OmO get_commands returned an invalid command list");
  }
  return data.commands.map((command: unknown) => {
    if (!isRecord(command) || typeof command.name !== "string") {
      throw new Error("OmO get_commands returned a command without a name");
    }
    return {
      name: command.name,
      description: typeof command.description === "string" ? command.description : "",
      template: "",
    };
  });
}

export async function getCommands(directory: string): Promise<CommandDescriptor[]> {
  const pi = new PiRpcClient({ cwd: directory, args: ["--no-session"] });
  try {
    const response = await pi.command<unknown>({ type: "get_commands" });
    if (!response.success) throw new Error(response.error ?? "OmO get_commands failed");
    return mapCommands(response.data);
  } finally {
    await pi.dispose();
  }
}

export function parseSlashCommand(value: unknown): SlashCommandInput | undefined {
  if (!isRecord(value) || typeof value.command !== "string" || value.command.trim() === "") return undefined;
  if (typeof value.arguments !== "string") return undefined;
  return { command: value.command, arguments: value.arguments };
}

export function slashCommandPrompt(input: SlashCommandInput): string {
  return input.arguments === "" ? `/${input.command}` : `/${input.command} ${input.arguments}`;
}

export async function runSlashCommand(
  sessions: SessionManager,
  sessionId: string,
  input: SlashCommandInput,
): Promise<OCMessageWithParts | undefined> {
  await sessions.prompt(sessionId, slashCommandPrompt(input));
  await sessions.reloadMessages(sessionId);
  const messages = sessions.messages(sessionId) ?? [];
  return [...messages].reverse().find((message) => message.info.role === "assistant") ?? messages[messages.length - 1];
}

export function parseShellCommand(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.command !== "string" || value.command.trim() === "") return undefined;
  return value.command;
}

export function parseShellResult(value: unknown): ShellResult {
  if (
    !isRecord(value) ||
    typeof value.output !== "string" ||
    (typeof value.exitCode !== "number" && value.exitCode !== null) ||
    typeof value.cancelled !== "boolean" ||
    typeof value.truncated !== "boolean"
  ) {
    throw new Error("OmO bash returned an invalid result");
  }
  return {
    output: value.output,
    exitCode: value.exitCode,
    cancelled: value.cancelled,
    truncated: value.truncated,
  };
}

export function createShellMessage(session: ManagedSession, command: string): ShellMessage {
  const info = assistantMessage(session);
  const created = info.time.created;
  const part: OCToolPart = {
    id: id("prt"),
    sessionID: session.info.id,
    messageID: info.id,
    type: "tool",
    callID: id("call"),
    tool: "bash",
    state: {
      status: "running",
      input: { command, description: command },
      title: shellTitle(command),
      metadata: {},
      time: { start: created },
    },
  };
  return { info, parts: [part] };
}

export function announceSessionError(context: ShareNoticeContext, errorName: string, messageText: string): void {
  const { session, sessions, emit } = context;
  const messages = sessions.messages(session.info.id);
  if (!messages) return;
  const info = assistantMessage(session);
  const created = info.time.created;
  info.time.completed = created;
  const part: OCTextPart = {
    id: id("prt"),
    sessionID: session.info.id,
    messageID: info.id,
    type: "text",
    text: messageText,
    time: { start: created, end: created },
  };
  const message: ShareNoticeMessage = { info, parts: [part] };
  messages.push(message);
  emit(session.info.directory, { type: "message.updated", properties: { info } });
  emit(session.info.directory, { type: "message.part.updated", properties: { part } });
  emit(session.info.directory, {
    type: "session.error",
    properties: { sessionID: session.info.id, error: { name: errorName, data: { message: messageText } } },
  });
}

export function completeShellMessage(message: ShellMessage, command: string, result: ShellResult): void {
  const [part] = message.parts;
  const started = part.state.status === "pending" ? Date.now() : part.state.time.start;
  part.state = {
    status: "completed",
    input: { command, description: command },
    output: result.output,
    title: shellTitle(command),
    metadata: { exitCode: result.exitCode, cancelled: result.cancelled, truncated: result.truncated },
    time: { start: started, end: Date.now() },
  };
  message.info.time.completed = Date.now();
}

export function failShellMessage(message: ShellMessage, command: string, error: string): void {
  const [part] = message.parts;
  const started = part.state.status === "pending" ? Date.now() : part.state.time.start;
  part.state = {
    status: "error",
    input: { command, description: command },
    error,
    time: { start: started, end: Date.now() },
  };
  message.info.time.completed = Date.now();
}

export async function compactSession(sessions: SessionManager, sessionId: string): Promise<CompactResult> {
  const response = await sessions.sessionRpc(sessionId, { type: "compact" });
  if (!response.success) return { kind: "error", message: response.error ?? "OmO compact failed" };
  return { kind: "compacted" };
}

export async function runShellCommand(context: ShellCommandContext): Promise<ShellExecution> {
  const { session, sessions, command } = context;
  const messages = sessions.messages(session.info.id) ?? [];
  const message = createShellMessage(session, command);
  messages.push(message);
  setShellStatus(context, "busy");
  emitShellMessage(context, message);
  try {
    const response = await sessions.sessionRpc<unknown>(session.info.id, { type: "bash", command });
    if (!response.success) {
      const error = response.error ?? "OmO bash failed";
      failShellMessage(message, command, error);
      emitShellMessage(context, message);
      return { kind: "error", message: error };
    }
    completeShellMessage(message, command, parseShellResult(response.data));
    emitShellMessage(context, message);
    return { kind: "completed", message };
  } catch (error) {
    failShellMessage(message, command, error instanceof Error ? error.message : String(error));
    emitShellMessage(context, message);
    throw error;
  } finally {
    setShellStatus(context, "idle");
  }
}

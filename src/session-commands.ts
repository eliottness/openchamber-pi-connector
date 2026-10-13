import { randomUUID } from "node:crypto";
import { PiRpcClient } from "./pi-rpc.js";
import { getAgentName } from "./agent-name.js";
import type { ManagedSession, SessionManager } from "./sessions.js";
import type { OCAssistantMessage, OCEvent, OCMessageWithParts, OCToolPart, OCTextPart, OCUserMessage } from "./types.js";

export type CommandDescriptor = { name: string; description: string; template: "" };
export type SlashCommandInput = { command: string; arguments: string };
export type ShellResult = { output: string; exitCode: number | null; cancelled: boolean; truncated: boolean };
export type ShellMessage = OCMessageWithParts & { info: OCAssistantMessage; parts: [OCToolPart] };
export type ShellUserMessage = OCMessageWithParts & { info: OCUserMessage; parts: [OCTextPart] };

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

export function shellTitle(command: string): string {
  const short = command.length > 60 ? `${command.slice(0, 57)}…` : command;
  return `bash: ${short}`;
}

function assistantMessage(session: ManagedSession): OCAssistantMessage {
  const created = Date.now();
  const messages = session.messages ?? [];
  const boundary = messages.findIndex((message) => message.info.id === session.tree.revert?.messageID);
  const visible = boundary < 0 ? messages : messages.slice(0, boundary);
  const parentID = [...visible].reverse().find((message) => message.info.role === "user")?.info.id ?? "";
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
    (typeof value.exitCode !== "number" && value.exitCode !== null && !(value.cancelled === true && value.exitCode === undefined)) ||
    typeof value.cancelled !== "boolean" ||
    typeof value.truncated !== "boolean"
  ) {
    throw new Error("OmO bash returned an invalid result");
  }
  return {
    output: value.output,
    exitCode: typeof value.exitCode === "number" ? value.exitCode : null,
    cancelled: value.cancelled,
    truncated: value.truncated,
  };
}

export function createShellMessage(session: ManagedSession, command: string): ShellMessage {
  const info = assistantMessage(session);
  info.parentID = `${info.id}u`;
  info.id = `${info.id}z`;
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

export function shellUserMessage(message: ShellMessage): ShellUserMessage {
  const { info } = message;
  return {
    info: {
      id: info.parentID, sessionID: info.sessionID, role: "user", time: { created: info.time.created },
      agent: info.mode, model: { providerID: info.providerID, modelID: info.modelID },
    },
    parts: [{
      id: `${message.parts[0].id}u`, sessionID: info.sessionID, messageID: info.parentID,
      type: "text", text: "The following tool was executed by the user", synthetic: true,
      time: { start: info.time.created, end: info.time.created },
    }],
  };
}

export function announceSessionNotice(context: ShareNoticeContext, messageText: string, error?: OCAssistantMessage["error"]): void {
  const { session, sessions, emit } = context;
  if (!sessions.messages(session.info.id)) return;
  const info = assistantMessage(session);
  const created = info.time.created;
  info.time.completed = created;
  if (error) info.error = error;
  const part: OCTextPart = {
    id: id("prt"),
    sessionID: session.info.id,
    messageID: info.id,
    type: "text",
    text: messageText,
    time: { start: created, end: created },
  };
  const message: ShareNoticeMessage = { info, parts: [part] };
  sessions.appendMessage(session.info.id, message);
  emit(session.info.directory, { type: "message.updated", properties: { info } });
  emit(session.info.directory, { type: "message.part.updated", properties: { part } });
}

export function announceSessionError(context: ShareNoticeContext, errorName: string, messageText: string): void {
  announceSessionNotice(context, messageText, { name: errorName, data: { message: messageText } });
  context.emit(context.session.info.directory, {
    type: "session.error",
    properties: { sessionID: context.session.info.id, error: { name: errorName, data: { message: messageText } } },
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

export function failShellMessage(message: ShellMessage, command: string, error: string, metadata?: Record<string, unknown>): void {
  const [part] = message.parts;
  const started = part.state.status === "pending" ? Date.now() : part.state.time.start;
  part.state = {
    status: "error",
    input: { command, description: command },
    error,
    ...(metadata !== undefined ? { metadata } : {}),
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
  sessions.messages(session.info.id);
  const message = createShellMessage(session, command);
  const user = shellUserMessage(message);
  const dispatch = session.tree.shellDispatch ??= {};
  dispatch[message.info.id] = false;
  const afterEntryId = session.tree.leafId ?? null;
  const controller = new AbortController();
  let interrupted = false;
  session.cancelShell = (byRestart = false) => {
    interrupted = byRestart;
    delete session.cancelShell;
    // Agent abort does not stop user bash. Dispatch the dedicated RPC first,
    // then release our waiter; a correlated late response is discarded.
    if (dispatch[message.info.id]) session.pi?.notify({ type: "abort_bash" });
    controller.abort();
  };
  sessions.appendMessage(session.info.id, user);
  sessions.appendMessage(session.info.id, message);
  setShellStatus(context, "busy");
  shellEvent(context, { type: "message.updated", properties: { info: user.info } });
  shellEvent(context, { type: "message.part.updated", properties: { part: user.parts[0] } });
  emitShellMessage(context, message);
  try {
    sessions.update(session.info.id, {});
    const response = await sessions.sessionRpc<unknown>(session.info.id, { type: "bash", command }, controller.signal, () => {
      dispatch[message.info.id] = true;
      // Only actual dispatch admissions are durable; queued attempts stay in the live cache.
      (session.tree.localShellTurns ??= []).push({ afterEntryId, messages: [user, message] });
      // A native result can land beyond the last synchronized leaf.
      if (!session.tree.revert) delete session.tree.leafId;
      sessions.update(session.info.id, {});
    });
    if (controller.signal.aborted) throw controller.signal.reason;
    if (!response.success) {
      const error = response.error ?? "OmO bash failed";
      failShellMessage(message, command, error);
      emitShellMessage(context, message);
      return { kind: "error", message: error };
    }
    const result = parseShellResult(response.data);
    if (result.cancelled) {
      failShellMessage(message, command, "Command cancelled", { cancelled: true, exitCode: result.exitCode });
    } else {
      completeShellMessage(message, command, result);
    }
    emitShellMessage(context, message);
    return { kind: "completed", message };
  } catch (error) {
    if (controller.signal.aborted) {
      failShellMessage(message, command, interrupted ? "Interrupted by restart" : "Command cancelled",
        interrupted ? { interrupted: true } : { cancelled: true });
      emitShellMessage(context, message);
      return { kind: "completed", message };
    }
    failShellMessage(message, command, error instanceof Error ? error.message : String(error));
    emitShellMessage(context, message);
    throw error;
  } finally {
    delete session.cancelShell;
    setShellStatus(context, "idle");
    sessions.update(session.info.id, {});
  }
}

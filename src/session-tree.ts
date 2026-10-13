import type { PiRpcClient } from "./pi-rpc.js";
import { readFileSync } from "node:fs";
import type { ManagedSession } from "./sessions.js";
import type { OCMessageWithParts } from "./types.js";

export interface SessionTreeState {
  messageEntries: Record<string, string>;
  /** Actual transport dispatch, not inferred from a card's terminal state. */
  shellDispatch?: Record<string, boolean>;
  /** Identity-only dispatched admissions; never rendered without a native entry. */
  localShellTurns?: Array<{ afterEntryId: string | null; messages: [OCMessageWithParts, OCMessageWithParts] }>;
  leafId?: string | null;
  revert?: { messageID: string; previousLeafId: string | null; targetId: string | null };
}

export interface TreeEntry {
  type: string;
  id: string;
  parentId: string | null;
  message?: {
    role: string;
    content?: Array<{ type: string; text?: string }>;
    command?: string;
    output?: string;
    exitCode?: number | null;
    cancelled?: boolean;
  };
}

export interface Entries {
  entries: TreeEntry[];
  leafId: string | null;
}

export class SessionTreeError extends Error {}

export function durableShellTree(tree: SessionTreeState): SessionTreeState {
  return {
    ...tree,
    shellDispatch: Object.fromEntries(Object.entries(tree.shellDispatch ?? {}).filter(([, dispatched]) => dispatched)),
    localShellTurns: (tree.localShellTurns ?? []).filter((turn) => tree.shellDispatch?.[turn.messages[1].info.id] === true),
  };
}

export async function getEntries(pi: PiRpcClient, signal?: AbortSignal): Promise<Entries> {
  const response = await pi.command<Entries>({ type: "get_entries" }, 60_000, signal);
  if (!response.success || !response.data) throw new SessionTreeError(response.error ?? "OmO returned no session entries");
  return response.data;
}

/** agent_end runs after message persistence; no async lease or timing race. */
export function recordTurn(s: ManagedSession): void {
  if (!s.piPath) return;
  const entries: TreeEntry[] = readFileSync(s.piPath, "utf8").trim().split("\n")
    .map((line) => JSON.parse(line) as TreeEntry).filter((entry) => entry.type !== "session");
  bindMessageEntries(s, { entries, leafId: entries.at(-1)?.id ?? null });
}

export function branchEntries(tree: Entries, leafId = tree.leafId): TreeEntry[] {
  const byId = new Map(tree.entries.map((entry) => [entry.id, entry]));
  const branch: TreeEntry[] = [];
  const seen = new Set<string>();
  for (let entry = leafId === null ? undefined : byId.get(leafId); entry && !seen.has(entry.id); ) {
    seen.add(entry.id);
    branch.push(entry);
    entry = entry.parentId === null ? undefined : byId.get(entry.parentId);
  }
  return branch.reverse();
}

/** Live ids belong to the UI; restored ids belong to JSONL offsets. Save both. */
export function bindMessageEntries(s: ManagedSession, tree: Entries): void {
  const branch = branchEntries(tree, s.tree.revert ? s.tree.revert.previousLeafId : tree.leafId);
  const positions = new Map(branch.map((entry, index) => [entry.id, index]));
  s.tree.localShellTurns = (s.tree.localShellTurns ?? []).filter((turn) => {
    if (turn.afterEntryId === null || positions.has(turn.afterEntryId)) return true;
    const ids = new Set(turn.messages.map((message) => message.info.id));
    s.messages = s.messages?.filter((message) => !ids.has(message.info.id));
    for (const message of turn.messages) s.localMessageIds?.delete(message.info.id);
    if (s.tree.shellDispatch) delete s.tree.shellDispatch[turn.messages[1].info.id];
    return false;
  });
  const entries = branch.filter((entry) => entry.type === "message" && (entry.message?.role === "user" || entry.message?.role === "assistant" || entry.message?.role === "bashExecution"));
  const visible = s.messages ?? [];
  const visibleIds = new Set(visible.map((message) => message.info.id));
  const candidates = s.tree.localShellTurns.flatMap((turn) => turn.messages).filter((message) => !visibleIds.has(message.info.id));
  for (const message of candidates) (s.localMessageIds ??= new Set()).add(message.info.id);
  const messages = [...visible, ...candidates];
  let cursor = 0;
  for (const entry of entries) {
    const shell = entry.message?.role === "bashExecution";
    const known = messages.findIndex((message) => (!shell || message.info.role === "assistant") &&
      s.tree.messageEntries[message.info.id] === entry.id);
    if (known >= 0) {
      if (known < visible.length) cursor = known + 1;
      continue;
    }
    if (shell) {
      if (Object.values(s.tree.messageEntries).includes(entry.id)) continue;
      const index = messages.findIndex((message, i) => {
        if (i < cursor || message.info.role !== "assistant" ||
          s.tree.shellDispatch?.[message.info.id] !== true ||
          s.tree.messageEntries[message.info.id] !== undefined) return false;
        const parentEntry = s.tree.messageEntries[message.info.parentID];
        if (parentEntry !== undefined && parentEntry !== entry.id) return false;
        const attempt = s.tree.localShellTurns?.find((turn) => turn.messages[1].info.id === message.info.id);
        if (attempt?.afterEntryId !== undefined && attempt.afterEntryId !== null &&
          (!positions.has(attempt.afterEntryId) || (positions.get(attempt.afterEntryId) ?? 0) >= (positions.get(entry.id) ?? 0))) return false;
        const part = message.parts.find((part) => part.type === "tool" && part.tool === "bash" &&
          part.state.input.command === entry.message?.command);
        if (part?.type !== "tool" || part.state.status === "pending") return false;
        const state = part.state;
        if (state.status === "error" && state.metadata?.interrupted !== true &&
          (state.metadata?.cancelled !== true || entry.message?.cancelled !== true)) return false;
        if (state.status === "completed" && entry.message?.cancelled === true) return false;
        if (state.metadata?.cancelled !== undefined && state.metadata.cancelled !== (entry.message?.cancelled === true)) return false;
        if (entry.message?.exitCode !== undefined && state.metadata?.exitCode !== undefined &&
          state.metadata.exitCode !== entry.message.exitCode) return false;
        if (state.status === "completed" && entry.message?.output !== undefined && state.output !== entry.message.output) return false;
        return true;
      });
      const assistant = messages[index];
      if (assistant?.info.role === "assistant") {
        const parentID = assistant.info.parentID;
        const user = messages.find((message) => message.info.id === parentID && message.info.role === "user" &&
          message.parts.some((part) => part.type === "text" && part.synthetic));
        for (const message of user ? [user, assistant] : [assistant]) {
          s.tree.messageEntries[message.info.id] = entry.id;
          s.localMessageIds?.delete(message.info.id);
        }
        if (index < visible.length) cursor = index + 1;
      }
      continue;
    }
    const text = entry.message?.content?.filter((part) => part.type === "text").map((part) => part.text ?? "").join("");
    const index = messages.findIndex((message, i) => i >= cursor &&
      !s.localMessageIds?.has(message.info.id) &&
      s.tree.messageEntries[message.info.id] === undefined && message.info.role === entry.message?.role &&
      (message.info.role !== "user" || message.parts.filter((part) => part.type === "text").map((part) => part.text).join("") === text));
    const message = messages[index];
    if (message) {
      s.tree.messageEntries[message.info.id] = entry.id;
      cursor = index + 1;
    }
  }
  // Syncs/agent events preserve an active revert's navigation pin. Only
  // revert/unrevert select it explicitly; prompt clears the pin before branching.
  if (!s.tree.revert) s.tree.leafId = tree.leafId;
  s.tree.localShellTurns = s.tree.localShellTurns.filter((turn) => s.tree.messageEntries[turn.messages[1].info.id] === undefined);
}

export function entryForMessage(s: ManagedSession, tree: Entries, messageID: string): TreeEntry {
  const entryId = s.tree.messageEntries[messageID];
  const entry = tree.entries.find((candidate) => candidate.id === entryId);
  if (!entry || !s.messages?.some((message) => message.info.id === messageID)) {
    throw new SessionTreeError(`Unknown messageID: ${messageID}`);
  }
  return entry;
}

export async function forkConversation(s: ManagedSession, pi: PiRpcClient, tree: Entries, messageID?: string) {
  const entry = messageID === undefined ? branchEntries(tree).at(-1) : entryForMessage(s, tree, messageID);
  if (!entry) throw new SessionTreeError("Cannot fork an empty conversation");
  const shellUser = entry.message?.role === "bashExecution" && s.messages?.find((message) => message.info.id === messageID)?.info.role === "user";
  const forkEntryId = shellUser ? entry.parentId : entry.id;
  if (forkEntryId === null) throw new SessionTreeError("Cannot fork before a root shell entry");
  const response = await pi.command<{ cancelled?: boolean }>({
    type: "fork", entryId: forkEntryId, ...(messageID === undefined || entry.message?.role === "bashExecution" ? { position: "at" } : {}),
  });
  if (!response.success) throw new SessionTreeError(response.error ?? "OmO fork failed");
  if (response.data?.cancelled) throw new SessionTreeError("Conversation fork was cancelled");
  // Fork switches the process; detach it before any new-identity events arrive.
  s.pi = undefined;
  if (s.piPath && s.piSessionId) s.restored = { piPath: s.piPath, piSessionId: s.piSessionId };
  try {
    const state = await pi.command<{ sessionId: string; sessionFile?: string }>({ type: "get_state" });
    if (!state.success || !state.data?.sessionFile) {
      throw new SessionTreeError(state.error ?? "OmO fork did not return a session file");
    }
    return { sessionId: state.data.sessionId, sessionFile: state.data.sessionFile };
  } catch (error) {
    await pi.dispose();
    throw error;
  }
}

export async function revertConversation(s: ManagedSession, pi: PiRpcClient, tree: Entries, messageID: string): Promise<boolean> {
  const entry = entryForMessage(s, tree, messageID);
  if (s.messages?.find((message) => message.info.id === messageID)?.info.role !== "user") throw new SessionTreeError("Revert requires a user messageID");
  if (s.tree.revert?.messageID === messageID) return false;
  const previousLeafId = s.tree.revert ? s.tree.revert.previousLeafId : tree.leafId;
  const leafId = await navigate(pi, entry.parentId);
  s.tree.revert = { messageID, previousLeafId, targetId: entry.parentId };
  s.tree.leafId = leafId;
  s.info.revert = { messageID };
  s.info.time.updated = Date.now();
  return true;
}

export async function unrevertConversation(s: ManagedSession, pi: PiRpcClient): Promise<boolean> {
  if (!s.tree.revert) return false;
  s.tree.leafId = await navigate(pi, s.tree.revert.previousLeafId);
  delete s.tree.revert;
  delete s.info.revert;
  s.info.time.updated = Date.now();
  return true;
}

export async function navigate(pi: PiRpcClient, targetId: string | null, signal?: AbortSignal): Promise<string | null> {
  // The protocol cannot address null. Selecting a root user resets its leaf.
  if (targetId === null) {
    const tree = await getEntries(pi, signal);
    if (tree.leafId === null) return null;
    const root = tree.entries.find((entry) => entry.parentId === null && entry.message?.role === "user");
    if (!root) throw new SessionTreeError("Cannot locate the root conversation message");
    const response = await pi.command<{ cancelled?: boolean; leafId: string | null }>({ type: "navigate_tree", targetId: root.id }, 60_000, signal);
    if (!response.success || !response.data || response.data.cancelled) {
      throw new SessionTreeError(response.error ?? "Root conversation navigation was cancelled");
    }
    return response.data.leafId;
  }
  // Resume selects the exact parent, even when it is a user/custom message.
  const response = await pi.command<{ cancelled?: boolean; leafId: string | null }>({
    type: "navigate_tree", targetId, intent: "resume",
  }, 60_000, signal);
  if (!response.success || !response.data) throw new SessionTreeError(response.error ?? "OmO returned no navigation result");
  if (response.data.cancelled) throw new SessionTreeError("Conversation navigation was cancelled");
  return response.data.leafId;
}

export function revertNotice(s: ManagedSession): OCMessageWithParts | undefined {
  const revert = s.tree.revert;
  if (!revert) return undefined;
  const boundary = s.messages?.find((message) => message.info.id === revert.messageID);
  const boundaryIndex = s.messages?.findIndex((message) => message.info.id === revert.messageID) ?? 0;
  const parent = s.messages?.slice(0, boundaryIndex).reverse().find((message) => message.info.role === "user");
  const messageID = `msg_revert_${revert.messageID}`;
  const created = (boundary?.info.time.created ?? s.info.time.updated) - 1;
  return {
    info: {
      id: messageID, sessionID: s.info.id, role: "assistant", time: { created, completed: created },
      parentID: parent?.info.id ?? "", modelID: s.model?.modelID ?? "unknown", providerID: s.model?.providerID ?? "unknown",
      mode: "info", path: { cwd: s.info.directory, root: s.info.directory }, cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [{
      id: `prt_revert_${revert.messageID}`, sessionID: s.info.id, messageID, type: "text",
      text: "Conversation reverted. Files were not changed.",
    }],
  };
}

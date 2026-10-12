import { createHash } from "node:crypto";
import { toolMappers } from "./tool-map.js";
import type { OCToolPart } from "./types.js";

export interface Todo {
  readonly id: string;
  readonly content: string;
  readonly status: "pending" | "in_progress" | "completed" | "cancelled";
  readonly priority: "medium";
}

export interface TodoUpdated {
  type: "todo.updated";
  properties: { sessionID: string; todos: Todo[] };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function flattenTodos(sessionID: string, data: unknown): Todo[] {
  if (!record(data) || !Array.isArray(data.phases)) return [];
  const phases = data.phases.filter(record);
  return phases.flatMap((phase) => {
    if (typeof phase.name !== "string" || !Array.isArray(phase.tasks)) return [];
    return phase.tasks.filter(record).flatMap((task): Todo[] => {
      if (typeof task.content !== "string") return [];
      let status: Todo["status"];
      switch (task.status) {
        case "in_progress": status = "in_progress"; break;
        case "completed": status = "completed"; break;
        case "abandoned":
        case "dropped":
        case "cancelled": status = "cancelled"; break;
        default: status = "pending";
      }
      return [{
        id: createHash("md5").update(`${sessionID}|${phase.name}|${task.content}`).digest("hex").slice(0, 16),
        content: phases.length === 1 ? task.content : `${phase.name}: ${task.content}`,
        status,
        priority: "medium",
      }];
    });
  });
}

toolMappers.todo = (args) => ({
  tool: "todowrite",
  input: { todos: Array.isArray(args.todos) ? args.todos : [] },
  title: "Todos",
});

/** Per-session snapshots; each card retains the state produced by its own call. */
export class TodoBridge {
  todos: Todo[] = [];
  private awaitingState: OCToolPart[] = [];

  constructor(private readonly sessionID: string) {}

  track(part: OCToolPart, args: unknown): void {
    if (part.tool !== "todowrite") return;
    part.state.input = { todos: this.todos };
    if (!record(args) || args.op !== "view") this.awaitingState.push(part);
  }

  finish(part: OCToolPart, isError: boolean): void {
    if (isError) this.awaitingState = this.awaitingState.filter((candidate) => candidate !== part);
  }

  entry(entry: unknown, updatePart: (part: OCToolPart) => void = () => {}): TodoUpdated | undefined {
    if (!record(entry) || entry.type !== "custom" || entry.customType !== "senpi.todo-state") return undefined;
    this.todos = flattenTodos(this.sessionID, entry.data);
    const part = this.awaitingState.shift();
    if (part !== undefined) {
      part.state.input = { todos: this.todos };
      updatePart(part);
    }
    return { type: "todo.updated", properties: { sessionID: this.sessionID, todos: this.todos } };
  }

  restore(entries: readonly unknown[], parts: Map<string, OCToolPart>): void {
    for (const entry of entries) {
      if (!record(entry)) continue;
      const message = entry.message;
      if (record(message) && message.role === "assistant" && Array.isArray(message.content)) {
        for (const block of message.content) {
          if (!record(block) || block.type !== "toolCall" || typeof block.id !== "string") continue;
          const part = parts.get(block.id);
          if (part !== undefined) this.track(part, block.arguments);
        }
      }
      if (record(message) && message.role === "toolResult" && typeof message.toolCallId === "string") {
        const part = parts.get(message.toolCallId);
        if (part !== undefined) this.finish(part, message.isError === true);
      }
      this.entry(entry);
    }
  }
}

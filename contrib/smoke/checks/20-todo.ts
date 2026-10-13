import assert from "node:assert/strict";
import type { Todo } from "../../../src/todo-bridge.js";
import type { Check } from "../core.js";
import type { SmokeContext } from "../context.js";

export function register(check: Check, context: SmokeContext): void {
  check("todo", async (signal) => {
    const before = (await context.messages(signal)).length;
    const updated = context.waitForEvent((event) => event.type === "todo.updated" &&
      event.properties.sessionID === context.sessionId() &&
      event.properties.todos.length === 2 && event.properties.todos.some((todo) => todo.status === "completed"),
    180_000, signal);
    const idle = context.turnIdle(signal, 180_000);
    await context.prompt('Use the todo tool directly with op init and list [{phase:"Preparation",items:["Inspect smoke fixture for todo bridge"]},{phase:"Delivery",items:["Report smoke fixture verification result"]}]. Then use todo op done task "Inspect smoke fixture for todo bridge". Keep the second item open. Do not do any other work, do not delegate, and stop after these two todo calls.', signal);
    const event = await updated;
    await idle;
    assert.equal(event.type, "todo.updated");
    if (event.type !== "todo.updated") assert.fail("wrong todo event");
    assert.notEqual(event.properties.todos[1]?.status, "completed",
      "the completed-first-task snapshot must retain the still-open second item");
    const snapshots = context.sse.events.flatMap((entry): Todo[][] =>
      entry.type === "todo.updated" && entry.properties.sessionID === context.sessionId()
        ? [entry.properties.todos]
        : []);
    const latest = snapshots.at(-1);
    assert.ok(latest, "todo.updated must publish a final snapshot before idle");
    const todos = await context.api<Todo[]>(`/session/${context.sessionId()}/todo`, signal);
    assert.deepEqual(todos, latest, "GET todo must equal the latest SSE snapshot at idle");
    assert.deepEqual(todos.map((todo) => todo.content), [
      "Preparation: Inspect smoke fixture for todo bridge",
      "Delivery: Report smoke fixture verification result",
    ]);
    assert.equal(todos[0]?.status, "completed");
    assert.ok(todos.every((todo) => /^[a-f0-9]{16}$/.test(todo.id)));
    const parts = (await context.messages(signal)).slice(before).flatMap((message) => message.parts);
    assert.ok(parts.some((part) => part.type === "tool" && part.tool === "todowrite" &&
      part.state.status === "completed" && JSON.stringify(part.state.input.todos) === JSON.stringify(todos)),
    "completed todowrite card must retain the same flattened snapshot");
  }, { dependsOn: ["tool-cards"], timeoutMs: 240_000 });
}

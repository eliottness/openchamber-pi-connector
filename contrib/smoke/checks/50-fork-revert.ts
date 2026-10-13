import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { OCMessageWithParts, OCSession } from "../../../src/types.js";
import type { Check } from "../core.js";
import type { SmokeContext } from "../context.js";

export function register(check: Check, context: SmokeContext): void {
  check("fork-revert", async (signal) => {
    const previous = context.session;
    context.session = await context.api<OCSession>("/session", signal, { title: "Smoke conversation tree" });
    const id = context.sessionId();
    const waitForSettledIdle = async (): Promise<void> => {
      for (let transition = 0; transition < 3; transition++) {
        const controller = new AbortController();
        const transitionSignal = AbortSignal.any([signal, controller.signal]);
        const nextIdle = context.idle(transitionSignal, 120_000);
        const status = await context.api<Record<string, { type: string }>>("/session/status", signal);
        if (status[id]?.type === "idle") {
          controller.abort(new Error("already idle"));
          return;
        }
        await nextIdle;
        controller.abort(new Error("idle transition observed"));
      }
      const status = await context.api<Record<string, { type: string }>>("/session/status", signal);
      assert.equal(status[id]?.type, "idle", "conversation-tree actions require a settled idle session");
    };
    const first = `FIRST-${context.marker}`;
    const last = `LAST-${context.marker}`;
    const file = join(context.work, "revert-keeps-file.txt");
    const firstIdle = context.idle(signal);
    await context.prompt(`Reply with ${first} only. Do not use tools.`, signal);
    await firstIdle;
    await waitForSettledIdle();
    const prior = await context.messages(signal);
    assert.equal(prior.filter((message) => message.info.role === "user").length, 1);
    const write = context.waitForEvent((event) => event.type === "message.part.updated" &&
      event.properties.part.sessionID === id && event.properties.part.type === "tool" &&
      event.properties.part.tool === "write" && event.properties.part.state.status === "completed", 120_000, signal);
    const lastIdle = context.idle(signal);
    await context.prompt(`Use write directly to create ${file} with exact content ${last}. Do not delegate. Then reply ${last} and stop.`, signal);
    await Promise.all([write, lastIdle]);
    await waitForSettledIdle();
    await context.stop(signal);
    await context.start(signal, true);
    context.session = await context.api<OCSession>(`/session/${id}`, signal);
    const original = await context.messages(signal);
    const users = original.filter((message) => message.info.role === "user");
    assert.equal(users.length, 2);
    const second = users[1];
    assert.ok(second);
    assert.equal(readFileSync(file, "utf8"), last);
    const sha = (): string => createHash("sha256").update(readFileSync(file)).digest("hex");
    const digest = sha();
    const created = context.waitForEvent((event) => event.type === "session.created" &&
      event.properties.info.id !== id && event.properties.info.title === "Smoke conversation tree (fork)", 60_000, signal);
    const fork = await context.api<OCSession>(`/session/${id}/fork`, signal, { messageID: second.info.id });
    const event = await created;
    assert.equal(event.type, "session.created");
    if (event.type !== "session.created") assert.fail("wrong fork event");
    assert.equal(event.properties.info.id, fork.id);
    assert.notEqual(fork.id, id);
    const forkMessages = await context.api<OCMessageWithParts[]>(`/session/${fork.id}/message`, signal);
    const normalizedInput = (tool: string, input: Record<string, unknown>): Record<string, unknown> => {
      if (tool !== "todowrite" || !Array.isArray(input.todos)) return input;
      return {
        ...input,
        todos: input.todos.map((value) => {
          if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
          const { id: _sessionScopedID, ...todo } = value as Record<string, unknown>;
          return todo;
        }),
      };
    };
    const shape = (messages: readonly OCMessageWithParts[]) => messages.map((message) => ({
      role: message.info.role,
      parts: message.parts.map((part) => part.type === "text" ? { type: part.type, text: part.text } :
        part.type === "tool"
          ? { type: part.type, tool: part.tool, input: normalizedInput(part.tool, part.state.input) }
          : { type: part.type }),
    }));
    const secondIndex = original.findIndex((message) => message.info.id === second.info.id);
    assert.ok(secondIndex > 0, "restored second user must have prior messages");
    assert.deepEqual(shape(forkMessages), shape(original.slice(0, secondIndex)),
      "fork at second user must contain only prior restored messages");
    const reverted = context.waitForEvent((entry) => entry.type === "session.updated" &&
      entry.properties.info.id === id && entry.properties.info.revert?.messageID === second.info.id, 60_000, signal);
    const info = await context.api<OCSession>(`/session/${id}/revert`, signal, { messageID: second.info.id });
    await reverted;
    assert.equal(info.revert?.messageID, second.info.id);
    assert.equal((await context.api<OCSession>(`/session/${id}`, signal)).revert?.messageID, second.info.id);
    assert.equal(sha(), digest, "conversation revert must leave the written file unchanged");
    const restored = context.waitForEvent((entry) => entry.type === "session.updated" &&
      entry.properties.info.id === id && entry.properties.info.revert === undefined, 60_000, signal);
    const un = await context.api<OCSession>(`/session/${id}/unrevert`, signal, {});
    await restored;
    assert.equal(un.revert, undefined);
    assert.equal((await context.api<OCSession>(`/session/${id}`, signal)).revert, undefined);
    assert.deepEqual(await context.messages(signal), original, "unrevert must restore exact original HTTP history");
    assert.equal(sha(), digest);
    context.session = previous;
  }, { dependsOn: ["approvals"], timeoutMs: 300_000 });
}

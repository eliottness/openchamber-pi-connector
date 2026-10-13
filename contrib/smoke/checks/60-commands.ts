import assert from "node:assert/strict";
import type { OCSession } from "../../../src/types.js";
import type { Check } from "../core.js";
import type { SmokeContext } from "../context.js";

export function register(check: Check, context: SmokeContext): void {
  check("commands", async (signal) => {
    const commands = await context.api<Array<{ name: string; description: string; template: string }>>("/command", signal);
    assert.ok(commands.length > 0, "OmO must expose a non-empty command catalog");
    for (const command of commands) {
      assert.ok(typeof command.name === "string" && command.name.length > 0);
      assert.equal(typeof command.description, "string");
      assert.equal(typeof command.template, "string");
    }
    const previous = context.session;
    context.session = await context.api<OCSession>("/session", signal, { title: "Smoke shell commands" });
    const id = context.sessionId();
    for (const [command, exitCode] of [["echo SMOKE_SHELL_OK", 0], ["exit 3", 3]] as const) {
      const completed = context.waitForEvent((event) => event.type === "message.part.updated" &&
        event.properties.part.sessionID === id && event.properties.part.type === "tool" &&
        event.properties.part.tool === "bash" && event.properties.part.state.input.command === command &&
        event.properties.part.state.status === "completed", 30_000, signal);
      const idle = context.turnIdle(signal, 30_000);
      await context.api(`/session/${id}/shell`, signal, { command });
      const event = await completed;
      await idle;
      if (event.type !== "message.part.updated" || event.properties.part.type !== "tool" ||
          event.properties.part.state.status !== "completed") assert.fail("missing completed bash card");
      const part = event.properties.part;
      assert.equal(part.state.status, "completed");
      assert.equal(part.state.metadata.exitCode, exitCode);
      assert.equal(part.state.metadata.cancelled, false);
      if (exitCode === 0) assert.ok(part.state.output.includes("SMOKE_SHELL_OK"));
      const persisted = (await context.messages(signal)).flatMap((message) => message.parts)
        .find((entry) => entry.id === part.id);
      assert.deepEqual(persisted, part, "GET history must retain the completed shell card");
      assert.equal((await context.api<Record<string, { type: string }>>("/session/status", signal))[id]?.type, "idle");
    }
    const longCommand = "sleep 600";
    const running = context.waitForEvent((event) => event.type === "message.part.updated" &&
      event.properties.part.sessionID === id && event.properties.part.type === "tool" &&
      event.properties.part.tool === "bash" && event.properties.part.state.input.command === longCommand &&
      event.properties.part.state.status === "running", 30_000, signal);
    const cancelled = context.waitForEvent((event) => event.type === "message.part.updated" &&
      event.properties.part.sessionID === id && event.properties.part.type === "tool" &&
      event.properties.part.tool === "bash" && event.properties.part.state.input.command === longCommand &&
      event.properties.part.state.status === "error" &&
      event.properties.part.state.metadata?.cancelled === true, 10_000, signal);
    const cancelledIdle = context.turnIdle(signal, 10_000);
    const shell = fetch(`${context.url}/session/${id}/shell`, {
      method: "POST",
      body: JSON.stringify({ command: longCommand }),
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    });
    await running;
    assert.equal((await context.api<Record<string, { type: string }>>("/session/status", signal))[id]?.type, "busy");
    const started = performance.now();
    assert.equal(await context.api<boolean>(`/session/${id}/abort`, signal, {}), true);
    const [cancelledEvent] = await Promise.all([cancelled, cancelledIdle]);
    assert.ok(performance.now() - started < 10_000, "cancelled shell must return the session to idle within ten seconds");
    assert.equal((await shell).status, 200);
    if (cancelledEvent.type !== "message.part.updated" || cancelledEvent.properties.part.type !== "tool" ||
        cancelledEvent.properties.part.state.status !== "error") assert.fail("missing cancelled bash card");
    assert.equal(cancelledEvent.properties.part.state.metadata?.cancelled, true);
    assert.equal((await context.api<Record<string, { type: string }>>("/session/status", signal))[id]?.type, "idle");
    const cancelledPersisted = (await context.messages(signal)).flatMap((message) => message.parts)
      .find((entry) => entry.id === cancelledEvent.properties.part.id);
    assert.deepEqual(cancelledPersisted, cancelledEvent.properties.part,
      "GET history must retain the cancelled shell card");
    const response = await fetch(`${context.url}/session/${id}/share`, {
      method: "POST", body: "{}", headers: { "Content-Type": "application/json" },
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    });
    assert.equal(response.status, 400);
    const body: { data: { message: string } } = await response.json();
    assert.equal(body.data.message, "Sharing is not available with OmO");
    context.session = previous;
  }, { dependsOn: ["fork-revert"], timeoutMs: 120_000 });
}

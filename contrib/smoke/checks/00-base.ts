import assert from "node:assert/strict";
import type { OCSession } from "../../../src/types.js";
import type { Check } from "../core.js";
import { assistantText, type SmokeContext } from "../context.js";

export function register(check: Check, context: SmokeContext): void {
  check("health", async (signal) => {
    await context.start(signal);
    const health = await context.api<{ healthy: boolean }>("/global/health", signal);
    assert.equal(health.healthy, true);
  });

  check("models", async (signal) => {
    const catalog = await context.api<{ providers: Array<{ id: string; models: Record<string, unknown> }> }>("/config/providers", signal);
    assert.ok(catalog.providers.some((provider) => Object.keys(provider.models).length > 0),
      "OmO spawn-dependent model catalog must contain models (check OCPI_PI_BINARY)");
    assert.ok(catalog.providers.some((provider) => provider.id === "anthropic" && "claude-haiku-4-5" in provider.models),
      "requested anthropic/claude-haiku-4-5 must be available");
  }, { dependsOn: ["health"] });

  check("existing-sessions", async (signal) => {
    const sessions = await context.api<OCSession[]>("/experimental/session", signal);
    assert.ok(sessions.length > 0, `existing OmO sessions must be discovered from ${context.sourceAgent}`);
    assert.ok(sessions.some((session) => !session.directory.startsWith(context.root)),
      "session discovery must include existing sessions, not just QA sessions");
    console.log(`existing sessions: ${sessions.length} (read-only; no prompts sent)`);
  }, { dependsOn: ["health"] });

  check("create", async (signal) => {
    // Read-only discovery is complete. New sessions and all OmO writes use a private agent root.
    await context.stop(signal);
    await context.start(signal, true);
    context.session = await context.api<OCSession>("/session", signal, { title: `OmO smoke ${context.marker}` });
    assert.match(context.sessionId(), /^ses_/);
    const sessions = await context.api<OCSession[]>(`/session?directory=${encodeURIComponent(context.work)}`, signal);
    assert.ok(sessions.some((session) => session.id === context.sessionId()));
    assert.ok(context.agentPids().length > 0, "session creation must spawn a real OmO process");
  }, { dependsOn: ["models", "existing-sessions"] });

  check("prompt", async (signal) => {
    const delta = context.delta(signal);
    const idle = context.turnIdle(signal);
    await context.prompt(`Remember this exact token for later: ${context.marker}. Reply with that token only. Do not use tools.`, signal);
    await Promise.all([delta, idle]);
    const messages = await context.messages(signal);
    assert.ok(assistantText(messages).includes(context.marker), "assistant response must contain the context token");
    assert.ok(messages.some((message) => message.info.role === "assistant" && message.info.providerID === "anthropic" &&
      message.info.modelID.startsWith("claude-haiku-4-5")), "assistant must actually use the requested model");
    const status = await context.api<Record<string, { type: string }>>("/session/status", signal);
    assert.equal(status[context.sessionId()]?.type, "idle");
  }, { dependsOn: ["create"] });

  check("abort", async (signal) => {
    const delta = context.delta(signal);
    await context.prompt("Write a 10000-word detailed essay about the history of computing. Start immediately, keep writing, and do not use tools.", signal);
    await delta;
    const before = await context.api<Record<string, { type: string }>>("/session/status", signal);
    assert.equal(before[context.sessionId()]?.type, "busy", "must abort an actively streaming turn");
    const idle = context.idle(signal, 2_000);
    const started = performance.now();
    const aborted = await context.api<boolean>(`/session/${context.sessionId()}/abort`, signal, {});
    assert.equal(aborted, true);
    await idle;
    assert.ok(performance.now() - started < 2_000, "abort must reach idle within 2 seconds");
    const after = await context.api<Record<string, { type: string }>>("/session/status", signal);
    assert.equal(after[context.sessionId()]?.type, "idle");
  }, { dependsOn: ["prompt"] });

  check("restart", async (signal) => {
    await context.stop(signal);
    await context.start(signal, true);
    const sessions = await context.api<OCSession[]>(`/session?directory=${encodeURIComponent(context.work)}`, signal);
    assert.ok(sessions.some((session) => session.id === context.sessionId()), "same created session must be listed after restart");
    const messages = await context.messages(signal);
    assert.ok(messages.some((message) => message.info.role === "user"));
    assert.ok(assistantText(messages).includes(context.marker), "persisted assistant history must survive restart");
  }, { dependsOn: ["abort"] });

  check("idle-reaping", async (signal) => {
    await context.stop(signal);
    await context.start(signal, true, 30_000);
    const delta = context.delta(signal);
    const idle = context.turnIdle(signal);
    await context.prompt("Reply with the exact token I asked you to remember earlier. Do not use tools.", signal);
    await Promise.all([delta, idle]);
    const pids = context.agentPids();
    assert.ok(pids.length > 0, "must observe a live OmO pid before reaping");
    console.log(`idle reaping: watching OmO pids ${pids.map((info) => info.pid).join(",")} (30s idle, 60s reaper, 150s bound)`);
    await context.waitForDeath(pids, 150_000, signal);
    assert.equal(context.agentPids().length, 0, "idle OmO processes must disappear before revival");
    const before = await context.messages(signal);
    const nextDelta = context.delta(signal);
    const nextIdle = context.turnIdle(signal);
    await context.prompt("Reply with the exact token I asked you to remember earlier. Do not use tools.", signal);
    await Promise.all([nextDelta, nextIdle]);
    const after = await context.messages(signal);
    assert.ok(after.length > before.length, "new prompt must add messages after revival");
    assert.ok(assistantText(after.slice(before.length)).includes(context.marker), "revived agent must retain prior context");
    const revived = context.agentPids();
    assert.ok(revived.length > 0 && revived.every((info) => !pids.some((old) => old.pid === info.pid && old.start === info.start)),
      "revival must spawn a new OmO process");
  }, { dependsOn: ["restart"], timeoutMs: 420_000 });

}

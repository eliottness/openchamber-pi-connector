import assert from "node:assert/strict";
import type { OCSession } from "../../../src/types.js";
import type { Check } from "../core.js";
import type { SmokeContext } from "../context.js";

export function register(check: Check, context: SmokeContext): void {
  check("compact", async (signal) => {
    const previous = context.session;
    context.session = await context.api<OCSession>("/session", signal, { title: "Smoke compaction" });
    const id = context.sessionId();
    const fixtureWords = ["notebook", "desk", "lamp"];
    for (let turn = 0; turn < 3; turn++) {
      console.log(`compact: building context turn ${turn + 1}/3`);
      const idle = context.turnIdle(signal, 180_000);
      const word = fixtureWords[turn];
      assert.ok(word);
      const contextBlock = Array(7_000).fill(word).join(" ");
      await context.prompt(`Compaction fixture ${context.marker}, turn ${turn}. Do not use tools. ` +
        `Reply briefly after reading this context:\n${contextBlock}\nEnd of turn ${turn}; reply briefly without tools.`, signal);
      await idle;
      console.log(`compact: completed context turn ${turn + 1}/3`);
    }
    const before = await context.messages(signal);
    assert.equal(before.filter((message) => message.info.role === "user").length, 3);
    assert.ok(before.filter((message) => message.info.role === "assistant").length >= 3);
    const ids = new Set(before.map((message) => message.info.id));
    const compacted = await fetch(`${context.url}/session/${id}/summarize`, {
      method: "POST", body: "{}", headers: { "Content-Type": "application/json" },
      signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
    });
    assert.equal(compacted.status, 200);
    assert.equal(await compacted.json(), true);
    const postCompact = `POST-COMPACT-${context.marker}`;
    const idle = context.turnIdle(signal, 180_000);
    await context.prompt(`Record this exact post-compaction marker: ${postCompact}. Reply briefly without tools.`, signal);
    await idle;
    const after = await context.messages(signal);
    const appended = after.find((message) => !ids.has(message.info.id) && message.info.role === "user" &&
      message.parts.some((part) => part.type === "text" && part.text.includes(postCompact)));
    assert.ok(appended, "GET messages must expose the post-compaction entry, not the stale tree leaf");
    console.log(`compact: appended HTTP message ${appended.info.id}`);
    context.session = await context.api<OCSession>("/session", signal, { title: "Smoke empty compaction" });
    assert.deepEqual(await context.messages(signal), []);
    const response = await fetch(`${context.url}/session/${context.sessionId()}/summarize`, {
      method: "POST", body: "{}", headers: { "Content-Type": "application/json" },
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    });
    assert.equal(response.status, 400);
    const body: { data: { message: string } } = await response.json();
    assert.ok(body.data.message.includes("Nothing to compact"));
    context.session = previous;
  }, { dependsOn: ["commands"], timeoutMs: 720_000 });
}

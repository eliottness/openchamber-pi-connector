import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PermissionRequest } from "@opencode-ai/sdk/v2";
import type { OCSession } from "../../../src/types.js";
import type { Check, SmokeEvent } from "../core.js";
import type { SmokeContext } from "../context.js";

export function register(check: Check, context: SmokeContext): void {
  check("approvals", async (signal) => {
    const previous = context.session;
    const files = {
      once: join(context.work, "tool-cards.txt"),
      reject: join(context.work, "approval-deny.txt"),
    };
    writeFileSync(files.reject, `DENY-${context.marker}\n`);
    await context.stop(signal);
    // Explicit rules in the copied user settings override a preset. The CLI
    // rule has highest precedence. Disable the private HOME's first-run
    // onboarding turn so the requested fixture read is the first tool call.
    await context.start(signal, true, 900_000,
      "--permission-preset ask --permission read=ask");
    context.session = await context.api<OCSession>("/session", signal, { title: "Smoke approvals" });
    const sessionID = context.sessionId();
    for (const reply of ["once", "reject"] as const) {
      const file = files[reply];
      let accepted: {
        event: SmokeEvent;
        tool: Promise<SmokeEvent>;
        idle: Promise<SmokeEvent>;
        before: number;
        controller: AbortController;
      } | undefined;
      for (let attempt = 0; attempt < 2 && accepted === undefined; attempt++) {
        console.log(`approvals: requesting ${reply}${attempt === 0 ? "" : " retry"}`);
        const before = (await context.messages(signal)).length;
        const controller = new AbortController();
        const attemptSignal = AbortSignal.any([signal, controller.signal]);
        const asked = context.waitForEvent((event) => event.type === "permission.asked" &&
          event.properties.sessionID === sessionID, 180_000, attemptSignal);
        const tool = context.waitForEvent((event) => event.type === "message.part.updated" &&
          event.properties.part.sessionID === sessionID && event.properties.part.type === "tool" &&
          event.properties.part.tool === "read" && event.properties.part.state.status ===
            (reply === "once" ? "completed" : "error"), 180_000, attemptSignal);
        const idle = context.turnIdle(attemptSignal, 180_000);
        await context.prompt(`${attempt === 0 ? "" : "Smoke-test precondition: you MUST call the read tool even if you think you know the file. "}` +
          `Use the read tool directly exactly once on ${file}. Do not use other tools or delegate. ` +
          "If permission is denied, report that denial and stop without retrying.", signal);
        const first = await Promise.race([
          asked.then((event) => ({ kind: "asked" as const, event })),
          tool.then((event) => ({ kind: "tool" as const, event })),
          idle.then((event) => ({ kind: "idle" as const, event })),
        ]);
        if (first.kind === "asked") {
          if (first.event.type !== "permission.asked") assert.fail("wrong approval event");
          if (first.event.properties.permission.includes("read") &&
              first.event.properties.patterns.includes(file)) {
            accepted = { event: first.event, tool, idle, before, controller };
            break;
          }
          const transcript = JSON.stringify((await context.messages(signal)).slice(before));
          assert.equal(await context.api(`/permission/${encodeURIComponent(first.event.properties.id)}/reply`,
            signal, { reply: "reject" }), true);
          await idle;
          controller.abort(new Error("wrong model precondition"));
          if (attempt === 0) {
            console.log(`precondition retry approvals ${reply}: model requested a different permission; transcript=${transcript}`);
            continue;
          }
          assert.fail(`approval precondition failed twice: model requested a different permission; transcript=${transcript}`);
        }
        if (first.kind === "tool") {
          controller.abort(new Error("connector permission observable missing"));
          assert.fail("read reached a terminal state before permission.asked");
        }
        const transcript = JSON.stringify((await context.messages(signal)).slice(before));
        controller.abort(new Error("model skipped read"));
        if (attempt === 0) {
          console.log(`precondition retry approvals ${reply}: model reached idle without calling read; transcript=${transcript}`);
          continue;
        }
        assert.fail(`approval precondition failed twice: model reached idle without calling read; transcript=${transcript}`);
      }
      assert.ok(accepted, "approval precondition must produce a read permission card");
      const { event, tool, idle, before, controller } = accepted;
      console.log(`approvals: asked ${reply}`);
      assert.equal(event.type, "permission.asked");
      if (event.type !== "permission.asked") assert.fail("wrong approval event");
      assert.ok(event.properties.permission.includes("read"), "request must be for reading");
      const pending = await context.api<PermissionRequest[]>("/permission", signal);
      assert.deepEqual(pending.find((request) => request.id === event.properties.id), event.properties,
        "GET /permission must expose the exact pending SSE request");
      const replied = context.waitForEvent((entry) => entry.type === "permission.replied" &&
        entry.properties.sessionID === sessionID && entry.properties.requestID === event.properties.id &&
        entry.properties.reply === reply, 30_000, signal);
      assert.equal(await context.api(`/permission/${encodeURIComponent(event.properties.id)}/reply`, signal, { reply }), true);
      await Promise.all([tool, replied, idle]);
      controller.abort(new Error("approval attempt completed"));
      console.log(`approvals: completed ${reply}`);
      const parts = (await context.messages(signal)).slice(before).flatMap((message) => message.parts);
      const read = parts.find((part) => part.type === "tool" && part.tool === "read");
      assert.ok(read && read.type === "tool");
      assert.equal(read.state.input.filePath, file);
      if (reply === "once") {
        assert.equal(read.state.status, "completed");
        assert.ok(read.state.output.includes(`AFTER-${context.marker}`), "allowed read must return the fixture");
      } else {
        assert.equal(read.state.status, "error");
        assert.match(read.state.error, /denied|reject|permission/i, "denial must surface as a tool error");
      }
      assert.ok(!(await context.api<PermissionRequest[]>("/permission", signal)).some((request) =>
        request.id === event.properties.id), "replied request must leave the pending list");
    }
    await context.stop(signal);
    await context.start(signal, true);
    context.session = previous;
  }, { dependsOn: ["tool-cards"], timeoutMs: 420_000 });
}

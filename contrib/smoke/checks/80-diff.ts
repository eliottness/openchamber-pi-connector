import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionFileDiff } from "../../../src/session-diff.js";
import type { OCSession } from "../../../src/types.js";
import type { Check, SmokeEvent } from "../core.js";
import type { SmokeContext } from "../context.js";

export function register(check: Check, context: SmokeContext): void {
  check("diff", async (signal) => {
    const previous = context.session;
    context.session = await context.api<OCSession>("/session", signal, { title: "Smoke diff fixture" });
    const fixtureIdle = context.turnIdle(signal, 30_000);
    await context.api(`/session/${context.sessionId()}/shell`, signal, {
      command: "git init -q && printf 'keep\\nold\\n' > diff-tracked.txt && git add -- diff-tracked.txt && " +
        "git -c user.name=Smoke -c user.email=smoke@example.invalid -c commit.gpgsign=false commit -qm 'Smoke fixture'",
    });
    await fixtureIdle;
    context.session = await context.api<OCSession>("/session", signal, { title: "Smoke git diff" });
    const id = context.sessionId();
    const tracked = join(context.work, "diff-tracked.txt");
    const added = join(context.work, "diff-added.txt");
    const matches = (diff: SessionFileDiff[]): boolean =>
      diff.some((file) => file.file === "diff-tracked.txt") && diff.some((file) => file.file === "diff-added.txt");
    let diffEvent: Promise<SmokeEvent> | undefined;
    let ready = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      const before = (await context.messages(signal)).length;
      const controller = new AbortController();
      diffEvent = context.waitForEvent((event) => event.type === "session.diff" &&
        event.properties.sessionID === id && matches(event.properties.diff), 180_000,
        AbortSignal.any([signal, controller.signal]));
      const idle = context.turnIdle(signal, 180_000);
      await context.prompt(`${attempt === 0 ? "" : "Smoke-test precondition: use the named tools on the exact paths, even if already changed. "}` +
        `Use edit (or multiedit) directly on ${tracked} to replace old with new, keeping keep on the first line. ` +
        `Then use write directly to create ${added} with exactly "one\\ntwo\\n". ` +
        "Do not use apply_patch, bash, eval or delegation. Stop after these mutations.", signal);
      await idle;
      const parts = (await context.messages(signal)).slice(before).flatMap((message) => message.parts);
      ready = [tracked, added].every((file) => parts.some((part) => part.type === "tool" &&
        ["write", "edit", "multiedit"].includes(part.tool) && part.state.status === "completed" &&
        part.state.input.filePath === file));
      if (ready) break;
      controller.abort(new Error("model precondition missing"));
      const transcript = JSON.stringify(parts.filter((part) => part.type === "tool"));
      if (attempt === 0) console.log(`precondition retry diff: model omitted a mapped mutation or used the wrong path; transcript=${transcript}`);
      else assert.fail(`diff precondition failed twice; transcript=${transcript}`);
    }
    assert.ok(ready, "both files must have completed mapped mutations");
    assert.equal(readFileSync(tracked, "utf8"), "keep\nnew\n");
    assert.equal(readFileSync(added, "utf8"), "one\ntwo\n");
    assert.ok(diffEvent);
    const event = await diffEvent;
    if (event.type !== "session.diff") assert.fail("missing session.diff");
    const diffs = await context.api<SessionFileDiff[]>(`/session/${id}/diff`, signal);
    assert.equal(diffs.length, 2, "only the two touched files belong in this session diff");
    const changed = diffs.find((file) => file.file === "diff-tracked.txt");
    const created = diffs.find((file) => file.file === "diff-added.txt");
    assert.ok(changed && created);
    assert.deepEqual({ before: changed.before, after: changed.after, additions: changed.additions, deletions: changed.deletions, status: changed.status },
      { before: "keep\nold\n", after: "keep\nnew\n", additions: 1, deletions: 1, status: "modified" });
    assert.deepEqual({ before: created.before, after: created.after, additions: created.additions, deletions: created.deletions, status: created.status },
      { before: "", after: "one\ntwo\n", additions: 2, deletions: 0, status: "added" });
    assert.ok(changed.patch.includes("-old\n") && changed.patch.includes("+new\n"));
    assert.ok(created.patch.includes("+one\n") && created.patch.includes("+two\n"));
    assert.deepEqual(event.properties.diff, diffs, "SSE and GET must expose the same post-turn diff");
    context.session = previous;
  }, { dependsOn: ["compact"], timeoutMs: 420_000 });
}

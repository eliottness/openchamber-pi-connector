import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { OCMessageWithParts, OCToolPart } from "../../../src/types.js";
import type { Check } from "../core.js";
import type { SmokeContext } from "../context.js";

export function register(check: Check, context: SmokeContext): void {
  check("subagent", async (signal) => {
    const parent = context.sessionId();
    const before = (await context.messages(signal)).length;
    const file = join(context.work, "subagent.txt");
    const mutationTools = new Set(["write", "edit", "multiedit", "apply_patch"]);
    const created = context.waitForEvent((event) => event.type === "session.created" &&
      event.properties.info.parentID === parent, 290_000, signal);
    const mutation = context.waitForEvent((event) => event.type === "message.part.updated" &&
      event.properties.part.type === "tool" && event.properties.part.sessionID !== parent &&
      mutationTools.has(event.properties.part.tool) &&
      event.properties.part.state.status === "completed", 290_000, signal);
    const read = context.waitForEvent((event) => event.type === "message.part.updated" &&
      event.properties.part.type === "tool" && event.properties.part.sessionID !== parent &&
      event.properties.part.tool === "read" &&
      event.properties.part.state.status === "completed", 290_000, signal);
    const idle = context.turnIdle(signal, 290_000);
    const running = context.waitForEvent((event) => event.type === "message.part.updated" &&
      event.properties.part.sessionID === parent && event.properties.part.type === "tool" &&
      event.properties.part.tool === "task" && event.properties.part.state.status === "running", 290_000, signal);
    const completed = context.waitForEvent((event) => event.type === "message.part.updated" &&
      event.properties.part.sessionID === parent && event.properties.part.type === "tool" &&
      event.properties.part.tool === "task" && event.properties.part.state.status === "completed", 290_000, signal);
    console.log("subagent: starting one foreground quick task (5 minute bound)");
    await context.prompt(`Run exactly ONE task tool call directly, category "quick", run_in_background false, isolated false, task_summary "Write and read smoke fixture". Give it this English prompt: "1. Create ${file} containing the single line CHILD-${context.marker}, using a file-mutation tool. 2. Use read to read that file. 3. Return the content. Do not delegate, do not use bash, do not change other files. Success is the mutation and read tool calls completing." Wait for the foreground result, report it, and stop. Do not use eval to invoke task.`, signal);
    await running;
    console.log("subagent: parent task tool is running");
    const [childEvent, toolEvents] = await Promise.all([created, Promise.all([mutation, read]), completed, idle]);
    assert.equal(childEvent.type, "session.created");
    if (childEvent.type !== "session.created") assert.fail("wrong child event");
    const child = childEvent.properties.info;
    assert.equal(child.parentID, parent);
    assert.equal(child.directory, context.work);
    for (const toolEvent of toolEvents) {
      assert.equal(toolEvent.type, "message.part.updated");
      if (toolEvent.type !== "message.part.updated") assert.fail("wrong child tool event");
      assert.equal(toolEvent.properties.part.sessionID, child.id, "live child tool event must belong to the linked child");
    }
    const tasks = (await context.messages(signal)).slice(before).flatMap((message) => message.parts)
      .filter((part): part is OCToolPart => part.type === "tool" && part.tool === "task");
    assert.equal(tasks.length, 1, "parent must run exactly one task");
    const task = tasks[0];
    assert.ok(task);
    assert.equal(task.state.status, "completed");
    assert.equal(task.state.metadata.sessionID, child.id);
    const taskID = task.state.metadata.taskID;
    assert.equal(typeof taskID, "string");
    if (typeof taskID !== "string") assert.fail("missing task ID");
    assert.equal(child.id, `ses_${createHash("md5").update(taskID).digest("hex")}`);
    assert.ok(!task.state.output.includes("[task_id:"), "parent task output must not expose the linking suffix");
    const messages = await context.api<OCMessageWithParts[]>(`/session/${child.id}/message`, signal);
    const childTools = messages.flatMap((message) => message.parts)
      .filter((part): part is OCToolPart => part.type === "tool" && part.state.status === "completed");
    assert.ok(childTools.some((part) => mutationTools.has(part.tool)),
      "fetchable child history must contain a completed file-mutation tool");
    assert.ok(childTools.some((part) => part.tool === "read" && part.state.input.filePath === file),
      "fetchable child history must contain the completed read");
    const archive = join(context.state, "children", `${taskID}.jsonl`);
    assert.ok(existsSync(archive), "terminal child transcript must be archived");
    assert.ok(readFileSync(archive, "utf8").split("\n").some((line) => line.includes('"toolCall"')),
      "archive must contain real tool calls, not a fallback summary");
    assert.equal(readFileSync(file, "utf8").trimEnd(), `CHILD-${context.marker}`);
    console.log(`subagent: child=${child.id} task=${taskID} archive=${archive}`);
  }, { dependsOn: ["todo"], timeoutMs: 300_000 });
}

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { OCToolPart } from "../../../src/types.js";
import type { Check } from "../core.js";
import type { SmokeContext } from "../context.js";

export function register(check: Check, context: SmokeContext): void {
  check("tool-cards", async (signal) => {
    const file = join(context.work, "tool-cards.txt");
    let selected: {
      tools: OCToolPart[];
      write: OCToolPart;
      read: OCToolPart;
      edit: OCToolPart;
      eventStart: number;
    } | undefined;
    for (let attempt = 0; attempt < 2 && selected === undefined; attempt++) {
      const before = (await context.messages(signal)).length;
      const eventStart = context.sse.events.length;
      const idle = context.idle(signal, 180_000);
      await context.prompt(`${attempt === 0 ? "" : "Smoke-test precondition: you MUST use all three named tools even if the file already exists. "}` +
        `Use the write tool to overwrite ${file} with exact content "BEFORE-${context.marker}\\n". ` +
        "Then use the read tool on that file. Then use the edit tool (not apply_patch, bash, or eval) " +
        "replacing BEFORE- with AFTER-. Use these three tools directly, one after another. Do not delegate. Stop after the edit.", signal);
      await idle;
      const messages = (await context.messages(signal)).slice(before);
      const tools = messages.flatMap((message) => message.parts)
        .filter((part): part is OCToolPart => part.type === "tool");
      const write = tools.find((part) => part.tool === "write" && part.state.status === "completed");
      const read = tools.find((part) => part.tool === "read" && part.state.status === "completed");
      const edit = tools.find((part) => (part.tool === "edit" || part.tool === "multiedit") &&
        part.state.status === "completed");
      if (write && read && edit &&
          [write, read, edit].every((part) => part.state.input.filePath === file)) {
        selected = { tools, write, read, edit, eventStart };
        break;
      }
      const transcript = JSON.stringify(messages.map((message) => ({
        role: message.info.role,
        parts: message.parts.map((part) => part.type === "tool"
          ? { type: part.type, tool: part.tool, status: part.state.status, input: part.state.input }
          : { type: part.type, ...("text" in part ? { text: part.text } : {}) }),
      })));
      if (attempt === 0) {
        console.log(`precondition retry tool-cards: model omitted a required tool or used the wrong file path; transcript=${transcript}`);
        continue;
      }
      assert.fail(`tool-card precondition failed twice: model omitted a required tool or used the wrong file path; transcript=${transcript}`);
    }
    assert.ok(selected, "tool-card precondition must produce completed read, write, and edit cards");
    const { tools, write, read, edit, eventStart } = selected;
    assert.ok(write && read && edit, "HTTP history must contain the three native tool cards");
    for (const part of [write, read, edit]) {
      assert.ok(context.sse.events.slice(eventStart).some((event) =>
        event.type === "message.part.updated" && event.properties.part.type === "tool" &&
        event.properties.part.id === part.id && event.properties.part.state.status === "completed"),
      `SSE must contain the completed ${part.tool} card`);
    }
    for (const part of [write, read, edit]) {
      assert.equal(part.state.status, "completed");
      assert.equal(part.state.input.filePath, file);
    }
    assert.equal(write.state.input.content, `BEFORE-${context.marker}\n`);
    assert.equal(write.state.status, "completed");
    assert.equal(write.state.metadata.diff, undefined);
    assert.equal(write.state.metadata.filediff, undefined);
    assert.equal(write.state.metadata.patch, undefined);
    const replacements = edit.tool === "multiedit" ? edit.state.input.edits : [edit.state.input];
    assert.ok(Array.isArray(replacements) && replacements.some((value) =>
      value !== null && typeof value === "object" && "oldString" in value && "newString" in value &&
      typeof value.oldString === "string" && typeof value.newString === "string" &&
      value.oldString.includes("BEFORE-") && value.newString === value.oldString.replace("BEFORE-", "AFTER-")),
    "edit input must carry OpenChamber oldString/newString");
    assert.equal(edit.state.status, "completed");
    assert.ok(edit.state.metadata.filediff || edit.state.metadata.diff, "edit card must carry diff metadata");
    assert.equal(readFileSync(file, "utf8"), `AFTER-${context.marker}\n`);
    const fresh = (await context.messages(signal)).flatMap((message) => message.parts)
      .filter((part): part is OCToolPart => part.type === "tool" && tools.some((tool) => tool.id === part.id));
    assert.deepEqual(fresh, tools, "fresh HTTP history must retain the same mapped cards and inputs");
  }, { dependsOn: ["idle-reaping"], timeoutMs: 420_000 });
}

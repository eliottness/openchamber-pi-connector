import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { sessionDiff, touchedFiles, type SessionFileDiff } from "../src/session-diff.js";
import { AdapterServer } from "../src/server.js";
import { SessionManager } from "../src/sessions.js";
import { SessionStore } from "../src/session-store.js";
import type { OCEvent, OCMessageWithParts, OCToolPart } from "../src/types.js";
import { V2EventTranslator } from "../src/v2.js";

function temp(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "ocpi-t12-diff-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function tool(filePath: string, name = "edit"): OCToolPart {
  return { type: "tool", id: "part", sessionID: "session", messageID: "message", callID: filePath, tool: name,
    state: { status: "completed", input: { filePath }, output: "", title: "", metadata: {}, time: { start: 0, end: 1 } } };
}

function messages(...paths: string[]): OCMessageWithParts[] {
  return [{ info: { role: "user", id: "message", sessionID: "session", time: { created: 0 }, agent: "OmO",
    model: { providerID: "fake", modelID: "fake" } }, parts: paths.map((path) => tool(path)) }];
}

function git(dir: string, ...args: string[]) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
}

test("HEAD diffs include only touched files, with dirty baseline and current second edit", async (t) => {
  const dir = temp(t);
  git(dir, "init", "-q");
  writeFileSync(join(dir, "tracked.txt"), "one\ntwo\n");
  writeFileSync(join(dir, "unrelated.txt"), "keep\n");
  git(dir, "add", ".");
  git(dir, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "baseline");
  writeFileSync(join(dir, "tracked.txt"), "user dirty\ntwo\n");
  writeFileSync(join(dir, "unrelated.txt"), "unrelated dirty\n");
  writeFileSync(join(dir, "tracked.txt"), "user dirty\nagent first\n");
  writeFileSync(join(dir, "new.txt"), "created\n");
  const history = messages("tracked.txt", join(dir, "new.txt"), "tracked.txt", join(dir, "tracked.txt"));
  const first = await sessionDiff(dir, history);
  assert.equal(first.length, 2);
  assert.equal(first[0]?.before, "one\ntwo\n");
  assert.equal(first[0]?.after, "user dirty\nagent first\n");
  assert.equal(first[0]?.additions, 2);
  assert.equal(first[0]?.deletions, 2);
  assert.match(first[0]?.patch ?? "", /-one[\s\S]*\+user dirty/);
  assert.equal(first[1]?.before, "");
  assert.equal(first[1]?.additions, 1);
  assert.equal(first[1]?.status, "added");
  assert.match(first[1]?.patch ?? "", /\+created/);
  writeFileSync(join(dir, "tracked.txt"), "agent second\n");
  const second = await sessionDiff(dir, history);
  assert.equal(second[0]?.after, "agent second\n");
  assert.equal(second[0]?.additions, 1);
  assert.equal(second[0]?.deletions, 2);
});

test("non-git files list without hunks and escaping paths never disclose contents", async (t) => {
  const base = temp(t);
  const dir = join(base, "work");
  mkdirSync(dir);
  writeFileSync(join(base, "secret"), "secret\n");
  writeFileSync(join(dir, "local"), "local\n");
  symlinkSync(join(base, "secret"), join(dir, "link"));
  const diff = await sessionDiff(dir, messages("local", "../secret", join(base, "secret"), "link"));
  assert.deepEqual(diff.map((d) => d.file), ["local"]);
  assert.equal(diff[0]?.before, "");
  assert.equal(diff[0]?.after, "local\n");
  assert.equal(diff[0]?.patch, "");
  assert.equal(diff[0]?.additions, 0);
});

test("only completed mapped editing tools contribute files", () => {
  const failed = tool("failed");
  failed.state = { status: "error", input: { filePath: "failed" }, error: "", time: { start: 0, end: 1 } };
  assert.deepEqual(touchedFiles([tool("w", "write"), tool("e"), tool("m", "multiedit"), tool("read", "read"), failed]), ["w", "e", "m"]);
});

test("real RPC editing turns emit diff events and both HTTP diff contracts return fresh data", { timeout: 15_000 }, async (t) => {
  const dir = temp(t);
  const prior = { binary: process.env.OCPI_PI_BINARY, state: process.env.OCPI_STATE_DIR, agent: process.env.PI_CODING_AGENT_DIR };
  process.env.OCPI_PI_BINARY = resolve("test/fixtures/diff-omo.mjs");
  process.env.OCPI_STATE_DIR = join(dir, "state");
  process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
  const events: OCEvent[] = [];
  let accept: ((diff: SessionFileDiff[]) => void) | undefined;
  const manager = new SessionManager((_, event) => {
    events.push(structuredClone(event));
    if (event.type === "session.diff") accept?.(event.properties.diff);
  }, new SessionStore(join(dir, "state")), dir);
  const server = new AdapterServer({ host: "127.0.0.1", port: 0, defaultDirectory: dir });
  t.after(async () => {
    await manager.disposeAll();
    await server.stop();
    for (const [key, value] of [["OCPI_PI_BINARY", prior.binary], ["OCPI_STATE_DIR", prior.state], ["PI_CODING_AGENT_DIR", prior.agent]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const info = await manager.create(dir);
  const emitted = new Promise<SessionFileDiff[]>((resolveDiff, reject) => {
    accept = resolveDiff;
    AbortSignal.timeout(5000).addEventListener("abort", () => reject(new Error("no session.diff")), { once: true });
  });
  await manager.prompt(info.id, JSON.stringify([{ path: "edited", content: "RPC content\n" }]));
  assert.equal((await emitted)[0]?.after, "RPC content\n");
  const event = events.find((event) => event.type === "session.diff");
  assert.ok(event);
  assert.equal(new V2EventTranslator().translate(dir, event)[0]?.type, "session.diff");
  await server.start();
  // The fixture transcript is also restorable by a separate server.
  const base = server.url + "/session/" + info.id;
  const response = await fetch(base + "/diff");
  assert.equal(response.status, 200);
  assert.equal((await response.json())[0]?.after, "RPC content\n");
  const alternate = await fetch(server.url + "/api/session/" + info.id + "/diff");
  assert.equal(alternate.status, 200);
  assert.equal((await alternate.json()).data[0]?.after, "RPC content\n");
});

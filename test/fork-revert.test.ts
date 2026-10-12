import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { branchEntries, getEntries } from "../src/session-tree.js";
import { SessionManager } from "../src/sessions.js";
import { SessionStore } from "../src/session-store.js";
import { AdapterServer } from "../src/server.js";

function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "ocpi-t10-"));
  const previous = process.env.OCPI_PI_BINARY;
  process.env.OCPI_PI_BINARY = resolve("test/fixtures/fake-omo.mjs");
  const state = join(dir, "state");
  const manager = new SessionManager(() => undefined, new SessionStore(state), dir);
  t.after(async () => {
    await manager.disposeAll();
    if (previous === undefined) delete process.env.OCPI_PI_BINARY;
    else process.env.OCPI_PI_BINARY = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, state, manager };
}

async function turns(manager: SessionManager, dir: string) {
  const session = await manager.create(dir);
  for (let i = 1; i <= 3; i++) await manager.prompt(session.id, `turn-${i}`, undefined, false, `msg_live_${i}`);
  const s = manager.get(session.id);
  assert.ok(s?.pi);
  return { s, id: session.id, tree: await getEntries(s.pi) };
}

test("fork stops before the selected live user and transfers the process away from the source", async (t) => {
  const { manager, dir } = setup(t);
  const { s, id } = await turns(manager, dir);
  const sourcePath = s.piPath;
  const child = await manager.fork(id, "msg_live_2");
  assert.notEqual(child.id, id);
  assert.equal(s.pi, undefined);
  assert.equal(s.piPath, sourcePath);
  assert.deepEqual(manager.messages(child.id)?.filter((m) => m.info.role === "user").map((m) => m.parts[0]?.type === "text" ? m.parts[0].text : ""), ["turn-1"]);
  assert.equal(manager.messages(child.id)?.at(-1)?.info.role, "assistant");
  await manager.prompt(id, "source-only");
  assert.ok(s.pi);
  const source = branchEntries(await getEntries(s.pi));
  assert.equal(source.filter((entry) => entry.message?.role === "user").length, 4);
  const fork = manager.get(child.id);
  assert.ok(fork?.pi);
  assert.equal(branchEntries(await getEntries(fork.pi)).filter((entry) => entry.message?.role === "user").length, 1);
});

test("fork without messageID copies the complete leaf including the final reply", async (t) => {
  const { manager, dir } = setup(t);
  const { id } = await turns(manager, dir);
  const before = manager.messages(id)?.length;
  const child = await manager.fork(id);
  assert.equal(manager.messages(child.id)?.length, before);
  assert.equal(manager.messages(child.id)?.at(-1)?.info.role, "assistant");
});

test("revert navigates before the user without changing a working file and unrevert restores the exact leaf", async (t) => {
  const { manager, dir } = setup(t);
  const { s, id, tree } = await turns(manager, dir);
  const file = join(dir, "f.txt");
  writeFileSync(file, "not reverted");
  const original = readFileSync(file);
  const parent = tree.entries.find((entry) => entry.id === s.tree.messageEntries.msg_live_3)?.parentId;
  await manager.revert(id, "msg_live_3");
  assert.deepEqual(s.info.revert, { messageID: "msg_live_3" });
  assert.ok(s.pi);
  assert.equal((await getEntries(s.pi)).leafId, parent);
  assert.deepEqual(readFileSync(file), original);
  assert.equal(manager.messages(id)?.filter((m) => m.info.id.startsWith("msg_revert_")).length, 1);
  assert.equal(manager.messages(id)?.find((m) => m.info.id.startsWith("msg_revert_"))?.info.role, "assistant");
  const notice = manager.messages(id)?.find((m) => m.info.id.startsWith("msg_revert_"))?.info;
  assert.ok(notice?.role === "assistant");
  assert.equal(notice.parentID, "msg_live_2");
  await manager.revert(id, "msg_live_3");
  await manager.revert(id, "msg_live_2");
  await manager.unrevert(id);
  assert.equal((await getEntries(s.pi)).leafId, tree.leafId);
  assert.equal(s.info.revert, undefined);
  assert.equal(manager.messages(id)?.length, 6);
  await manager.unrevert(id);
  assert.equal((await getEntries(s.pi)).leafId, tree.leafId);
});

test("restart retains live ids and reverted transcript then a prompt branches from the saved parent", async (t) => {
  const { manager, dir, state } = setup(t);
  const { id } = await turns(manager, dir);
  await manager.revert(id, "msg_live_3");
  const saved = manager.get(id)?.tree.revert;
  await manager.disposeAll();
  const restarted = new SessionManager(() => undefined, new SessionStore(state), dir);
  t.after(() => restarted.disposeAll());
  assert.deepEqual(restarted.get(id)?.info.revert, { messageID: "msg_live_3" });
  assert.ok(restarted.messages(id)?.some((m) => m.info.id === "msg_live_3"));
  await restarted.prompt(id, "replacement", undefined, false, "msg_replacement");
  const s = restarted.get(id);
  assert.ok(s?.pi);
  const tree = await getEntries(s.pi);
  const active = branchEntries(tree);
  assert.equal(active.filter((e) => e.message?.role === "user").length, 3);
  assert.equal(active.some((e) => e.message?.content?.[0]?.text === "turn-3"), false);
  assert.ok(tree.entries.some((e) => e.message?.content?.[0]?.text === "turn-3"));
  assert.equal(tree.entries.find((e) => e.id === s.tree.messageEntries.msg_replacement)?.parentId, saved?.targetId);
  assert.equal(s.info.revert, undefined);
});

test("restored offset ids support fork and reverting the first root message", async (t) => {
  const { manager, dir, state } = setup(t);
  const { id, s } = await turns(manager, dir);
  const path = s.piPath;
  assert.ok(path);
  await manager.disposeAll();
  const store = new SessionStore(state);
  const entry = store.get(id);
  assert.ok(entry);
  store.set(id, { ...entry, tree: { messageEntries: {} } });
  const restored = new SessionManager(() => undefined, new SessionStore(state), dir);
  t.after(() => restored.disposeAll());
  const first = restored.messages(id)?.find((m) => m.info.role === "user");
  assert.ok(first);
  assert.ok(first.info.id.startsWith(`msg_${id}_r`));
  await restored.revert(id, first.info.id);
  assert.equal(restored.get(id)?.tree.leafId, null);
  await restored.unrevert(id);
  const child = await restored.fork(id, first.info.id);
  assert.equal(restored.messages(child.id)?.length, 0);
});

test("unknown and malformed messageIDs return 400 without changing session or tree", async (t) => {
  const { dir } = setup(t);
  const previous = process.env.OCPI_STATE_DIR;
  process.env.OCPI_STATE_DIR = join(dir, "http-state");
  const server = new AdapterServer({ port: 0, host: "127.0.0.1", defaultDirectory: dir });
  t.after(async () => {
    await server.stop();
    if (previous === undefined) delete process.env.OCPI_STATE_DIR;
    else process.env.OCPI_STATE_DIR = previous;
  });
  await server.start();
  const created = await fetch(`${server.url}/session`, { method: "POST" });
  const session = await created.json() as { id: string };
  const url = `${server.url}/session/${session.id}`;
  const before = await (await fetch(url)).json();
  for (const body of [{ messageID: "nope" }, {}, { messageID: 12 }]) {
    const response = await fetch(`${url}/revert`, { method: "POST", body: JSON.stringify(body) });
    assert.equal(response.status, 400);
    const error = await response.json() as { data: { message: string } };
    assert.ok(error.data.message.length > 0);
  }
  assert.deepEqual(await (await fetch(url)).json(), before);
  const redo = await fetch(`${url}/unrevert`, { method: "POST" });
  assert.equal(redo.status, 200);
});

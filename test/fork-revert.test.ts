import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { bindMessageEntries, branchEntries, getEntries } from "../src/session-tree.js";
import { SessionManager, type ManagedSession } from "../src/sessions.js";
import { SessionStore } from "../src/session-store.js";
import { AdapterServer } from "../src/server.js";
import { announceSessionNotice, completeShellMessage, createShellMessage, failShellMessage, runShellCommand, shellUserMessage } from "../src/session-commands.js";
import type { PiRpcClient } from "../src/pi-rpc.js";

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

async function cancelQueuedShell(t: TestContext, manager: SessionManager, session: ManagedSession, command: string) {
  const pi = session.pi;
  assert.ok(pi);
  const held = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  t.after(() => release.resolve());
  const original = pi.command.bind(pi);
  let hold = true;
  t.mock.method(pi, "command", async <T>(...args: Parameters<PiRpcClient["command"]>) => {
    const response = await original<T>(...args);
    if (args[0].type === "get_entries" && hold) {
      hold = false;
      held.resolve();
      await release.promise;
    }
    return response;
  });
  const refresh = manager.reloadMessages(session.info.id);
  await held.promise;
  try {
    const pending = runShellCommand({ sessions: manager, session, command, emit: () => {} });
    await manager.abort(session.info.id);
    const cancelled = await pending;
    assert.equal(cancelled.kind, "completed");
    return cancelled.message;
  } finally {
    release.resolve();
    await refresh;
    await manager.reloadMessages(session.info.id);
  }
}

test("shell identity is durable while a persisted native response is held", { timeout: 30_000 }, async (t) => {
  const { manager, dir, state } = setup(t);
  const { s, id } = await turns(manager, dir);
  assert.ok(s.pi);
  const held = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const original = s.pi.command.bind(s.pi);
  t.mock.method(s.pi, "command", async <T>(...args: Parameters<PiRpcClient["command"]>) => {
    const response = await original<T>(...args);
    if (args[0].type === "bash") {
      held.resolve();
      await release.promise;
    }
    return response;
  });
  const pending = runShellCommand({ sessions: manager, session: s, command: "echo restarted", emit: () => {} });
  try {
    await held.promise;
    const live = s.messages?.at(-1);
    assert.ok(live?.info.role === "assistant");
    const disk = new SessionStore(state).get(id);
    assert.equal(disk?.tree?.shellDispatch?.[live.info.id], true, "dispatch must be on disk before refresh");
    assert.ok(disk.tree.localShellTurns?.some((turn) => turn.messages[1].info.id === live.info.id));
    const cold = new SessionManager(() => {}, new SessionStore(state), dir);
    t.after(() => cold.disposeAll());
    const restored = cold.messages(id)?.find((message) => message.info.id === live.info.id);
    assert.ok(restored?.parts[0]?.type === "tool" && restored.parts[0].state.status === "completed");
    assert.equal(restored.parts[0].state.output, "restarted\n");
    assert.equal(restored.info.role === "assistant" && restored.info.parentID, live.info.parentID);
    assert.ok(cold.get(id)?.tree.messageEntries[live.info.id]);
  } finally {
    release.resolve();
    await pending;
  }
});

test("a cold restore keeps a running shell identity without inventing a native result", { timeout: 30_000 }, async (t) => {
  const { manager, dir, state } = setup(t);
  const { s, id } = await turns(manager, dir);
  assert.ok(s.pi);
  execFileSync("mkfifo", [join(dir, "restart-gate")]);
  const started = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<void>();
  s.pi.onEvent((event) => {
    if (event.type === "fake_bash_started") started.resolve();
    if (event.type === "fake_bash_finished") finished.resolve();
  });
  const pending = runShellCommand({ sessions: manager, session: s, command: "IFS= read -r gate < restart-gate; echo restarted", emit: () => {} });
  try {
    await started.promise;
    const live = s.messages?.at(-1);
    assert.ok(live?.info.role === "assistant");
    assert.equal(new SessionStore(state).get(id)?.tree?.shellDispatch?.[live.info.id], true);
    const cold = new SessionManager(() => {}, new SessionStore(state), dir);
    t.after(() => cold.disposeAll());
    const restored = cold.messages(id)?.find((message) => message.info.id === live.info.id);
    assert.ok(restored?.parts[0]?.type === "tool" && restored.parts[0].state.status === "error");
    assert.equal(restored.parts[0].state.metadata?.interrupted, true);
    assert.equal(cold.get(id)?.tree.messageEntries[live.info.id], undefined);
    assert.ok(new SessionStore(state).get(id)?.tree?.localShellTurns?.some((turn) => turn.messages[1].info.id === live.info.id));
  } finally {
    await manager.abort(id);
    await pending;
    await finished.promise;
  }
});

test("local shell custom anchors restore after their nearest rendered native ancestor", async (t) => {
  const { manager, dir, state } = setup(t);
  const { s, id } = await turns(manager, dir);
  const cancelled = await cancelQueuedShell(t, manager, s, "echo custom-anchor");
  assert.ok(s.piPath);
  const parentId = s.tree.leafId;
  await manager.disposeAll();
  const store = new SessionStore(state);
  const reg = store.get(id);
  const local = reg?.tree?.localShellTurns?.[0];
  assert.ok(reg?.tree && local);
  const custom = { type: "custom", id: "non_rendered_stop_state", parentId, customType: "senpi.hooks.stop-state", timestamp: Date.now() };
  writeFileSync(s.piPath, readFileSync(s.piPath, "utf8") + JSON.stringify(custom) + "\n");
  local.afterEntryId = custom.id;
  reg.tree.leafId = custom.id;
  store.set(id, reg);
  const cold = new SessionManager(() => {}, new SessionStore(state), dir);
  t.after(() => cold.disposeAll());
  const history = cold.messages(id);
  assert.equal(history?.[0]?.info.id, "msg_live_1");
  assert.deepEqual(history?.slice(-2).map((message) => message.info.id), [cancelled.info.parentID, cancelled.info.id]);
  assert.equal(history?.length, 8);
});

test("shutdown marks an active shell interrupted rather than rejected", { timeout: 30_000 }, async (t) => {
  const { manager, dir, state } = setup(t);
  const { s, id } = await turns(manager, dir);
  assert.ok(s.pi);
  execFileSync("mkfifo", [join(dir, "shutdown-gate")]);
  const started = Promise.withResolvers<void>();
  s.pi.onEvent((event) => { if (event.type === "fake_bash_started") started.resolve(); });
  const pending = runShellCommand({ sessions: manager, session: s, command: "IFS= read -r gate < shutdown-gate; echo done", emit: () => {} })
    .then((result) => ({ result }), (error: unknown) => ({ error }));
  await started.promise;
  const shellID = s.messages?.at(-1)?.info.id;
  await manager.disposeAll();
  const outcome = await pending;
  assert.ok("result" in outcome && outcome.result.kind === "completed");
  const cold = new SessionManager(() => {}, new SessionStore(state), dir);
  t.after(() => cold.disposeAll());
  const restored = cold.messages(id)?.find((message) => message.info.id === shellID);
  assert.ok(restored?.parts[0]?.type === "tool");
  assert.ok(restored.parts[0].state.status === "completed" ||
    (restored.parts[0].state.status === "error" && (restored.parts[0].state.metadata?.interrupted === true || restored.parts[0].state.metadata?.cancelled === true)));
});

test("a replacement prompt prunes abandoned local shell identities through reload and restart", async (t) => {
  const { manager, dir, state } = setup(t);
  const { s, id } = await turns(manager, dir);
  const cancelled = await cancelQueuedShell(t, manager, s, "echo discarded");
  await manager.revert(id, "msg_live_2");
  assert.equal(s.tree.localShellTurns?.length, 1, "revert alone retains redo");
  await manager.prompt(id, "replacement", undefined, false, "msg_replacement");
  const retained = () => manager.messages(id)?.some((message) => message.info.id === cancelled.info.id);
  assert.equal(retained(), false);
  await manager.reloadMessages(id);
  assert.equal(retained(), false, "reload must not resurrect the abandoned pair");
  assert.equal(new SessionStore(state).get(id)?.tree?.localShellTurns?.length ?? 0, 0);
  assert.equal(s.tree.shellDispatch?.[cancelled.info.id], undefined);
  await manager.disposeAll();
  const cold = new SessionManager(() => {}, new SessionStore(state), dir);
  t.after(() => cold.disposeAll());
  assert.equal(cold.messages(id)?.some((message) => message.info.id === cancelled.info.id), false);
  assert.equal(cold.messages(id)?.[0]?.info.id, "msg_live_1");
});

test("forks copy only local shell turns on their native path with child identities", async (t) => {
  const { manager, dir, state } = setup(t);
  const info = await manager.create(dir);
  const s = manager.get(info.id);
  assert.ok(s);
  await manager.prompt(info.id, "one", undefined, false, "msg_one");
  const first = await cancelQueuedShell(t, manager, s, "echo local-one");
  await manager.prompt(info.id, "two", undefined, false, "msg_two");
  await cancelQueuedShell(t, manager, s, "echo local-two");
  const child = await manager.fork(info.id, "msg_two");
  const local = manager.messages(child.id)?.filter((message) => message.parts.some((part) => part.type === "tool" && part.tool === "bash"));
  assert.equal(local?.length, 1);
  const copied = local?.[0];
  assert.ok(copied?.parts[0]?.type === "tool");
  assert.equal(copied.parts[0].state.input.command, "echo local-one");
  assert.notEqual(copied.info.id, first.info.id);
  assert.ok(copied.parts.every((part) => part.sessionID === child.id && part.messageID === copied.info.id));
  assert.equal(manager.get(child.id)?.tree.shellDispatch?.[copied.info.id], false);
  await manager.disposeAll();
  const cold = new SessionManager(() => {}, new SessionStore(state), dir);
  t.after(() => cold.disposeAll());
  assert.ok(cold.messages(child.id)?.some((message) => message.info.id === copied.info.id));
  assert.equal(cold.messages(info.id)?.filter((message) => message.parts.some((part) => part.type === "tool" && part.tool === "bash")).length, 2);
});

test("a never-dispatched cancelled shell cannot claim an identical successful run", { timeout: 30_000 }, async (t) => {
  const { manager, dir, state } = setup(t);
  const info = await manager.create(dir);
  await manager.prompt(info.id, "before", undefined, false, "msg_before");
  const session = manager.get(info.id);
  assert.ok(session?.pi);
  const cancelled = await cancelQueuedShell(t, manager, session, "echo repeated");
  const completed = await runShellCommand({ sessions: manager, session, command: "echo repeated", emit: () => {} });
  assert.equal(completed.kind, "completed");
  const entries = (await getEntries(session.pi)).entries.filter((entry) => entry.message?.role === "bashExecution");
  assert.equal(entries.length, 1);
  assert.equal(session.tree.messageEntries[cancelled.info.id], undefined, "the never-dispatched cancellation must remain unbound");
  assert.equal(session.tree.messageEntries[cancelled.info.parentID], undefined);
  assert.equal(session.tree.messageEntries[completed.message.info.id], entries[0]?.id);
  assert.equal(session.tree.messageEntries[completed.message.info.parentID], entries[0]?.id);
  await manager.reloadMessages(info.id);
  const cards = manager.messages(info.id)?.filter((message) => message.parts.some((part) => part.type === "tool" && part.tool === "bash"));
  assert.deepEqual(cards?.map((message) => message.info.id), [cancelled.info.id, completed.message.info.id]);
  assert.equal(cards?.[0]?.parts[0]?.type === "tool" && cards[0].parts[0].state.status, "error");
  assert.equal(cards?.[1]?.parts[0]?.type === "tool" && cards[1].parts[0].state.status, "completed");
  await manager.fork(info.id, completed.message.info.id);
  await manager.disposeAll();
  const restored = new SessionManager(() => {}, new SessionStore(state), dir);
  t.after(() => restored.disposeAll());
  const restarted = restored.messages(info.id)?.filter((message) => message.parts.some((part) => part.type === "tool" && part.tool === "bash"));
  assert.deepEqual(restarted?.map((message) => message.info.id), [cancelled.info.id, completed.message.info.id]);
  assert.equal(restarted?.[0]?.parts[0]?.type === "tool" && restarted[0].parts[0].state.status, "error");
  assert.equal(restarted?.[1]?.parts[0]?.type === "tool" && restarted[1].parts[0].state.status, "completed");
  await restored.revert(info.id, completed.message.info.parentID);
  await restored.unrevert(info.id);
  await restored.fork(info.id, completed.message.info.id);
});

test("identical shell commands retain mixed cancellation outcomes and distinct tree boundaries", { timeout: 30_000 }, async (t) => {
  const { manager, dir, state } = setup(t);
  const info = await manager.create(dir);
  await manager.prompt(info.id, "before", undefined, false, "msg_before");
  const session = manager.get(info.id);
  assert.ok(session?.pi);
  const command = "if [ ! -f allow-shell ]; then IFS= read -r gate < shell-gate; fi; echo repeated";
  execFileSync("mkfifo", [join(dir, "shell-gate")]);
  const queued = await cancelQueuedShell(t, manager, session, command);
  const started = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<void>();
  const onEvent = (event: Record<string, unknown>) => {
    if (event.type === "fake_bash_started") started.resolve();
    if (event.type === "fake_bash_finished") finished.resolve();
  };
  session.pi.onEvent(onEvent);
  const pending = runShellCommand({ sessions: manager, session, command, emit: () => {} });
  await started.promise;
  await manager.abort(info.id);
  const cancelled = await pending;
  assert.equal(cancelled.kind, "completed");
  await finished.promise;
  session.pi.off("event", onEvent);
  await manager.reloadMessages(info.id);
  writeFileSync(join(dir, "allow-shell"), "");
  const successful = [];
  for (let i = 0; i < 2; i++) {
    const result = await runShellCommand({ sessions: manager, session, command, emit: () => {} });
    assert.equal(result.kind, "completed");
    successful.push(result.message);
  }
  const dispatched = [cancelled.message, ...successful];
  const identities = [queued, ...dispatched].map((message) => message.info.id);
  const tree = await getEntries(session.pi);
  const native = tree.entries.filter((entry) => entry.message?.role === "bashExecution");
  assert.equal(native.length, 3);
  assert.equal(session.tree.messageEntries[queued.info.id], undefined);
  for (const [index, message] of dispatched.entries()) {
    assert.equal(session.tree.messageEntries[message.info.id], native[index]?.id);
    assert.equal(session.tree.messageEntries[message.info.parentID], native[index]?.id);
  }
  await manager.reloadMessages(info.id);
  const cards = manager.messages(info.id)?.filter((message) => message.parts.some((part) => part.type === "tool" && part.tool === "bash"));
  assert.deepEqual(cards?.map((message) => message.info.id), identities);
  assert.deepEqual(cards?.map((message) => message.parts[0]?.type === "tool" && message.parts[0].state.status), ["error", "error", "completed", "completed"]);
  for (const message of dispatched) {
    await manager.revert(info.id, message.info.parentID);
    assert.equal(session.tree.leafId, native.find((entry) => entry.id === session.tree.messageEntries[message.info.id])?.parentId);
    await manager.unrevert(info.id);
    await manager.fork(info.id, message.info.id);
  }
  await manager.disposeAll();
  const restored = new SessionManager(() => {}, new SessionStore(state), dir);
  t.after(() => restored.disposeAll());
  const restarted = restored.messages(info.id)?.filter((message) => message.parts.some((part) => part.type === "tool" && part.tool === "bash"));
  assert.deepEqual(restarted?.map((message) => message.info.id), identities);
  assert.deepEqual(restarted?.map((message) => message.parts[0]?.type === "tool" && message.parts[0].state.status), ["error", "error", "completed", "completed"]);
  for (const message of dispatched) {
    await restored.revert(info.id, message.info.parentID);
    await restored.unrevert(info.id);
    await restored.fork(info.id, message.info.id);
  }
});

test("shell binding rejects conflicting outcomes, undispatched cards and reused entry bindings", async (t) => {
  const { manager, dir } = setup(t);
  const info = await manager.create(dir);
  const session = manager.get(info.id);
  assert.ok(session);
  for (const conflict of ["output", "exitCode", "cancelled", "undispatched", "bound"]) {
    const wrong = createShellMessage(session, "echo repeated");
    const correct = createShellMessage(session, "echo repeated");
    const result = { output: "repeated\n", exitCode: 0, cancelled: false, truncated: false };
    completeShellMessage(wrong, "echo repeated", {
      ...result, ...(conflict === "output" ? { output: "other\n" } : {}), ...(conflict === "exitCode" ? { exitCode: 7 } : {}),
    });
    if (conflict === "cancelled") failShellMessage(wrong, "echo repeated", "Command cancelled", { cancelled: true });
    completeShellMessage(correct, "echo repeated", result);
    session.messages = [shellUserMessage(wrong), wrong, shellUserMessage(correct), correct];
    Object.assign(session.tree, { messageEntries: {}, shellDispatch: { [wrong.info.id]: conflict !== "undispatched", [correct.info.id]: true } });
    if (conflict === "bound") session.tree.messageEntries[wrong.info.id] = "another_entry";
    bindMessageEntries(session, { entries: [{
      type: "message", id: "expected_entry", parentId: null,
      message: { role: "bashExecution", command: "echo repeated", ...result },
    }], leafId: "expected_entry" });
    assert.equal(session.tree.messageEntries[wrong.info.id], conflict === "bound" ? "another_entry" : undefined, conflict);
    assert.equal(session.tree.messageEntries[correct.info.id], "expected_entry", conflict);
  }
});

test("an established shell binding takes precedence over an earlier identical candidate", async (t) => {
  const { manager, dir } = setup(t);
  const info = await manager.create(dir);
  const session = manager.get(info.id);
  assert.ok(session);
  const earlier = createShellMessage(session, "echo repeated");
  const known = createShellMessage(session, "echo repeated");
  const result = { output: "repeated\n", exitCode: 0, cancelled: false, truncated: false };
  for (const message of [earlier, known]) completeShellMessage(message, "echo repeated", result);
  session.messages = [shellUserMessage(earlier), earlier, shellUserMessage(known), known];
  Object.assign(session.tree, { shellDispatch: { [earlier.info.id]: true, [known.info.id]: true } });
  session.tree.messageEntries[known.info.id] = "known_entry";
  session.tree.messageEntries[known.info.parentID] = "known_entry";
  bindMessageEntries(session, { entries: [{
    type: "message", id: "known_entry", parentId: null,
    message: { role: "bashExecution", command: "echo repeated", ...result },
  }], leafId: "known_entry" });
  assert.equal(session.tree.messageEntries[earlier.info.id], undefined);
  assert.equal(session.tree.messageEntries[earlier.info.parentID], undefined);
  assert.equal(session.tree.messageEntries[known.info.id], "known_entry");
  assert.equal(session.tree.messageEntries[known.info.parentID], "known_entry");
});

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

test("persisted shell cards retain live ids through reload, fork and revert boundaries", async (t) => {
  const { manager, dir, state } = setup(t);
  const { id } = await turns(manager, dir);
  const session = { id };
  const s = manager.get(id);
  assert.ok(s?.pi);
  const result = await runShellCommand({ sessions: manager, session: s, command: "echo bash-boundary", emit: () => {} });
  assert.equal(result.kind, "completed");
  const shellID = result.message.info.id;
  const shellUserID = result.message.info.parentID;
  assert.ok(shellUserID < shellID, "live shell IDs must preserve user-before-assistant order");
  assert.equal(manager.messages(session.id)?.length, 8, "refresh must not duplicate the live shell pair");
  const entryID = s.tree.messageEntries[shellID];
  assert.ok(entryID);
  assert.equal(s.tree.messageEntries[shellUserID], entryID);
  await manager.prompt(session.id, "after-shell", undefined, false, "msg_after_shell");
  await manager.revert(session.id, "msg_after_shell");
  assert.equal(s.tree.leafId, entryID, "revert must navigate to the preceding shell entry");
  await manager.unrevert(session.id);
  const beforeShell = (await getEntries(s.pi)).entries.find((entry) => entry.id === entryID)?.parentId;
  await manager.revert(session.id, shellUserID);
  assert.equal(s.tree.leafId, beforeShell);
  await manager.unrevert(session.id);
  await manager.reloadMessages(session.id);
  assert.equal(manager.messages(session.id)?.filter((m) => m.info.id === shellID).length, 1);
  await manager.disposeAll();
  const restored = new SessionManager(() => {}, new SessionStore(state), dir);
  t.after(() => restored.disposeAll());
  const shell = restored.messages(session.id)?.find((m) => m.info.id === shellID);
  assert.ok(shell?.parts[0]?.type === "tool" && shell.parts[0].state.status === "completed");
  const fork = await restored.fork(session.id, shellID);
  const forked = restored.messages(fork.id);
  assert.equal(forked?.length, 8);
  assert.ok(forked?.at(-1)?.parts[0]?.type === "tool");
  const before = await restored.fork(session.id, shellUserID);
  assert.equal(restored.messages(before.id)?.length, 6, "forking a shell user boundary must exclude the shell turn");
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

test("compaction preserves the active revert leaf and original history across refresh and restart", async (t) => {
  const { manager, dir, state } = setup(t);
  const { s, id, tree } = await turns(manager, dir);
  await manager.revert(id, "msg_live_3");
  const pinnedLeaf = s.tree.leafId;
  const revert = { ...s.tree.revert };
  const response = await manager.sessionRpc(id, { type: "compact" });
  assert.equal(response.success, true);
  assert.equal(s.tree.leafId, pinnedLeaf);
  assert.deepEqual(s.tree.revert, revert);
  assert.ok(s.pi);
  assert.equal((await getEntries(s.pi)).leafId, pinnedLeaf);
  assert.doesNotMatch(JSON.stringify(manager.messages(id)), /Compacted summary/);
  await manager.disposeAll();

  const restarted = new SessionManager(() => undefined, new SessionStore(state), dir);
  t.after(() => restarted.disposeAll());
  assert.equal(restarted.get(id)?.tree.leafId, pinnedLeaf);
  assert.deepEqual(restarted.get(id)?.tree.revert, revert);
  assert.ok(restarted.messages(id)?.some((message) => message.info.id === "msg_live_3"));
  await restarted.unrevert(id);
  const restored = restarted.get(id);
  assert.ok(restored?.pi);
  assert.equal((await getEntries(restored.pi)).leafId, tree.leafId);
  assert.doesNotMatch(JSON.stringify(restarted.messages(id)), /Compacted summary/);
});

test("F2 B1 history refresh waits for an in-flight unrevert and agrees with the backend", { timeout: 10_000 }, async (t) => {
  const { manager, dir } = setup(t);
  const { s, id, tree } = await turns(manager, dir);
  await manager.revert(id, "msg_live_3");
  assert.ok(s.pi);
  const pi = s.pi;
  const command = pi.command.bind(pi);
  const dispatched = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let reads = 0;
  pi.command = async <T>(...args: Parameters<PiRpcClient["command"]>) => {
    if (args[0].type === "get_entries") reads++;
    const response = await command<T>(...args);
    if (args[0].type === "navigate_tree" && args[0].targetId === tree.leafId) {
      dispatched.resolve();
      await release.promise;
    }
    return response;
  };
  const redo = manager.unrevert(id);
  await dispatched.promise;
  const refresh = manager.reloadMessages(id);
  try {
    assert.equal(reads, 0, "refresh must not dispatch get_entries while unrevert navigation is pending");
  } finally {
    release.resolve();
    await Promise.all([redo, refresh]);
    pi.command = command;
  }
  const reported = await redo;
  assert.equal(reported.revert, undefined);
  assert.equal(s.tree.revert, undefined);
  assert.equal(s.tree.leafId, tree.leafId);
  assert.equal((await getEntries(pi)).leafId, s.tree.leafId);
});

test("F2 B2 shell cards and notices created after revert remain in rendered history", { timeout: 10_000 }, async (t) => {
  const { manager, dir } = setup(t);
  const { s, id } = await turns(manager, dir);
  await manager.revert(id, "msg_live_3");
  const result = await runShellCommand({ sessions: manager, session: s, command: "echo F2_SHELL_OK", emit: () => undefined });
  assert.equal(result.kind, "completed");
  announceSessionNotice({ sessions: manager, session: s, emit: () => undefined }, "F2_NOTICE");
  const shellId = result.message.info.id;
  assert.equal(result.message.info.parentID, `${result.message.info.id.slice(0, -1)}u`);
  const noticeId = s.messages?.find((message) => message.parts.some((part) => part.type === "text" && part.text === "F2_NOTICE"))?.info.id;
  assert.ok(noticeId, "notice must be appended to canonical history");
  const retained = () => {
    const history = manager.messages(id) ?? [];
    assert.equal(history.filter((message) => message.info.id === shellId).length, 1);
    assert.equal(history.filter((message) => message.info.id === noticeId).length, 1);
    assert.equal(history.find((message) => message.info.id === shellId)?.parts[0]?.type, "tool");
    if (s.tree.revert) {
      assert.ok(history.findIndex((message) => message.info.id === shellId) <
        history.findIndex((message) => message.info.id === s.tree.revert?.messageID), "shell must precede the UI cutoff");
    }
  };
  retained();
  await manager.reloadMessages(id);
  retained();
  await manager.unrevert(id);
  retained();
  await manager.revert(id, "msg_live_3");
  await manager.prompt(id, "replacement", undefined, false, "msg_replacement");
  retained();
  await manager.reloadMessages(id);
  retained();
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

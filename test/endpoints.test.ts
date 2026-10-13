import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { AdapterServer } from "../src/server.js";

const fakeRpc = resolve("test/fixtures/fake-omo-endpoints.mjs");
const unsupportedShare = { name: "BadRequestError", data: { message: "Sharing is not available with OmO" } };

type TestEvent = { type: string; properties?: Record<string, unknown> };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

function startEvents(url: string) {
  const controller = new AbortController();
  const events = new EventEmitter();
  const history: TestEvent[] = [];

  const ready = fetch(`${url}/event`, { signal: controller.signal }).then(async (response) => {
    assert.equal(response.status, 200);
    assert.ok(response.body);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    void (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        for (;;) {
          const end = buffer.indexOf("\n\n");
          if (end < 0) break;
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = frame.split("\n").find((line) => line.startsWith("data: "));
          if (data === undefined) continue;
          const parsed: unknown = JSON.parse(data.slice(6));
          if (!isRecord(parsed) || typeof parsed.type !== "string") continue;
          const event: TestEvent = {
            type: parsed.type,
            ...(isRecord(parsed.properties) ? { properties: parsed.properties } : {}),
          };
          history.push(event);
          events.emit(event.type, event);
        }
      }
    })().catch((error: unknown) => {
      if (!controller.signal.aborted) throw error;
    });
  });

  return {
    ready,
    close: () => controller.abort(),
    waitFor(type: string, predicate: (event: TestEvent) => boolean): Promise<TestEvent> {
      const existing = history.find((event) => event.type === type && predicate(event));
      if (existing !== undefined) return Promise.resolve(existing);
      return new Promise((resolveEvent, rejectEvent) => {
        const timeout = AbortSignal.timeout(10_000);
        const onTimeout = (): void => {
          events.off(type, onEvent);
          rejectEvent(new Error(`timed out waiting for ${type}`));
        };
        const onEvent = (event: TestEvent): void => {
          if (!predicate(event)) return;
          events.off(type, onEvent);
          resolveEvent(event);
        };
        timeout.addEventListener("abort", onTimeout, { once: true });
        events.on(type, onEvent);
      });
    },
  };
}

async function startServer(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "ocpi-t11-"));
  const previousBinary = process.env.OCPI_PI_BINARY;
  const previousState = process.env.OCPI_STATE_DIR;
  process.env.OCPI_PI_BINARY = fakeRpc;
  process.env.OCPI_STATE_DIR = join(directory, "state");
  const server = new AdapterServer({ host: "127.0.0.1", port: 0, defaultDirectory: directory });
  t.after(async () => {
    await server.stop();
    if (previousBinary === undefined) delete process.env.OCPI_PI_BINARY;
    else process.env.OCPI_PI_BINARY = previousBinary;
    if (previousState === undefined) delete process.env.OCPI_STATE_DIR;
    else process.env.OCPI_STATE_DIR = previousState;
    rmSync(directory, { recursive: true, force: true });
  });
  await server.start();
  return { url: server.url, directory, server };
}

async function createSession(url: string): Promise<string> {
  const response = await fetch(`${url}/session`, { method: "POST", body: "{}" });
  assert.equal(response.status, 200);
  const session: unknown = await response.json();
  assert.ok(isRecord(session));
  if (typeof session.id !== "string") throw new Error("session id missing from create response");
  return session.id;
}

async function sendPrompt(url: string, sessionId: string, text: string): Promise<void> { assert.equal((await fetch(`${url}/session/${sessionId}/message`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ parts: [{ type: "text", text }] }) })).status, 200); }

test("command catalog maps OmO commands for v1 and v2", { timeout: 30_000 }, async (t) => {
  const { url, directory } = await startServer(t);
  const expected = [{ name: "fixture", description: "Fixture command", template: "" }];

  const v1 = await fetch(`${url}/command`);
  assert.equal(v1.status, 200);
  assert.deepEqual(await v1.json(), expected);

  const v2 = await fetch(`${url}/api/command`);
  assert.equal(v2.status, 200);
  assert.deepEqual(await v2.json(), { location: { directory }, data: expected });
});

test("slash command routes prompt OmO and reject an empty command", { timeout: 30_000 }, async (t) => {
  const { url } = await startServer(t);
  const sessionId = await createSession(url);

  const empty = await fetch(`${url}/session/${sessionId}/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command: "", arguments: "" }),
  });
  assert.equal(empty.status, 400);

  const v1 = await fetch(`${url}/session/${sessionId}/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command: "missing-command", arguments: "one" }),
  });
  assert.equal(v1.status, 200);
  assert.match(JSON.stringify(await v1.json()), /\/missing-command one/);

  const v2 = await fetch(`${url}/api/session/${sessionId}/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command: "another-missing-command", arguments: "two" }),
  });
  assert.equal(v2.status, 200);
  assert.match(JSON.stringify(await v2.json()), /\/another-missing-command two/);
});

test("shell route emits a bash card with output and exit code", { timeout: 30_000 }, async (t) => {
  const { url } = await startServer(t);
  const sessionId = await createSession(url);
  const stream = startEvents(url);
  t.after(stream.close);
  await stream.ready;

  const assistantUpdated = stream.waitFor(
    "message.updated",
    (event) => JSON.stringify(event).includes(`"sessionID":"${sessionId}"`),
  );
  const completedPart = stream.waitFor(
    "message.part.updated",
    (event) => JSON.stringify(event).includes('"tool":"bash"') && JSON.stringify(event).includes('"status":"completed"'),
  );
  const response = await fetch(`${url}/session/${sessionId}/shell`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command: "exit 3" }),
  });
  assert.equal(response.status, 200);
  assert.match(JSON.stringify(await response.json()), /"role":"assistant"/);
  const [messageEvent, partEvent] = await Promise.all([assistantUpdated, completedPart]);
  assert.match(JSON.stringify(messageEvent), /assistant/);
  assert.match(JSON.stringify(partEvent), /SHELL_OUTPUT/);
  assert.match(JSON.stringify(partEvent), /"exitCode":3/);

  const v2CompletedPart = stream.waitFor(
    "message.part.updated",
    (event) => JSON.stringify(event).includes('"exitCode":4'),
  );
  const v2 = await fetch(`${url}/api/session/${sessionId}/shell`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command: "exit 4", agent: "OmO" }),
  });
  assert.equal(v2.status, 200);
  assert.match(JSON.stringify(await v2.json()), /"exitCode":4/);
  await v2CompletedPart;
});

test("slash command refreshes entries persisted without agent events", { timeout: 30_000 }, async (t) => {
  const { url } = await startServer(t);
  const sessionId = await createSession(url);
  await sendPrompt(url, sessionId, "before slash command");
  const stream = startEvents(url);
  t.after(stream.close);
  await stream.ready;
  const output = stream.waitFor(
    "message.part.updated",
    (event) => JSON.stringify(event).includes("Slash command output without agent events"),
  );
  const response = await fetch(`${url}/session/${sessionId}/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command: "fixture", arguments: "" }),
  });
  assert.equal(response.status, 200);
  assert.match(JSON.stringify(await response.json()), /Slash command output without agent events/);
  const history = await fetch(`${url}/session/${sessionId}/message`);
  assert.equal(history.status, 200);
  assert.match(JSON.stringify(await history.json()), /Slash command output without agent events/);
  await output;
});

test("empty shell commands return a client error without creating a card", { timeout: 30_000 }, async (t) => {
  const { url } = await startServer(t);
  const sessionId = await createSession(url);
  const response = await fetch(`${url}/session/${sessionId}/shell`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command: "" }),
  });
  assert.equal(response.status, 400);
});

test("abort cancels a pending shell within ten seconds and tolerates repeated interruptions", { timeout: 30_000 }, async (t) => {
  const { url, server } = await startServer(t);
  const sessionId = await createSession(url);
  const stream = startEvents(url);
  t.after(stream.close);
  await stream.ready;
  const pi = server["sessions"].get(sessionId)?.pi;
  assert.ok(pi);
  let abortBashDispatched = false;
  const pending = new Promise<void>((resolvePending) => {
    pi.onEvent((event) => {
      if (event.type === "fixture_bash_pending") resolvePending();
      if (event.type === "fixture_abort_bash") abortBashDispatched = true;
    });
  });
  const cancelled = stream.waitFor("message.part.updated", (event) =>
    JSON.stringify(event).includes('"status":"error"') && JSON.stringify(event).includes('"cancelled":true'));
  const idle = stream.waitFor("session.idle", (event) => event.properties?.sessionID === sessionId);
  const shell = fetch(`${url}/session/${sessionId}/shell`, {
    method: "POST", body: JSON.stringify({ command: "sleep 600" }), signal: AbortSignal.timeout(10_000),
  });
  await pending;
  const started = performance.now();
  const aborts = await Promise.all([1, 2].map(() => fetch(`${url}/session/${sessionId}/abort`, { method: "POST" })));
  for (const response of aborts) {
    assert.equal(response.status, 200);
    assert.equal(await response.json(), true);
  }
  assert.equal((await shell).status, 200);
  await Promise.all([cancelled, idle]);
  assert.equal(abortBashDispatched, true);
  assert.ok(performance.now() - started < 10_000);
  assert.equal(server["sessions"].get(sessionId)?.status.type, "idle");
  const resumed = await fetch(`${url}/session/${sessionId}/shell`, {
    method: "POST", body: JSON.stringify({ command: "echo RESUMED" }),
  });
  assert.equal(resumed.status, 200);
});

test("a late bash reply cannot resurrect or duplicate a cancelled shell after reload", { timeout: 30_000 }, async (t) => {
  const { url, server } = await startServer(t);
  const sessionId = await createSession(url);
  const pi = server["sessions"].get(sessionId)?.pi;
  assert.ok(pi);
  const pending = new Promise<void>((resolvePending) => {
    pi.onEvent((event) => { if (event.type === "fixture_bash_pending") resolvePending(); });
  });
  const shell = fetch(`${url}/session/${sessionId}/shell`, {
    method: "POST", body: JSON.stringify({ command: "sleep 600 late" }), signal: AbortSignal.timeout(10_000),
  });
  await pending;
  await fetch(`${url}/session/${sessionId}/abort`, { method: "POST" });
  assert.equal((await shell).status, 200);
  assert.equal((await fetch(`${url}/session/${sessionId}/shell`, {
    method: "POST", body: JSON.stringify({ command: "echo RELEASE_LATE" }),
  })).status, 200);
  await server["sessions"].reloadMessages(sessionId);
  const messages = server["sessions"].messages(sessionId) ?? [];
  const cancelled = messages.flatMap((message) => message.parts).filter((part) =>
    part.type === "tool" && part.state.input.command === "sleep 600 late");
  assert.equal(cancelled.length, 1);
  assert.match(JSON.stringify(cancelled[0]), /"status":"error"/);
  assert.match(JSON.stringify(cancelled[0]), /"cancelled":true/);
  assert.doesNotMatch(JSON.stringify(messages), /STALE_SUCCESS/);
  assert.equal(server["sessions"].get(sessionId)?.status.type, "idle");
});

test("a native cancelled bash reply without exitCode ends the card as cancelled", { timeout: 30_000 }, async (t) => {
  const { url } = await startServer(t);
  const sessionId = await createSession(url);
  const response = await fetch(`${url}/session/${sessionId}/shell`, {
    method: "POST", body: JSON.stringify({ command: "fixture-cancelled" }),
  });
  assert.equal(response.status, 200);
  const history = await fetch(`${url}/session/${sessionId}/message`).then((res) => res.json());
  assert.match(JSON.stringify(history), /"status":"error"/);
  assert.match(JSON.stringify(history), /"cancelled":true/);
  assert.match(JSON.stringify(history), /"exitCode":null/);
});

test("abort releases a shell waiting on history refresh and ignores the late entries reply", { timeout: 30_000 }, async (t) => {
  const { url, server } = await startServer(t);
  const sessionId = await createSession(url);
  const pi = server["sessions"].get(sessionId)?.pi;
  assert.ok(pi);
  const pending = new Promise<void>((resolvePending) => {
    pi.onEvent((event) => { if (event.type === "fixture_entries_pending") resolvePending(); });
  });
  const shell = fetch(`${url}/session/${sessionId}/shell`, {
    method: "POST", body: JSON.stringify({ command: "fixture-reload-pending" }), signal: AbortSignal.timeout(10_000),
  });
  await pending;
  const started = performance.now();
  assert.equal((await fetch(`${url}/session/${sessionId}/abort`, { method: "POST" })).status, 200);
  assert.equal((await shell).status, 200);
  assert.ok(performance.now() - started < 10_000);
  assert.equal(server["sessions"].get(sessionId)?.status.type, "idle");
  assert.equal((await fetch(`${url}/session/${sessionId}/shell`, {
    method: "POST", body: JSON.stringify({ command: "echo RELEASE_ENTRIES" }),
  })).status, 200);
  const parts = (server["sessions"].messages(sessionId) ?? []).flatMap((message) => message.parts)
    .filter((part) => part.type === "tool" && part.state.input.command === "fixture-reload-pending");
  assert.equal(parts.length, 1);
  assert.match(JSON.stringify(parts), /"status":"error"/);
  assert.match(JSON.stringify(parts), /"cancelled":true/);
  assert.equal(server["sessions"].get(sessionId)?.status.type, "idle");
});

test("abort without a running shell is a no-op", { timeout: 30_000 }, async (t) => {
  const { url, server } = await startServer(t);
  const sessionId = await createSession(url);
  const before = structuredClone(server["sessions"].messages(sessionId));
  const response = await fetch(`${url}/session/${sessionId}/abort`, { method: "POST" });
  assert.equal(response.status, 200);
  assert.equal(await response.json(), true);
  assert.deepEqual(server["sessions"].messages(sessionId), before);
  assert.equal(server["sessions"].get(sessionId)?.status.type, "idle");
});

test("a print-only slash command renders its notification and returns idle without agent events", { timeout: 30_000 }, async (t) => {
  const { url, server } = await startServer(t);
  const sessionId = await createSession(url);
  const stream = startEvents(url);
  t.after(stream.close);
  await stream.ready;
  const output = stream.waitFor("message.part.updated", (event) => JSON.stringify(event).includes("Print-only command output"));
  const idle = stream.waitFor("session.idle", (event) => event.properties?.sessionID === sessionId);
  const response = await fetch(`${url}/session/${sessionId}/command`, {
    method: "POST", body: JSON.stringify({ command: "notify-fixture", arguments: "" }),
  });
  assert.equal(response.status, 200);
  assert.match(JSON.stringify(await response.json()), /Print-only command output/);
  await Promise.all([output, idle]);
  assert.equal(server["sessions"].get(sessionId)?.status.type, "idle");
});

test("shell refreshes persisted entries appended without agent events and retains its bash card", { timeout: 30_000 }, async (t) => {
  const { url } = await startServer(t);
  const sessionId = await createSession(url);
  await sendPrompt(url, sessionId, "before shell");
  const stream = startEvents(url);
  t.after(stream.close);
  await stream.ready;
  const persistedPart = stream.waitFor(
    "message.part.updated",
    (event) => JSON.stringify(event).includes("Persisted shell output: exit 7"),
  );
  const updated = stream.waitFor(
    "session.updated",
    (event) => JSON.stringify(event).includes(`"id":"${sessionId}"`),
  );
  const response = await fetch(`${url}/session/${sessionId}/shell`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command: "exit 7" }),
  });
  assert.equal(response.status, 200);
  const history = await fetch(`${url}/session/${sessionId}/message`);
  assert.equal(history.status, 200);
  const messages: unknown = await history.json();
  assert.match(JSON.stringify(messages), /Persisted shell output: exit 7/);
  assert.match(JSON.stringify(messages), /"tool":"bash"/);
  assert.match(JSON.stringify(messages), /"output":"SHELL_OUTPUT"/);
  assert.match(JSON.stringify(messages), /"exitCode":7/);
  await Promise.all([persistedPart, updated]);
});

test("compact returns the small-session error and reloads compacted history", { timeout: 30_000 }, async (t) => {
  const { url } = await startServer(t);
  const smallSessionId = await createSession(url);
  const smallEvents = startEvents(url); t.after(smallEvents.close); await smallEvents.ready;
  const smallNotice = smallEvents.waitFor("message.part.updated", (event) => JSON.stringify(event).includes("Nothing to compact"));
  const small = await fetch(`${url}/session/${smallSessionId}/summarize`, { method: "POST", body: "{}" });
  assert.equal(small.status, 400);
  assert.match(JSON.stringify(await small.json()), /Nothing to compact \(session too small\)/); await smallNotice;

  const sessionId = await createSession(url);
  await sendPrompt(url, sessionId, "long context");
  const stream = startEvents(url);
  t.after(stream.close);
  await stream.ready;
  const updated = stream.waitFor(
    "session.updated",
    (event) => JSON.stringify(event).includes(`"id":"${sessionId}"`),
  );
  const compacted = await fetch(`${url}/session/${sessionId}/summarize`, { method: "POST", body: "{}" });
  assert.equal(compacted.status, 200);
  assert.equal(await compacted.json(), true);
  await updated;

  const history = await fetch(`${url}/session/${sessionId}/message`);
  assert.equal(history.status, 200);
  assert.match(JSON.stringify(await history.json()), /Compacted summary/);

  const updatedV2 = stream.waitFor(
    "session.updated",
    (event) => JSON.stringify(event).includes(`"id":"${sessionId}"`),
  );
  const compactedV2 = await fetch(`${url}/api/session/${sessionId}/summarize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(compactedV2.status, 200);
  assert.deepEqual(await compactedV2.json(), { data: true });
  await updatedV2;

  const v2History = await fetch(`${url}/api/session/${sessionId}/message?order=asc`);
  assert.equal(v2History.status, 200);
  assert.match(JSON.stringify(await v2History.json()), /Compacted summary/);
});

test("share and unshare return the unsupported payload on both API surfaces", { timeout: 30_000 }, async (t) => {
  const { url } = await startServer(t);
  const sessionId = await createSession(url);
  for (const [path, method] of [
    [`/session/${sessionId}/share`, "POST"],
    [`/session/${sessionId}/share`, "DELETE"],
    [`/api/session/${sessionId}/share`, "POST"],
    [`/api/session/${sessionId}/share`, "DELETE"],
  ] as const) {
    const response = await fetch(`${url}${path}`, { method });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), unsupportedShare);
  }
});

test("unavailable sharing emits a user-visible session error", { timeout: 30_000 }, async (t) => {
  const { url } = await startServer(t);
  const sessionId = await createSession(url);
  const stream = startEvents(url);
  t.after(stream.close);
  await stream.ready;
  const shareError = stream.waitFor(
    "session.error",
    (event) => JSON.stringify(event).includes("Sharing is not available with OmO"),
  );
  const notice = stream.waitFor("message.part.updated", (event) => JSON.stringify(event).includes('"text":"Sharing is not available with OmO"'));

  const response = await fetch(`${url}/session/${sessionId}/share`, { method: "POST" });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), unsupportedShare);
  const [event] = await Promise.all([shareError, notice]);
  assert.match(JSON.stringify(event), /Sharing is not available with OmO/);
});

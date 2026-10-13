import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdapterServer } from "../../src/server.ts";
import { ApprovalBridge } from "../../src/approvals.ts";
import { SessionManager } from "../../src/sessions.ts";
import { SessionStore } from "../../src/session-store.ts";

const dir = mkdtempSync(join(tmpdir(), "ocpi-pending-sse-"));
const server = new AdapterServer({ host: "127.0.0.1", port: 0, defaultDirectory: dir });
await server.sessions.disposeAll();
const manager = new SessionManager((directory, event) => server.broadcast(directory, event), new SessionStore(dir));
server.sessions = manager;
const cancelled = [];
const approvals = new ApprovalBridge("ses_sse", (event) => server.broadcast(dir, event),
  (response) => cancelled.push(response), () => undefined);
manager.sessions.set("ses_sse", {
  info: { id: "ses_sse", projectID: dir, directory: dir, title: "Pending", version: "test", time: { created: 0, updated: 0 } },
  tree: { messageEntries: {} }, pi: undefined, messages: [], status: { type: "idle" }, model: undefined,
  streaming: undefined, toolByCallId: new Map(), approvals,
  hasPendingInteraction: () => true, hasRunningChildren: () => false,
});
let stopping;
let client;
try {
  await server.start();
  client = await new Promise((resolve, reject) => {
    const request = get(server.url + "/event", { agent: false }, resolve);
    request.once("error", reject);
  });
  client.resume();
  client.on("error", (error) => {
    if (process.argv[2] === "destroyed" && error.code === "ECONNRESET") return;
    throw error;
  });
  const ended = process.argv[2] === "destroyed"
    ? new Promise((resolve) => client.once("close", resolve))
    : once(client, "end", { signal: AbortSignal.timeout(2000) });
  approvals.handle({ type: "extension_ui_request", id: "permission", method: "select",
    title: "Permission required: read", options: ["Allow once", "Allow always", "Deny", "Deny with feedback"] });
  assert.equal(approvals.permissions().length, 1);
  const response = [...server.sseClients.keys()][0];
  if (process.argv[2] === "ended") response.end();
  if (process.argv[2] === "destroyed") response.destroy();
  if (process.argv[2] !== "stop") {
    server.broadcast(dir, { type: "session.idle", properties: { sessionID: "ses_sse" } });
    assert.equal(server.sseClients.has(response), false, "broadcast kept an ended/destroyed SSE response");
  }
  stopping = server.stop();
  await ended;
  await stopping;
  assert.deepEqual(cancelled, [{ type: "extension_ui_response", id: "permission", cancelled: true }]);
  assert.equal(server.sseClients.size, 0);
  console.log("SHUTDOWN_PASS", JSON.stringify(cancelled));
} finally {
  client?.destroy();
  await (stopping ?? server.stop());
  rmSync(dir, { recursive: true, force: true });
}

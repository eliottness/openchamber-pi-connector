import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { OCSession } from "../../../src/types.js";
import type { Check } from "../core.js";
import type { SmokeContext } from "../context.js";

export function register(check: Check, context: SmokeContext): void {
  check("routes", async (signal) => {
    const inventory = readFileSync(new URL("../../../docs/omo-endpoint-inventory.md", import.meta.url), "utf8");
    const rows = inventory.split("\n").flatMap((line) => {
      const row = line.match(/^\| (GET|POST|PUT|PATCH|DELETE) \| `([^`]+)` \|/);
      return row?.[1] && row[2] ? [{
        method: row[1],
        path: row[2],
        unavailable: line.includes("| unavailable"),
        staticOnly: line.includes("static-only"),
      }] : [];
    });
    assert.ok(rows.length > 0, "the endpoint inventory must supply routes");
    const covered = new Set<string>();
    const staticStatuses: Array<{ method: string; path: string; status: number }> = [];
    const request = async (
      method: string,
      path: string,
      body?: unknown,
      unavailable = false,
      staticOnly = false,
    ): Promise<string> => {
      const response = await fetch(`${context.url}${path}`, {
        method, signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
      });
      if (path === "/global/event") {
        await response.body?.cancel();
        assert.equal(response.status, 200, `${method} ${path}`);
        return "";
      }
      const text = await response.text();
      console.log(`route: ${method} ${path} -> ${response.status}`);
      if (staticOnly) {
        assert.notEqual(response.status, 500, `${method} ${path}: ${text}`);
        staticStatuses.push({ method, path, status: response.status });
      } else {
        assert.notEqual(response.status, 404, `${method} ${path}: ${text}`);
        assert.notEqual(response.status, 501, `${method} ${path}: ${text}`);
        assert.ok([200, 204, 400].includes(response.status), `${method} ${path}: HTTP ${response.status}: ${text}`);
      }
      if (unavailable && method !== "GET") {
        assert.equal(response.status, 400, `${method} ${path} must reject unsupported mutations`);
      }
      return text;
    };
    assert.equal(new Set(rows.map((row) => `${row.method} ${row.path}`)).size, rows.length,
      "inventory routes must be unique");
    const previous = context.session;
    context.session = await context.api<OCSession>("/session", signal, { title: "Smoke route sweep" });
    const id = context.sessionId();
    for (const row of rows) {
      // These routes require live request IDs, not invented IDs yielding a
      // legitimate resource 404. Exercise their lifecycle below.
      if (row.path.includes("{requestID}") || row.path === "/api/session/{sessionID}/permission" ||
          row.method === "DELETE" && row.path === "/session/{sessionID}") continue;
      const target = row.path.endsWith("/summarize")
        ? (await context.api<OCSession>("/session", signal, { title: "Smoke empty route compact" })).id
        : id;
      const path = row.path.replaceAll("{sessionID}", target).replaceAll("{providerID}", "smoke").replaceAll("{name}", "smoke");
      let body: unknown = row.method === "GET" || row.method === "DELETE" ? undefined : {};
      if (row.path === "/session" && row.method === "POST") body = { title: "Smoke route create" };
      if (row.path.endsWith("/message") && row.method === "POST" || row.path.endsWith("/prompt_async")) {
        body = { noReply: true, parts: [{ type: "text", text: `ROUTE-${context.marker}` }] };
      }
      if (row.path.endsWith("/fork")) body = { messageID: "" };
      if (row.method === "PATCH" && row.path === "/session/{sessionID}") body = { title: "Smoke route renamed" };
      await request(row.method, path, body, row.unavailable, row.staticOnly);
      covered.add(`${row.method} ${row.path}`);
    }
    await context.stop(signal);
    await context.start(signal, true, 900_000, "--permission read=ask");
    context.session = await context.api<OCSession>("/session", signal, { title: "Smoke route requests" });
    const requestSession = context.sessionId();
    const file = join(context.work, "diff-tracked.txt");
    const asked = context.waitForEvent((event) => event.type === "permission.asked" &&
      event.properties.sessionID === requestSession, 120_000, signal);
    const permissionIdle = context.turnIdle(signal);
    await context.prompt(`Use read directly on ${file} exactly once, then stop. Do not use other tools or delegate.`, signal);
    const permission = await asked;
    if (permission.type !== "permission.asked") assert.fail("missing permission fixture");
    await request("GET", `/api/session/${requestSession}/permission/${encodeURIComponent(permission.properties.id)}`,
      undefined, false, true);
    covered.add("GET /api/session/{sessionID}/permission/{requestID}");
    // The inventory's create route is probed while a real request is pending.
    await request("POST", `/api/session/${requestSession}/permission`, {
      requestID: permission.properties.id, reply: "once",
    }, false, true);
    covered.add("POST /api/session/{sessionID}/permission");
    await request("POST", `/permission/${encodeURIComponent(permission.properties.id)}/reply`,
      { reply: "once" }, false, true);
    covered.add("POST /permission/{requestID}/reply");
    await permissionIdle;
    for (const action of ["reply", "reject"] as const) {
      const question = context.waitForEvent((event) => event.type === "question.asked" &&
        event.properties.sessionID === requestSession, 120_000, signal);
      const idle = context.turnIdle(signal);
      await context.prompt("Call ask_user_question directly exactly once with waitForAnswer true and " +
        `questions [{question:"Route fixture ${action}?",header:"Route",multiSelect:false,` +
        'options:[{label:"A",description:"First"},{label:"B",description:"Second"}]}]. ' +
        "After the answer or rejection, stop without asking again or using other tools.", signal);
      const event = await question;
      if (event.type !== "question.asked") assert.fail("missing question fixture");
      const finish = context.waitForEvent((entry) => entry.type ===
        (action === "reply" ? "question.replied" : "question.rejected") &&
        entry.properties.requestID === event.properties.id, 30_000, signal);
      await request("POST", `/question/${encodeURIComponent(event.properties.id)}/${action}`,
        action === "reply" ? { answers: [["A"]] } : {}, false, true);
      covered.add(`POST /question/{requestID}/${action}`);
      await finish;
      assert.equal(await context.api<boolean>(`/session/${requestSession}/abort`, signal, {}), true);
      await idle;
      assert.equal((await context.api<Record<string, { type: string }>>("/session/status", signal))[requestSession]?.type, "idle");
    }
    await context.stop(signal);
    await context.start(signal, true);
    const disposable = await context.api<OCSession>("/session", signal, { title: "Smoke route delete" });
    await request("DELETE", `/session/${disposable.id}`, undefined, false, true);
    covered.add("DELETE /session/{sessionID}");
    await request("GET", `/session/${context.sessionId()}/permissions/smoke-static`, undefined, false, true);
    for (const row of rows) assert.ok(covered.has(`${row.method} ${row.path}`), `unprobed inventory route: ${row.method} ${row.path}`);
    console.log(`routes: ${covered.size}/${rows.length} inventory pairs; observed/called zero 404/501`);
    console.log(`routes static-only statuses: ${staticStatuses.map((entry) =>
      `${entry.method} ${entry.path}=${entry.status}`).join(", ")}`);
    context.session = await context.api<OCSession>("/session", signal, { title: "Smoke shutdown live process" });
    assert.ok(context.agentPids().length > 0, "route sweep must leave a live OmO process for shutdown");
    assert.notEqual(context.session.id, previous?.id);
  }, { dependsOn: ["diff"], timeoutMs: 420_000 });
}

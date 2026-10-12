import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { AdapterServer } from "../src/server.js";

test("unwritable debug log preserves health and agent events with exactly one warning", { timeout: 15_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ocpi-t12-debug-"));
  const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "serve", "--port", "0", "--directory", dir], {
    env: { ...process.env, OCPI_DEBUG: "1", OCPI_DEBUG_LOG: "/proc/nope.log",
      OCPI_STATE_DIR: join(dir, "state"), PI_CODING_AGENT_DIR: join(dir, "agent"), OCPI_PI_BINARY: resolve("test/fixtures/diff-omo.mjs") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = once(child, "exit");
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  t.after(async () => { child.kill("SIGTERM"); await exited; rmSync(dir, { recursive: true, force: true }); });
  const url = await new Promise<string>((resolveUrl, reject) => {
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      const match = stdout.match(/listening on (http:\/\/\S+)/);
      if (match?.[1]) resolveUrl(match[1]);
    });
    child.once("exit", () => reject(new Error("connector exited before listening")));
    AbortSignal.timeout(5000).addEventListener("abort", () => reject(new Error("startup deadline")), { once: true });
  });
  assert.equal((await fetch(url + "/global/health")).status, 200);
  const session = await (await fetch(url + "/session", { method: "POST", body: "{}" })).json();
  const prompted = await fetch(url + "/session/" + session.id + "/message", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ parts: [{ type: "text", text: "[]" }] }),
  });
  assert.equal(prompted.status, 200);
  assert.equal((await fetch(url + "/global/health")).status, 200);
  child.kill("SIGTERM");
  assert.equal((await exited)[0], 0);
  assert.equal(stderr.split("\n").filter((line) => line.startsWith("[debug] logging disabled:")).length, 1);
});

test("title matches GET, sidebar lists and session.updated through prompts, rename and reload", { timeout: 15_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ocpi-t12-title-"));
  const prior = { binary: process.env.OCPI_PI_BINARY, state: process.env.OCPI_STATE_DIR, agent: process.env.PI_CODING_AGENT_DIR };
  process.env.OCPI_PI_BINARY = resolve("test/fixtures/diff-omo.mjs");
  process.env.OCPI_STATE_DIR = join(dir, "state");
  process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
  let server = new AdapterServer({ host: "127.0.0.1", port: 0, defaultDirectory: dir });
  t.after(async () => {
    await server.stop();
    if (prior.binary === undefined) delete process.env.OCPI_PI_BINARY; else process.env.OCPI_PI_BINARY = prior.binary;
    if (prior.state === undefined) delete process.env.OCPI_STATE_DIR; else process.env.OCPI_STATE_DIR = prior.state;
    if (prior.agent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prior.agent;
    rmSync(dir, { recursive: true, force: true });
  });
  await server.start();
  const session = await (await fetch(server.url + "/session", { method: "POST", body: JSON.stringify({ title: "   " }) })).json();
  const controller = new AbortController();
  const stream = await fetch(server.url + "/event", { signal: controller.signal });
  assert.ok(stream.body);
  const reader = stream.body.getReader();
  await reader.read(); // server.connected: subscription is armed before the prompt.
  const updated = (async () => {
    let text = "";
    const deadline = AbortSignal.timeout(5000);
    deadline.addEventListener("abort", () => controller.abort(), { once: true });
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("SSE ended before title");
      text += new TextDecoder().decode(chunk.value);
      const frames = text.split("\n\n");
      text = frames.pop() ?? "";
      for (const frame of frames) {
        if (!frame.startsWith("data: ")) continue;
        const event = JSON.parse(frame.slice(6));
        if (event.type === "session.updated" && event.properties.info.title === "[]") return event.properties.info;
      }
    }
  })();
  await fetch(server.url + "/session/" + session.id + "/message", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ parts: [{ type: "text", text: "  []  " }] }),
  });
  const eventInfo = await updated;
  controller.abort();
  assert.equal(eventInfo.title, "[]");
  for (const path of ["/session/" + session.id, "/session", "/experimental/session", "/experimental/session?archived=true"]) {
    const body = await (await fetch(server.url + path)).json();
    assert.equal((Array.isArray(body) ? body.find((entry) => entry.id === session.id) : body).title, "[]");
  }
  await fetch(server.url + "/session/" + session.id, { method: "PATCH", body: JSON.stringify({ title: "Renamed session" }) });
  await fetch(server.url + "/session/" + session.id + "/message", { method: "POST", body: JSON.stringify({ parts: [{ type: "text", text: "[]" }] }) });
  assert.equal((await (await fetch(server.url + "/session/" + session.id)).json()).title, "Renamed session");
  await server.stop();
  server = new AdapterServer({ host: "127.0.0.1", port: 0, defaultDirectory: dir });
  await server.start();
  assert.equal((await (await fetch(server.url + "/session/" + session.id)).json()).title, "Renamed session");
});

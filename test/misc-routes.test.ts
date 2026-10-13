import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AdapterServer } from "../src/server.js";

test("owned routes return real listings or truthful neutral and unsupported responses", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "ocpi-t12-routes-"));
  const dir = join(base, "work");
  mkdirSync(dir);
  mkdirSync(join(dir, "nested"));
  writeFileSync(join(dir, "nested", "match.txt"), "content");
  writeFileSync(join(base, "secret"), "private");
  symlinkSync(base, join(dir, "escape"));
  const server = new AdapterServer({ host: "127.0.0.1", port: 0, defaultDirectory: dir });
  t.after(async () => { await server.stop(); rmSync(base, { recursive: true, force: true }); });
  await server.start();
  const get = async (path: string) => {
    const response = await fetch(server.url + path);
    return { status: response.status, body: await response.json() };
  };
  assert.deepEqual((await get("/file?path=nested")).body, [{
    name: "match.txt", path: "nested/match.txt", absolute: join(dir, "nested", "match.txt"), type: "file", ignored: false,
  }]);
  assert.deepEqual((await get("/find/file?query=match&dirs=false")).body, ["nested/match.txt"]);
  assert.deepEqual((await get("/find/file?query=&limit=0")).body, []);
  for (const route of ["/file?path=../", "/file?path=escape", "/find/file?query=../secret", "/find/file?path=../", "/find/file?query=" + encodeURIComponent(base)]) {
    assert.equal((await get(route)).status, 400, route);
  }
  assert.ok(!(await get("/file")).body.some((entry: { name: string }) => entry.name === "escape"));
  for (const path of ["/skill", "/lsp", "/formatter", "/experimental/tool/ids"]) {
    assert.deepEqual(await get(path), { status: 200, body: [] });
  }
  for (const path of ["/provider/auth", "/mcp"]) assert.deepEqual(await get(path), { status: 200, body: {} });
  for (const [method, path] of [
    ["PUT", "/auth/anthropic"], ["POST", "/provider/anthropic/oauth/authorize"], ["POST", "/provider/anthropic/oauth/callback"],
    ["PATCH", "/config"], ["POST", "/mcp/qa/connect"], ["POST", "/mcp/qa/disconnect"], ["POST", "/mcp/qa/auth"],
    ["DELETE", "/mcp/qa/auth"], ["POST", "/mcp/qa/auth/callback"], ["POST", "/mcp/qa/auth/authenticate"],
    ["POST", "/experimental/control-plane/move-session"],
  ] as const) {
    const response = await fetch(server.url + path, { method, body: JSON.stringify({}), headers: { "Content-Type": "application/json" } });
    assert.equal(response.status, 400, `${method} ${path}`);
    assert.equal((await response.json()).name, "UnsupportedError");
  }
});

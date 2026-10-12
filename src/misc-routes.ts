import { appendFileSync } from "node:fs";
import { readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

let loggingDisabled = false;

/** One shared failure latch for HTTP and agent-event diagnostics. */
export function debugLog(line: string): void {
  if (!process.env.OCPI_DEBUG || loggingDisabled) return;
  try {
    appendFileSync(process.env.OCPI_DEBUG_LOG ?? "/tmp/openchamber-pi-debug.log", line + "\n");
  } catch (error) {
    loggingDisabled = true;
    console.error(`[debug] logging disabled: ${error instanceof Error ? error.message : String(error)}`);
  }
}

interface RouteResult {
  status: number;
  body: unknown;
}

function unsupported(message: string): RouteResult {
  return { status: 400, body: { name: "UnsupportedError", error: message, data: { message } } };
}

async function confinedDirectory(root: string, path: string): Promise<string | undefined> {
  const candidate = resolve(root, path);
  const rel = relative(root, candidate);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
  try {
    const actual = await realpath(candidate);
    const actualRel = relative(root, actual);
    return actualRel === ".." || actualRel.startsWith(`..${sep}`) || isAbsolute(actualRel) ? undefined : actual;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    return undefined;
  }
}

export async function miscRoute(method: string, path: string, url: URL, directory: string): Promise<RouteResult | undefined> {
  if (method === "GET" && ["/skill", "/lsp", "/formatter", "/experimental/tool/ids"].includes(path)) {
    return { status: 200, body: [] };
  }
  if (method === "GET" && ["/provider/auth", "/mcp"].includes(path)) return { status: 200, body: {} };
  if ((method === "PUT" && /^\/auth\/[^/]+$/.test(path)) ||
      (method === "POST" && /^\/provider\/[^/]+\/oauth\/(authorize|callback)$/.test(path)) ||
      (method === "PATCH" && path === "/config")) {
    return unsupported("Not supported with OmO; configure providers in OmO");
  }
  if ((["POST", "DELETE"].includes(method) && /^\/mcp\/[^/]+\/(connect|disconnect|auth(?:\/(?:callback|authenticate))?)$/.test(path)) ||
      (method === "POST" && path === "/experimental/control-plane/move-session")) {
    return unsupported("Not supported with OmO; configure MCP and session directories in OmO");
  }
  if (method !== "GET" || !["/file", "/find/file"].includes(path)) return undefined;
  const root = await realpath(directory);
  if (path === "/file") {
    const target = await confinedDirectory(root, url.searchParams.get("path") ?? "");
    if (target === undefined) return unsupported("Path must remain inside the session directory");
    const entries = await readdir(target, { withFileTypes: true });
    const body = entries.filter((entry) => !entry.isSymbolicLink() && entry.name !== ".git" &&
      (entry.isFile() || entry.isDirectory())).map((entry) => {
      const absolute = resolve(target, entry.name);
      return { name: entry.name, path: relative(root, absolute).split(sep).join("/"), absolute,
        type: entry.isDirectory() ? "directory" : "file", ignored: false };
    }).sort((a, b) => a.path.localeCompare(b.path));
    return { status: 200, body };
  }
  const query = url.searchParams.get("query") ?? "";
  if (isAbsolute(query) || query.split(/[\\/]/).includes("..") ||
      (url.searchParams.has("path") && await confinedDirectory(root, url.searchParams.get("path") ?? "") === undefined)) {
    return unsupported("Path must remain inside the session directory");
  }
  const limitValue = Number(url.searchParams.get("limit") ?? "100");
  const limit = Number.isFinite(limitValue) ? Math.min(1000, Math.max(0, Math.floor(limitValue))) : 100;
  const dirs = url.searchParams.get("dirs") !== "false" && url.searchParams.get("type") !== "file";
  const onlyDirs = url.searchParams.get("type") === "directory";
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (files.length >= limit) return;
      if (entry.isSymbolicLink() || entry.name === ".git") continue;
      const absolute = resolve(directory, entry.name);
      const path = relative(root, absolute).split(sep).join("/");
      if (((entry.isFile() && !onlyDirs) || (entry.isDirectory() && dirs)) &&
          path.toLowerCase().includes(query.toLowerCase())) files.push(path);
      if (entry.isDirectory() && entry.name !== "node_modules") await visit(absolute);
    }
  }
  await visit(root);
  return { status: 200, body: files.sort() };
}

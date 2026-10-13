import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFileSync, readdirSync, readlinkSync } from "node:fs";
import { basename } from "node:path";

interface HostProcess {
  readonly pid: number;
  readonly group: number;
  readonly start: string;
  readonly state: string;
  readonly argv: readonly string[];
}

function processInfo(pid: number): HostProcess | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return {
      pid, group: Number(fields[2]), start: fields[19] ?? "", state: fields[0] ?? "",
      argv: readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean),
    };
  } catch (error) {
    if (error instanceof Error && "code" in error && ["ENOENT", "ESRCH"].includes(String(error.code))) return undefined;
    throw error;
  }
}

function alive(identity: HostProcess): boolean {
  const current = processInfo(identity.pid);
  return current !== undefined && current.start === identity.start && current.state !== "Z";
}

/**
 * OmO's p-<sha256("p:" + parentSessionId)[:16]>.sock shards belong to one
 * parent session tree. Only connector-created IDs (including their persisted
 * ownership after restart) are authorized; discovered sessions and LSP are not.
 */
export async function stopSessionHosts(created: ReadonlyMap<string, string>): Promise<void> {
  if (created.size === 0) return;
  const sockets = new Map([...created].map(([id, directory]) => [
    `p-${createHash("sha256").update(`p:${id}`).digest("hex").slice(0, 16)}.sock`, directory,
  ]));
  const processes = readdirSync("/proc").filter((name) => /^\d+$/.test(name))
    .flatMap((name) => {
      const info = processInfo(Number(name));
      return info && info.state !== "Z" ? [info] : [];
    });
  const hosts = processes.filter((info) => {
    if (!info.argv.includes("--internal-rpc-host-supervisor") &&
        !info.argv.some((arg) => arg.endsWith("/host-lifecycle.js"))) return false;
    const socketIndex = info.argv.indexOf("--socket");
    const socket = socketIndex < 0 ? undefined : info.argv[socketIndex + 1];
    if (!socket) return false;
    const directory = sockets.get(basename(socket));
    if (directory === undefined || info.group !== info.pid) return false;
    try {
      return readlinkSync(`/proc/${info.pid}/cwd`) === directory;
    } catch (error) {
      if (error instanceof Error && "code" in error && ["ENOENT", "ESRCH"].includes(String(error.code))) return false;
      throw error;
    }
  });
  await Promise.all(hosts.map(async (host) => {
    const members = processes.filter((info) => info.group === host.group);
    const signal = (value: NodeJS.Signals): void => {
      const live = members.filter(alive);
      if (live.length === 0) return;
      for (const member of live) {
        try {
          if (readFileSync(`/proc/${member.pid}/cgroup`, "utf8").includes("/openchamber.service")) {
            throw new Error(`refusing to signal live service pid=${member.pid}`);
          }
        } catch (error) {
          if (!(error instanceof Error && "code" in error && ["ENOENT", "ESRCH"].includes(String(error.code)))) throw error;
        }
      }
      try {
        process.kill(-host.group, value);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
      }
    };
    // Subscribe before signalling; GNU tail observes PID death, not a fixed delay.
    const watching = new AbortController();
    const deadline = AbortSignal.any([watching.signal, AbortSignal.timeout(10_000)]);
    const death = Promise.all(members.filter(alive).map(async (member) => {
      const watcher = spawn("tail", [`--pid=${member.pid}`, "--sleep-interval=0.1", "-f", "/dev/null"], {
        stdio: "ignore", signal: deadline,
      });
      const [code] = await once(watcher, "exit");
      if (code !== 0 || alive(member)) throw new Error(`private OmO host pid=${member.pid} survived shutdown`);
    }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const escalation = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        try {
          signal("SIGKILL");
        } catch (error) {
          reject(error);
        }
      }, 5_000);
    });
    const complete = Promise.race([death, escalation]);
    try {
      signal("SIGTERM");
      await complete;
    } finally {
      clearTimeout(timer);
      watching.abort();
      await Promise.allSettled([complete]);
    }
  }));
}

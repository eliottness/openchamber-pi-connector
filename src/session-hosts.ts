import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { closeSync, constants, openSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { basename } from "node:path";

interface HostProcess {
  readonly fd: number;
  readonly pid: number;
  readonly group: number;
  readonly start: string;
  readonly state: string;
  readonly argv: readonly string[];
}

function processInfo(pid: number): HostProcess | undefined {
  let fd: number | undefined;
  try {
    // An open proc directory never redirects to a replacement PID. Keep it
    // through selection and pass it to the helper for post-pidfd-open validation.
    fd = openSync(`/proc/${pid}`, constants.O_RDONLY | constants.O_DIRECTORY);
    const stat = readFileSync(`/proc/self/fd/${fd}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return {
      fd, pid, group: Number(fields[2]), start: fields[19] ?? "", state: fields[0] ?? "",
      argv: readFileSync(`/proc/self/fd/${fd}/cmdline`, "utf8").split("\0").filter(Boolean),
    };
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    if (error instanceof Error && "code" in error && ["ENOENT", "ESRCH"].includes(String(error.code))) return undefined;
    throw error;
  }
}

// Node 22 has no pidfd API. This bounded, stdlib-only helper holds all pidfds
// across TERM, readiness-based death observation, and KILL. -I ignores Python
// environment customizations. No numeric-PID signal fallback is permitted.
const stopBoundHosts = String.raw`
import contextlib, json, os, selectors, signal, sys, time

pidfd_open = os.pidfd_open
send_signal = signal.pidfd_send_signal

def matches(member):
    try:
        with open("/proc/self/fd/%s/stat" % member["fd"]) as source:
            stat = source.read()
    except (FileNotFoundError, ProcessLookupError):
        return False
    fields = stat[stat.rfind(")") + 2:].split()
    if fields[19] != member["start"] or fields[0] == "Z":
        return False
    if int(fields[2]) != member["group"]:
        raise RuntimeError("private OmO host member pid=%s changed process group" % member["pid"])
    return True

with contextlib.ExitStack() as resources:
    selector = resources.enter_context(selectors.DefaultSelector())
    pending = {}
    for member in json.loads(sys.argv[1]):
        try:
            fd = pidfd_open(member["pid"])
        except ProcessLookupError:
            continue
        resources.callback(os.close, fd)
        # Open FIRST, then validate against the retained proc directory, not a
        # newly resolved /proc/PID. If the original died/reused, that directory
        # is gone (or zombie), even if both processes started in the same tick.
        if matches(member):
            selector.register(fd, selectors.EVENT_READ)
            pending[fd] = member

    # Finish all acquisition/validation before sending anything. Missing Python,
    # missing pidfd support, and acquisition errors therefore fail closed.
    for sig in (signal.SIGTERM, signal.SIGKILL):
        for fd, member in pending.items():
            if matches(member):
                try:
                    send_signal(fd, sig)
                except ProcessLookupError:
                    continue
        deadline = time.monotonic() + 5
        while pending:
            events = selector.select(max(0, deadline - time.monotonic()))
            if not events:
                break
            for key, _ in events:
                del pending[key.fd]
                selector.unregister(key.fd)
        if not pending:
            break
    if pending:
        raise RuntimeError("private OmO hosts survived shutdown: %s" %
                           [member["pid"] for member in pending.values()])
`;

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
  const processes: HostProcess[] = [];
  try {
    for (const name of readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
      const info = processInfo(Number(name));
      if (info) processes.push(info);
    }
    const groups = new Set(processes.filter((info) => {
      if (info.state === "Z" || info.group !== info.pid) return false;
      if (!info.argv.includes("--internal-rpc-host-supervisor") &&
          !info.argv.some((arg) => arg.endsWith("/host-lifecycle.js"))) return false;
      const socketIndex = info.argv.indexOf("--socket");
      const socket = socketIndex < 0 ? undefined : info.argv[socketIndex + 1];
      if (!socket) return false;
      const directory = sockets.get(basename(socket));
      if (directory === undefined) return false;
      try {
        // The original leader must still exist after the process-table scan:
        // a recycled group number cannot confer its ownership on new members.
        return readlinkSync(`/proc/self/fd/${info.fd}/cwd`) === directory;
      } catch (error) {
        if (error instanceof Error && "code" in error && ["ENOENT", "ESRCH"].includes(String(error.code))) return false;
        throw error;
      }
    }).map((info) => info.group));
    const members = processes.filter((info) => groups.has(info.group) && info.state !== "Z");
    if (members.length === 0) return;
    const identities = members.map((info, index) => ({
      fd: index + 3, pid: info.pid, start: info.start, group: info.group,
    }));
    // Ownership is the parent-session shard + cwd + supervisor + private group,
    // never the service cgroup (production hosts share it with the connector).
    const helper = spawn("/bin/python3", ["-I", "-c", stopBoundHosts, JSON.stringify(identities)], {
      stdio: ["ignore", "ignore", "pipe", ...members.map((info) => info.fd)],
    });
    let stderr = "";
    helper.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8192); });
    const timeout = setTimeout(() => helper.kill("SIGKILL"), 15_000);
    try {
      const [code, signal] = await once(helper, "close");
      if (code !== 0) throw new Error(`private OmO host pidfd teardown failed (code=${code}, signal=${signal}): ${stderr}`);
    } finally {
      clearTimeout(timeout);
    }
  } finally {
    for (const info of processes) closeSync(info.fd);
  }
}

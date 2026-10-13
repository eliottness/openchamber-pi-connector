import { spawn } from "node:child_process";
import { once } from "node:events";

// A detached supervisor and an engine in its group, like OmO's private shard.
const engine = spawn(process.execPath, [
  "-e", 'process.stdout.write("READY\\n"); setInterval(() => {}, 2147483647)',
  "--", "--mode", "rpc", "--multi-session",
], { stdio: ["ignore", "pipe", "ignore"] });
const exited = once(engine, "exit");
process.on("SIGTERM", () => {
  engine.kill("SIGTERM");
  void exited.then(() => process.exit(0));
});
await once(engine.stdout, "data");
process.stdout.write(`${JSON.stringify({ pid: process.pid, enginePid: engine.pid })}\n`);

/**
 * Part A: real OmO, private state, HTTP + future-only SSE assertions.
 * OCPI_PI_BINARY=/path/to/omo npm run omo-smoke [-- --only prompt,abort]
 * Add sorted checks/*.ts modules exporting register(check, context) for part B.
 * Prerequisites are included by --only; the first failure skips remaining work.
 */
import { readdirSync } from "node:fs";
import { SmokeRegistry, parseOnly, summarize } from "./smoke/core.js";
import { SmokeContext } from "./smoke/context.js";

const shutdown = new AbortController();
let context: SmokeContext | undefined;
let interrupted = false;
const interrupt = (signal: string): void => {
  if (!interrupted) {
    interrupted = true;
    console.error(`FAIL interruption: ${signal}; cleaning up owned processes`);
    shutdown.abort(new Error(signal));
  }
};
const onSigint = (): void => interrupt("SIGINT");
const onSigterm = (): void => interrupt("SIGTERM");
process.on("SIGINT", onSigint);
process.on("SIGTERM", onSigterm);

try {
  const only = parseOnly(process.argv.slice(2));
  const binary = process.env.OCPI_PI_BINARY;
  if (!binary?.trim()) throw new Error("OCPI_PI_BINARY is required; set it to the OmO executable");
  context = new SmokeContext(binary, shutdown.signal);
  const registry = new SmokeRegistry();
  const directory = new URL("./smoke/checks/", import.meta.url);
  for (const file of readdirSync(directory).filter((file) => file.endsWith(".ts")).sort()) {
    const module = await import(new URL(file, directory).href);
    if (typeof module.register !== "function") throw new Error(`${file} must export register(check, context)`);
    module.register(registry.check, context);
  }
  const results = await registry.run({ only, signal: shutdown.signal, log: console.log });
  process.exitCode = interrupted ? 130 : summarize(results).exitCode;
  if (process.exitCode !== 0) console.error(`connector diagnostics:\n${context.diagnostics()}`);
} catch (error) {
  console.error(`FAIL harness: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = interrupted ? 130 : 1;
} finally {
  try {
    await context?.cleanup();
  } catch (error) {
    console.error(`FAIL cleanup: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
  process.off("SIGINT", onSigint);
  process.off("SIGTERM", onSigterm);
}

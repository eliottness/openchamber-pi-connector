import assert from "node:assert/strict";
import type { Check } from "../core.js";
import type { SmokeContext } from "../context.js";

/** Keep shutdown after part B's checks, which belong between 00 and 99. */
export function register(check: Check, context: SmokeContext): void {
  check("shutdown", async (signal) => {
    const pids = context.agentPids();
    assert.ok(pids.length > 0, "SIGTERM check must begin with a live OmO process");
    const death = context.waitForDeath(pids, 15_000, signal);
    await context.stop(signal);
    await death;
    context.assertShutdownProcesses();
  }, { dependsOn: ["fork-revert"] });
}

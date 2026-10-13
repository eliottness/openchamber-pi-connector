import assert from "node:assert/strict";
import type { Check } from "../core.js";
import type { SmokeContext } from "../context.js";
import type { OCSession } from "../../../src/types.js";

/** Keep shutdown after part B's checks, which belong between 00 and 99. */
export function register(check: Check, context: SmokeContext, isolated = false): void {
  if (isolated) {
    check("shutdown-start", async (signal) => {
      await context.start(signal, true);
      context.session = await context.api<OCSession>("/session", signal, { title: `Shutdown smoke ${context.marker}` });
      assert.ok(context.agentPids().length > 0, "isolated shutdown must create a live OmO RPC session");
    });
  }
  check("shutdown", async (signal) => {
    const pids = context.agentPids();
    assert.ok(pids.length > 0, "SIGTERM check must begin with a live OmO process");
    const death = context.waitForDeath(pids, 15_000, signal);
    await context.stop(signal);
    await death;
    await context.assertShutdownProcesses(signal);
  }, { dependsOn: [isolated ? "shutdown-start" : "routes"] });
}

# OmO smoke checks

Run from the repository with Node 22 or newer:

```sh
OCPI_PI_BINARY=/path/to/omo npm run omo-smoke
OCPI_PI_BINARY=/path/to/omo npm run omo-smoke -- --only prompt,abort
```

`PI_CODING_AGENT_DIR` selects the existing agent directory for read-only
discovery (default `/home/eliott/.omo/agent`). New sessions use a private
copy of small configuration and credential files, a private HOME, and
connector state under `/tmp/ocomo-qa/smoke-<timestamp>-<suffix>`. No existing
session receives prompts. The private directory, including credentials,
is removed on completion, failure, SIGINT, or SIGTERM.

OmO uses the copied configuration unchanged, including speculative task-host
prewarming. Detached task-host supervisors and their multi-session engines have
a 15-minute idle policy after their last client leaves. Shutdown fails if any
connector session RPC process survives SIGTERM, but reports surviving detached
hosts as INFO with PID, command line, and expected self-expiry. Harness cleanup
then terminates those hosts. A workspace-owned detached OmO LSP daemon is also
reported as INFO and terminated by scoped cleanup; session RPCs and unknown
processes remain strict shutdown failures. Inherited RPC socket, watchdog, and
cleanup-path variables are stripped so QA cannot attach to the caller's host.
The isolated HOME also passes OmO's documented onboarding-disable CLI flag:
the smoke tests product behavior, not the first-run tour, and an onboarding
turn would otherwise race the checks' prompt-specific idle events.

Part B1 adds tool-card input/history checks, phased todos, one foreground quick
subagent with live child tools and an archived transcript, allow-once and deny
approvals, and conversation-only fork/revert/unrevert with a file SHA256 check.
The approval check temporarily restarts with `--permission-preset ask`; it does
not change any configuration file. Compact/shell/commands/share and diff/routes
checks are reserved for part B2.

## Part B extension

Add `checks/10-tools.ts`, `checks/20-todo.ts`, or similar files between
`00-base.ts` and `99-shutdown.ts`. Files are loaded in sorted filename order
without editing the entry point. Each module exports `register`:

```ts
import assert from "node:assert/strict";
import type { Check } from "../core.js";
import type { SmokeContext } from "../context.js";

export function register(check: Check, context: SmokeContext): void {
  check("feature-name", async (signal) => {
    const event = context.waitForEvent(
      (event) => event.type === "session.idle" &&
        event.properties.sessionID === context.sessionId(),
      120_000,
      signal,
    );
    await context.prompt("Your feature exercise here", signal);
    await event;
    const messages = await context.messages(signal);
    assert.ok(messages.length > 0);
  }, { dependsOn: ["prompt"], timeoutMs: 180_000 });
}
```

Use a concrete assertion for the feature, not just request acceptance or
the example's message count. Subscribe to events **before** the action.
Waits observe future events only; old idle/delta frames cannot satisfy a new
turn. The base connector currently streams deltas as
`message.part.updated` with `properties.delta`, not `message.part.delta`.

Prerequisites must already be registered. `--only` includes their transitive
closure, marks other checks SKIP, and rejects unknown names. A failure or
timeout marks FAIL and skips the remainder to prevent actions on a broken
session. Every check receives an AbortSignal; pass it through all HTTP calls
and event waits. Checks default to 120 seconds. Idle reaping alone allows
420 seconds for two prompts plus PID disappearance bounded to 150 seconds
(30-second idle threshold, 60-second reaper interval).

The shared context supplies `sessionId()`, `work`, `marker`, `api<T>()`,
`prompt()`, `messages()`, `waitForEvent()`, `idle()`, and `delta()`. HTTP calls
with no body are GET; calls with a body are POST. The created session remains
available after the base restart and reaping checks. The final shutdown check
asserts disappearance before fallback cleanup can hide a lifecycle failure.

Cleanup samples descendants of its own connector launcher and remembers PID
start times and process groups. Reparented processes are adopted only when
`/proc/<pid>/cwd` is inside this run's unique root AND `/proc/<pid>/environ`
contains an exact private HOME or coding-agent directory. A command-line match
alone never establishes ownership. The supervisor flag and multi-session flag
classify owned hosts, and the exact OmO LSP daemon entrypoint classifies the
detached language service; ordinary `--mode rpc` and unknown processes remain
strict shutdown failures. Cleanup asserts no owned processes remain before
removing the workspace. It never kills by command-line pattern.
Linux `/proc` and GNU `tail --pid` are required for lifecycle checks.

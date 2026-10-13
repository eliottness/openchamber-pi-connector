# OmO smoke checks

Run from the repository with Node 22 or newer:

```sh
OCPI_PI_BINARY=/path/to/omo npm run omo-smoke
OCPI_PI_BINARY=/path/to/omo npm run omo-smoke -- --only prompt,abort
OCPI_PI_BINARY=/path/to/omo npm run omo-smoke -- --only shutdown
```

`PI_CODING_AGENT_DIR` selects the existing agent directory for read-only
discovery (default `/home/eliott/.omo/agent`). New sessions use a private
copy of small configuration and credential files, a private HOME, and
connector state under `/tmp/ocomo-qa/smoke-<timestamp>-<suffix>`. No existing
session receives prompts. The private directory, including credentials,
is removed on completion, failure, SIGINT, or SIGTERM.

OmO uses the copied configuration unchanged, including speculative task-host
prewarming. Detached task-host supervisors and their multi-session engines have
a 15-minute idle policy after their last client leaves. These shards belong to
their parent session tree: the connector stops hosts for sessions it created.
Shutdown fails if any connector session RPC group, private task host or unknown
process survives SIGTERM, **before harness cleanup runs**.
The LSP daemon is shared by HOME/version across sessions and projects. It and
its observed descendants, outside recorded connector RPC groups, are reported with PID and
command line as `NON-CONNECTOR OmO-owned, outside connector scope`; the installed
daemon's idle policy is 30 minutes. The separate final cleanup removes these
test-owned helpers from the private HOME. That cleanup is never counted as
connector shutdown success. See `docs/architecture.md` for ownership evidence.
Inherited RPC socket, watchdog, and
cleanup-path variables are stripped so QA cannot attach to the caller's host.
The isolated HOME passes OmO's documented onboarding-disable CLI flag and
seeds the private onboarding-completed marker for detached task hosts, which do
not inherit wrapper CLI flags. The smoke tests product behavior, not the
first-run tour, and an onboarding turn would otherwise race prompt-specific
idle events or be archived instead of the requested child-task transcript.

Part B1 adds tool-card input/history checks, phased todos, one foreground quick
subagent with live child tools and an archived transcript, allow-once and deny
approvals, and conversation-only fork/revert/unrevert with a file SHA256 check.
The approval check temporarily restarts with `--permission-preset ask` and an
explicit `--permission read=ask` rule, because copied rules override presets.
It does not change any configuration file.

Part B2 checks the non-empty command catalog, shell output and exit codes,
unavailable sharing, populated/empty compaction, and the new compaction entry
in HTTP history. A private Git fixture checks tracked and untracked file diffs
and their post-turn SSE snapshot. The HTTP route sweep reads method/path pairs
from `docs/omo-endpoint-inventory.md`; live permission/question requests supply
real IDs for lifecycle routes. Routes marked observed/called must never return
404/501. Static-only SDK routes are informational but must not return 500; the
run prints their exact statuses for evidence. Unsupported called capabilities
must return 400 rather than fabricated successful mutations. Shutdown depends
on the entire check chain. Final acceptance is two consecutive unfiltered runs
with every check PASS and zero SKIPs.

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

`--only shutdown` runs only a private connector/session startup and shutdown;
it sends no model prompt and does not run the full smoke chain. Unfiltered
shutdown still depends on the entire chain.

Prerequisites must already be registered. Other `--only` selections include their transitive
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
classify private hosts, and the exact OmO LSP daemon entrypoint classifies the
shared language service outside RPC groups; task hosts, ordinary `--mode rpc`
and unknown processes remain strict shutdown failures. Cleanup asserts no owned processes remain before
removing the workspace. It never kills by command-line pattern.
Linux `/proc` and GNU `tail --pid` are required for lifecycle checks.

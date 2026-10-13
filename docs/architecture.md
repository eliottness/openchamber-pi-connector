# Architecture

## Goal

OpenChamber talks to an OpenCode server over HTTP + SSE via
`@opencode-ai/sdk/v2`. The pi coding agent exposes headless operation via RPC
mode (`pi --mode rpc`, JSONL over stdin/stdout) and an in-process SDK
(`AgentSession` from `@earendil-works/pi-coding-agent`).

`openchamber-pi` bridges the two:

```
OpenChamber ──HTTP/SSE (OpenCode API subset)──▶ openchamber-pi ──JSONL stdio──▶ pi --mode rpc
```

OpenChamber is configured to use an **external OpenCode server** pointing at
this adapter. No OpenChamber fork, no pi fork.

## Two backend strategies

| Strategy | Mechanism | Pros | Cons |
|---|---|---|---|
| SDK embed | `AgentSession` in-process | No subprocess overhead, typed API | Ties adapter lifecycle to pi internals |
| RPC subprocess | spawn `pi --mode rpc` per session | Process isolation, version-tolerant, language-stable protocol | One process per session, JSONL framing rules (LF-only) |

Default: **RPC subprocess** (pi documents strict JSONL framing; Node `readline`
is not compliant because it splits on U+2028/U+2029 — we split on `\n` only).
SDK embed stays an option behind the same internal interface.

## Mapping concerns

### Session model

- OpenCode: one server, many sessions, sessions belong to a directory/project.
- pi: one process per session; session persistence as JSONL files
  (`--session-dir`, `switch_session`, `fork`).
- Adapter owns a process pool keyed by session id, and a directory registry
  mapping OpenCode "project/directory" to pi working directory + session dir.

### OmO session tree

Fork/revert/unrevert use `get_entries` (`entries`, `leafId`) and OmO's
session-tree RPCs. Explicit-message `fork {entryId}` copies the history before
the selected user message. OpenChamber restores that prompt into its composer,
matching OmO's default `"before"` position; including an unanswered user tail
would make the UI report a failed reply. With no messageID, `position: "at"`
includes the complete active leaf. Fork returns `{cancelled}` (and sometimes `text`), not
the new identity: the connector reads `get_state.sessionId/sessionFile`.
The RPC process switches to that new file. It is transferred to the forked
OpenChamber session; the original becomes dormant and resumes its original
file in its own process when next used.

The connector records OpenChamber messageID -> OmO entry id in its registry,
preserving client-generated live IDs across restarts. Restored messages
without a recorded mapping use the existing `msg_r<JSONL offset>` scheme.
Revert navigates to the selected user's parent with `intent: "resume"`:
without that intent OmO's tree selection would skip user/custom-message
parents. The registry saves the previous leaf, current leaf, and cutoff
messageID. Repeated revert retains the original redo leaf. Unrevert restores
it; a new prompt clears the cutoff and starts a branch at the earlier leaf.
Revival reapplies the saved leaf rather than assuming the newest JSONL
message is the active branch. The reverted transcript is retained for redo.

Revert only changes conversation context. It never invokes a filesystem
restore, snapshot, or diff operation. An adapter-only informational text
message before the cutoff says "Conversation reverted. Files were not
changed." and is not sent to the model. Unknown messageIDs are rejected with
HTTP 400 before navigation.

History refreshes and compact/bash RPCs share the conversation-operation queue
with prompt, fork, revert and unrevert. A refresh cannot read an intermediate
navigation state or overwrite the cursor before its operation completes.
An abort can release a queued shell's HTTP waiter immediately, but cannot
release that ordering barrier: when the predecessor completes, the cancelled
entry rejects before dispatching any bash RPC. Later operations still wait for
the predecessor. A dispatched shell continues to use `abort_bash`.

Adapter-authored shell cards and notices are retained in canonical in-memory
history, not appended to the revert-notice projection. While reverted, new
cards are inserted before the hidden redo branch and belong to the last visible
user turn, so completed shell output remains rendered. Refresh, unrevert and a
replacement prompt retain these cards; they are never matched to OmO JSONL
entries or sent to the model. This retention lasts for the connector process,
not across connector restarts: adapter-only cards are not persisted transcripts.

### Event translation

| OpenCode (SSE `event`) | pi (stdout JSONL) |
|---|---|
| `message.updated` / `message.part.updated` | `message_update` (`assistantMessageEvent`: `text_delta` etc.) |
| `message.part.updated` (tool part) | `message_update` (`toolcall_start`/`toolcall_delta`/`toolcall_end`) + `turn_end` (`toolResults[]` by `toolCallId`) — **M2** |
| `session.status` / `session.idle` | turn lifecycle events (`agent_start`/`agent_end`-family) |
| `permission.asked` | pi extension-UI sub-protocol (`extension_ui_request`/`extension_ui_response`) — semantics differ, map conservatively |
| `session.error` | `extension_error`, RPC error responses |

The asynchronous prompt route keeps its HTTP 204 contract. If prompt submission
rejects, including a registry write before RPC dispatch, it emits `session.error`
and appends an assistant error message to canonical session history. The error
name and message are available through both SSE and the message GET route; a
failed disk write does not depend on another successful disk write to report
the failure. These adapter-authored error cards have the in-memory retention
described above, not restart durability.

### Shutdown ownership

The connector owns its per-session RPC process groups. It also owns detached
task-host shards for parent sessions it **created**, including forks. It does
not claim task hosts for sessions discovered/restored from another OmO client.
The registry saves `connectorOwned: true` for new sessions and forks so this
ownership survives connector restart. Unmarked legacy/discovered sessions are
not retroactively claimed.
Created session IDs remain tracked after removal or idle reaping, so their
private hosts are still covered by final connector shutdown.

This is a split ownership decision based on the installed OmO implementation
inspected on October 13, 2026:

- `omo-ai/plugin/extensions/omo-task.js`, bundled functions `P2`, `A2`, `nI`
  and `bq`: a root task shard is `p-<key>.sock`, where `key` is the first
  16 hex characters of SHA-256 of `"p:" + parentSessionId`. Nested children
  inherit `shard_key` and attach to that same parent tree. Independent parent
  sessions get different shards, even within one project. The sidecar records
  `owner_session_id`, `owner_session_file` and participating task stores.
- `@code-yeongyu/senpi/dist/modes/rpc/host-ensure-start.js:51-64` detaches
  the supervisor. `host-lifecycle.js:362-393` spawns its engine without
  detaching it again; both therefore belong to the supervisor's process group.
  `host-lifecycle-policy.js:1-7` defines the default 15-minute idle window.
  The general host mechanism can serve multiple clients; that alone does not
  make a connector-created parent shard shared with unrelated parent sessions.
- `omo-ai/plugin/runtime/lsp-daemon/dist/paths.js:43-66` keys the LSP
  endpoint by HOME (or its explicit daemon-directory override) and package
  version, not by a session or project. `request-routing.js:12-29,70-81`
  supplies per-request context to the same daemon.
  `ensure-daemon.js:22-36,100-122` probes/reuses it and detaches only on
  startup. Killing it would interrupt other OmO sessions/projects.
  `daemon-server.js:11-15,74-89` actually specifies **30 idle minutes**,
  with connections and LSP clients preventing expiry. It is not the task
  supervisor's 15-minute policy. `index.js:565-582` also detaches the daemon's
  language servers; their observed parent ancestry, not just one process group,
  establishes that they belong to the same shared LSP infrastructure.

After its RPC groups stop, the connector finds private supervisors by the
exact shard basename derived from a newly created session ID plus that
session's working directory. It requires a detached group leader and records
Linux PID start times before signalling that group. Shutdown subscribes to
member death, sends SIGTERM, and escalates after five seconds with a ten-second
deadline. It refuses to signal any observed member of `openchamber.service`.
No broad command-line kill is used. The real-process regression proves that a
different session's supervisor and engine in the same directory stay alive.
Linux `/proc` and GNU `tail --pid` are required for this deployment's teardown.

The smoke assertion runs **before any harness termination**. Surviving RPC
groups, private task hosts and unknown processes fail immediately. Only the
shared LSP daemon and its observed descendants, outside recorded RPC groups, are reported as
`NON-CONNECTOR OmO-owned, outside connector scope`, with PID and command line.
That report is not evidence of connector teardown. The harness later cleans
its private HOME's helpers in its separate `finally` cleanup; cleanup can
never turn a failed shutdown assertion into a PASS.

### User shell cancellation and extension commands

The installed OmO RPC exposes two different abort commands. `abort` acknowledges
an agent-turn interruption but does not stop a user `bash` RPC. `abort_bash`
aborts the active user-shell execution. Probes on 2026-10-13 with
`omo --mode rpc --no-session --model anthropic/claude-haiku-4-5` observed:

- `abort` returned `{success: true}` while the same OS `sleep 600` process
  remained alive and the bash request remained unanswered.
- In a separate probe, `abort_bash` returned `{success: true}` and the pending
  bash returned `{output: "", cancelled: true, truncated: false}` within
  10 milliseconds. Both observed sleep PIDs were gone after `abort_bash`.
  A cancelled result can omit `exitCode`; the adapter normalizes it to `null`.

The connector dispatches `abort_bash` for an active shell before ordinary
`abort`, releases its correlated bash waiter immediately, and emits an error
tool state with `metadata.cancelled: true` and `Command cancelled`. The composer
returns to idle without waiting for the 60-second transport deadline. Removing
the correlation and its timeout prevents a late response from completing or
duplicating the cancelled card, reloading history, or changing a resumed turn.
The same abort signal covers the follow-up history and navigation RPCs, so
Stop also releases a shell whose bash result arrived but whose history refresh
is still pending. Aborted refresh replies are discarded before history mutation.
The adapter dispatch is not itself proof that an arbitrary remote shell has
stopped; the real local OmO probe and manual QA check the OS process as well.

Print-only extension commands do not necessarily emit `agent_start` or
`agent_end`. The real `get_commands` catalog includes `/ttsr`, which reports
its status through `extension_ui_request {method: "notify"}` and returns
`prompt {success: true, data: {disposition: "handled"}}`. The connector renders
notifications received during a slash invocation as assistant text and treats
that handled response as completion, returning the session to idle. Prompts
that start an agent turn still use the agent lifecycle events for completion.

The full probe transcript is
`~/.omo/evidence/openchamber-omo-connector/task-18/rpc-probe.jsonl`; browser
captures and timings are in the same directory. This is a connector-only
mapping of the installed OmO protocol, not a change to OmO or its settings.

### Capability gaps to decide explicitly

- **Permissions/questions**: OpenCode has permission prompts and elicitation;
  pi handles interactive prompts through its extension-UI protocol. The
  adapter must map or auto-resolve these deterministically.
- **Todos / file diffs**: OpenCode exposes todo and file-diff state that
  OpenChamber renders. pi emits tool-call events; the adapter reconstructs
  file-change state from edit/write tool calls.
- **Models/providers**: OpenCode `/provider` and `/config` endpoints vs pi's
  `get_available_models` / `set_model`. Adapter translates at the boundary.
- **Compaction**: pi `compact` / `set_auto_compaction` ↔ OpenCode
  `session.summarize`.

## Milestones

1. **M0 — API inventory**: enumerate the exact OpenCode endpoints/event types
   OpenChamber consumes (see `docs/api-surface.md`).
2. **M1 — Session CRUD + prompt round-trip**: create session, send prompt,
   stream text deltas as SSE, abort. Enough for OpenChamber to show a chat.
3. **M2 — Tool calls & file changes**: translate tool events; diffs visible.
   ✅ tool parts (2026-09-21): streamed `toolcall_*` → OpenCode tool parts
   with the SDK v2 `ToolState` union; results matched by `toolCallId` from
   `turn_end.toolResults`; dangling parts finalized as errors on abort/exit.
   File-diff surfacing beyond tool parts is still open.
4. **M3 — Permissions/questions bridge**.
5. **M4 — Model listing/switching, session stats, compaction**.
6. **M5 — Packaging**: `npx openchamber-pi`, docs, CI, npm publish.

## Reference sources

Upstream repos are shallow-cloned into `reference/` (gitignored) for local
inspection:

- `reference/openchamber` — https://github.com/openchamber/openchamber
- `reference/pi-mono` — https://github.com/badlogic/pi-mono

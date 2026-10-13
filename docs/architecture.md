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

# OpenChamber 1.24.2 / OmO endpoint inventory

## Capture and scope

Task 2, captured on October 12, 2026 (UTC), against connector commit
`3a0c8aa` on branch `w1-t2`. Installed package metadata confirms
`@openchamber/web` version `1.24.2`.

**59 distinct method/path pairs: 36 observed against the connector and 23
static-only. Every observed 404/501 has an owning todo.** Query strings are
normalized away; session/request/provider identifiers are placeholders.

The table contains the OpenCode routes seen in the connector log, plus SDK and
inline callers found in the installed UI bundle. Static-only means that no
request was issued for that action during QA, not that the route succeeds.
A probe is a direct HTTP request against the same real QA session, rather than a
browser click. Safe GET replays supplied explicit response statuses because the
connector's debug logger records requests but not responses. Browser fetch
instrumentation supplied mutation statuses. This is a route/ownership inventory,
not a claim of complete feature parity.

`unavailable` describes a missing capability with a graceful empty response,
not an unreachable HTTP route. LSP and formatter status return 200 with `[]`,
which the UI handles; the connector provides neither capability.

The bundle also contains unused generated SDK routes, including a second API
contract. They are preserved in `sdk-route-definitions.json` as discovery evidence
but are not counted as UI callers. The two explicit v2 permission callers in the
current application are included below as static-only.

OpenChamber proxies legacy OpenCode requests from browser `/api/<path>` to
connector `/<path>`. Rows with an explicit `/api/session/.../permission` path
refer instead to the alternate connector API contract. Native OpenChamber routes
are distinguished in the surface notes below; they are not connector gaps.

## Verified launch contracts

- `bin/lib/cli-paths.js:9-24` resolves `OPENCHAMBER_DATA_DIR` and reads
  `<data-dir>/settings.json`; `server/index.js:280-323` uses the same user
  config root and settings path.
- `server/lib/opencode/env-runtime.js:1010-1070` applies executable
  `settings.opencodeBinary` to `OPENCODE_BINARY`, with source `settings`.
  QA settings point to
  `/home/eliott/git/openchamber-pi-connector-wt/t2/bin/opencode-pi`.
- `server/lib/opencode/env-config.js:28-31` accepts `OPENCODE_PORT`;
  `lifecycle.js:673-674` uses it for the managed connector launch. The startup
  receipt showed `serve --hostname 127.0.0.1 --port 57161` with the t2 binary.
- Connector `src/server.ts:23,44-45,158` checks truthiness of `OCPI_DEBUG`
  and writes to `OCPI_DEBUG_LOG` (default `/tmp/openchamber-pi-debug.log`).
  `src/sessions.ts:587-590` independently writes pi event excerpts to the
  same environment-selected path. Neither write catches filesystem failures.
- `src/pi-rpc.ts:62-70` spawns `OCPI_PI_BINARY` in the requested directory
  and inherits the environment. QA used the installed `omo`, not plain pi.
  `PI_CODING_AGENT_DIR` was not set or relied upon: todo 3 owns that support.

All runtime paths were under `/tmp/ocomo-qa/t2`: data `ocdata`, cwd `work`,
state `state`, debug log `debug.log`. OpenChamber listened on
`127.0.0.1:57160`; the connector used `57161`, and the failure scenario
used `57162`. Port `57163` was unused. No UI password was set. No installed
OpenChamber files, OmO settings, connector source, or sibling worktrees changed.

One new session, `ses_911015be4d749a6162979d72dda14840`, was created with cwd
`/tmp/ocomo-qa/t2/work`. The initial prompts used the picker's dated
`anthropic/claude-haiku-4-5-20251001` entry. The first returned
`T2 inventory ready.` with reasoning/text streaming; the second exercised the
OmO `todo` tool and returned `T2 todo ready.`. A model-selection check initially
retained that dated entry. The final prompt explicitly requested the required
`anthropic/claude-haiku-4-5` alias and returned `T2 requested alias ready.`;
OmO resolved its assistant model to `claude-haiku-4-5-20251001`. The exact
request and resolution are saved in `exact-model-receipt.json`. All four prompts
used Haiku 4.5. No file-editing prompt was sent.

## Route inventory

| Method | Path pattern | Observed status | Calling UI surface | Disposition |
| --- | --- | --- | --- | --- |
| GET | `/global/health` | 200; unwritable-log run: connection reset | Startup health checks | implemented |
| GET | `/global/event` | 200 (SSE) | Global session/message synchronization | implemented |
| GET | `/global/config` | 200 ({}) | Bootstrap global configuration | implemented |
| GET | `/project` | 200 | Workspace/project bootstrap | implemented |
| GET | `/project/current` | 200 | Workspace context | implemented |
| GET | `/path` | 200 | Workspace directory resolution | implemented |
| GET | `/config` | 200 ({}) | Workspace/settings bootstrap | implemented |
| GET | `/config/providers` | 200 | Model picker and provider settings | implemented |
| GET | `/provider` | static-only; not requested | Settings provider.list / SDK fallback | implemented |
| GET | `/agent` | 200 | Agent picker and Agents settings | implemented |
| GET | `/experimental/session` | 200 | Session list, archive browser; roots/archived/limit queries | implemented |
| GET | `/session` | 200 (probe) | SDK session.list fallback; static UI caller | implemented |
| GET | `/session/status` | 200 | Session list and turn status | implemented |
| POST | `/session` | 200 | First send creates one session in QA work directory | implemented |
| GET | `/session/{sessionID}` | 200 | Session selection and metadata reload | implemented |
| PATCH | `/session/{sessionID}` | 200 | Rename; SDK archive metadata update | implemented |
| DELETE | `/session/{sessionID}` | static-only; not requested | Delete session; not exercised to retain the QA transcript | implemented |
| GET | `/session/{sessionID}/message` | 200 | Message history, context/tokens inspector | implemented |
| POST | `/session/{sessionID}/prompt_async` | 204 | Haiku prompts, exact alias verification, text/reasoning streaming and todo tool cards | implemented |
| POST | `/session/{sessionID}/message` | static-only; not requested | Synchronous session.prompt fallback | implemented |
| POST | `/session/{sessionID}/abort` | 200 (probe) | Stop generation SDK action; idle-session probe | implemented |
| GET | `/permission` | 200 ([]) | Bootstrap pending approvals; no live approval card | todo 8 (permission/question) |
| POST | `/permission/{requestID}/reply` | static-only; not requested | Approval Allow once / Allow always / Deny / feedback actions | todo 8 (permission/question) |
| GET | `/question` | 200 ([]) | Bootstrap pending questions; no live question card | todo 8 (permission/question) |
| POST | `/question/{requestID}/reply` | static-only; not requested | Question answer submission | todo 8 (permission/question) |
| POST | `/api/session/{sessionID}/permission` | static-only; not requested | Bundled v2 permission.create compatibility branch | todo 8 (permission/question) |
| GET | `/api/session/{sessionID}/permission/{requestID}` | static-only; not requested | Bundled v2 permission.get compatibility branch | todo 8 (permission/question) |
| POST | `/question/{requestID}/reject` | static-only; not requested | Question rejection | todo 8 (permission/question) |
| GET | `/session/{sessionID}/todo` | 501 (probe) | Tasks section; static-only SDK caller, section stays absent after OmO todo | todo 6 (todo routes) |
| POST | `/session/{sessionID}/fork` | 501 | Fork from this message | todo 10 (fork/revert) |
| POST | `/session/{sessionID}/revert` | 501 | Revert to this message; optimistic UI restores original transcript | todo 10 (fork/revert) |
| POST | `/session/{sessionID}/unrevert` | static-only; not requested | Redo/unrevert after a successful revert | todo 10 (fork/revert) |
| GET | `/command` | 200 ([]) | Slash menu and Commands settings; empty connector command catalog | todo 11 (compact, shell, command, share) |
| POST | `/session/{sessionID}/command` | static-only; not requested | Backend command execution; no configured connector commands | todo 11 (compact, shell, command, share) |
| POST | `/session/{sessionID}/shell` | 501 | !printf T2-shell in composer | todo 11 (compact, shell, command, share) |
| POST | `/session/{sessionID}/summarize` | 501 | /compact system command | todo 11 (compact, shell, command, share) |
| POST | `/session/{sessionID}/share` | 501 | Session actions > Share; not cleanly unavailable yet | todo 11 (compact, shell, command, share) |
| DELETE | `/session/{sessionID}/share` | static-only; not requested | Unshare; unreachable because Share fails | todo 11 (compact, shell, command, share) |
| GET | `/session/{sessionID}/diff` | 501 (probe) | Changes panel; current empty non-git surface uses native Git API | todo 12 (diff + everything else) |
| GET | `/file` | 404 (probe) | Files SDK route; native Files browser still renders empty work directory | todo 12 (diff + everything else) |
| GET | `/find/file` | 404 (probe) | SDK file search and file mentions; inline /api/find/file caller | todo 12 (diff + everything else) |
| GET | `/skill` | 404 | Bootstrap skill probe; Skills settings/menu use native config APIs | todo 12 (diff + everything else) |
| GET | `/provider/auth` | 404 (probe) | Providers authentication methods; static UI caller | todo 12 (diff + everything else) |
| PUT | `/auth/{providerID}` | static-only; not requested | Providers API key connection; no credentials changed | todo 12 (diff + everything else) |
| POST | `/provider/{providerID}/oauth/authorize` | static-only; not requested | Providers OAuth connection; no authentication started | todo 12 (diff + everything else) |
| POST | `/provider/{providerID}/oauth/callback` | static-only; not requested | Providers OAuth completion | todo 12 (diff + everything else) |
| PATCH | `/config` | static-only; not requested | SDK configuration update; no backend config edited | todo 12 (diff + everything else) |
| GET | `/mcp` | 200 ({}) | MCP bootstrap/status; native settings show existing MCP definitions | todo 12 (diff + everything else) |
| POST | `/mcp/{name}/connect` | static-only; not requested | MCP connect; no global server connections changed | todo 12 (diff + everything else) |
| POST | `/mcp/{name}/disconnect` | static-only; not requested | MCP disconnect | todo 12 (diff + everything else) |
| POST | `/mcp/{name}/auth` | static-only; not requested | MCP OAuth start | todo 12 (diff + everything else) |
| DELETE | `/mcp/{name}/auth` | static-only; not requested | MCP authentication removal | todo 12 (diff + everything else) |
| POST | `/mcp/{name}/auth/callback` | static-only; not requested | MCP OAuth callback | todo 12 (diff + everything else) |
| POST | `/mcp/{name}/auth/authenticate` | static-only; not requested | MCP OAuth authenticate action | todo 12 (diff + everything else) |
| POST | `/experimental/control-plane/move-session` | static-only; not requested | Runtime/session relocation; not available in isolated single workspace | todo 12 (diff + everything else) |
| GET | `/experimental/tool/ids` | static-only; not requested | Agent/settings available-tools picker | todo 12 (diff + everything else) |
| GET | `/lsp` | 200 ([]) | Bootstrap language-server status; handled empty list | unavailable |
| GET | `/formatter` | 200 ([]) (probe) | SDK formatter status; handled empty list | unavailable |
| GET | `/vcs` | 200 ({}) | Git/context bootstrap for non-git work directory | implemented |

## UI surface coverage and native routes

Every surface named in task 2 was opened or invoked. Screenshots are in
`~/.omo/evidence/openchamber-omo-connector/task-2/`; the evidence summary
maps each capture to its surface.

- Session list and first send: the initial list was empty, as allowed before
  todo 3. The newly created session appeared in the sidebar and streamed a
  real OmO reply. The initial non-latest Haiku 4.5 entry maps to a dated ID;
  the final verified selection used the requested alias, labeled "(latest)".
- Files, Changes/diff, Git, Terminal: the QA directory is empty and not a Git
  repository. Native filesystem and Git surfaces showed that state; a native
  terminal opened in the QA work directory. These features use OpenChamber's
  `/api/fs/*`, `/api/git/*`, and `/api/terminal/*` APIs. Terminal activity
  is not evidence that connector `/session/{sessionID}/shell` works.
- Tasks/todo: the Tasks section was enabled in the work-status panel. Real OmO
  todo calls appeared as generic `Todo todo` cards, but no Tasks list appeared.
  The static `session.todo` caller and a 501 probe identify todo 6's gap.
- Context/tokens: the inspector showed Haiku, two initial messages, context
  usage, cost, and input/output/reasoning/cache token counts.
- Settings: Providers, Agents, Commands, MCP, and Skills were opened read-only.
  Native `/api/config/agents/*`, `/api/config/commands/*`,
  `/api/config/mcp`, `/api/config/skills`, and provider-source APIs explain
  why these panels can display definitions despite empty or missing connector
  routes. The 54 skills shown are not proof that connector `GET /skill` works.
- Fork and revert: both message actions were invoked and returned 501.
  Failed revert restored the transcript after its optimistic change.
- Slash menu, shell, compact, share: the slash menu displayed native skills and
  system commands despite the empty backend command list. `!printf T2-shell`,
  `/compact`, and Share each reached their connector route and returned 501.
  No share was published. Unshare and redo remain static-only.
- Rename succeeded via connector PATCH. Archive and restore succeeded via
  native `POST /api/openchamber/sessions/archive` and archive-list refreshes;
  this UI's local archive behavior must not be confused with connector archival
  persistence. The connector's SDK metadata-update path is separately listed.

Desktop captures include the initial browser viewport (1280x713) and a verified
1280x800 overview; phone captures use verified 390x844. Both renders were read
back visually. No blank or overlapping session surface was seen. A long native
terminal prompt wraps on the phone. Header title briefly fell back to
`Untitled Session` after reload while the renamed sidebar entry persisted;
this pre-existing metadata issue is recorded for todo 12.

## Failure QA: unwritable debug log

**FAIL: debug logging is fatal in the task-2 baseline.** With
`OCPI_DEBUG=1 OCPI_DEBUG_LOG=/proc/nope.log`, the connector announced that it
was listening on `127.0.0.1:57162`. Its first `GET /global/health` closed
without an HTTP response, and the process exited with code 1:

`Error: ENOENT: no such file or directory, open '/proc/nope.log'`

The stack points to `src/server.ts:45:31` and `src/server.ts:158:5`.
The logger runs before the router's try/catch. A subsequent health request could
not connect. The normal writable-log instance returned 200 with
`{"healthy":true}`. The separate event logger has the same unchecked-write
risk at `src/sessions.ts:590`.

Owner: **todo 12 (everything else)**. Source changes are expressly excluded from
task 2, so this inventory documents the failure rather than masking it or
claiming health survived. Full failure receipt and request excerpts accompany
the screenshots.

## Verification

`npm ci` passed with 0 vulnerabilities. `npm run build` and `npm test`
passed once under Node 22.23.1 (1 test, 0 failures). No new test was added for
this documentation-only change. Table validation found 59 unique pairs and
zero unowned 404/501 rows. Static-only actions, successful live abort latency,
nonempty Git diffs, permissions/questions, and successful unsupported mutations
remain unverified; their owners are explicit above. Cleanup and commit receipts
are recorded in the external evidence summary.

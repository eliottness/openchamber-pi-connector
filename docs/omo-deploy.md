# OpenChamber OmO deployment

## Current deployment

- Connector tag: `omo-v6`, commit `3292897`.
- Deployment worktree: `/home/eliott/.local/share/openchamber-omo/connector-v6`.
- Retained rollback worktrees:
  - `/home/eliott/.local/share/openchamber-omo/connector` (`omo-v1`)
  - `/home/eliott/.local/share/openchamber-omo/connector-v3` (`omo-v3`)
  - `/home/eliott/.local/share/openchamber-omo/connector-v4` (`omo-v4`)
  - `/home/eliott/.local/share/openchamber-omo/connector-v5` (`omo-v5`)
- Settings file: `~/.config/openchamber/settings.json`.
- Retained settings backups: `settings.json.pre-omo`, `settings.json.pre-v3`,
  `settings.json.pre-v4`, `settings.json.pre-v5`, and `settings.json.pre-v6`.
  The pre-v6 backup points to the v5 backend.
- Backend setting:

  ```json
  {
    "opencodeBinary": "/home/eliott/.local/share/openchamber-omo/connector-v6/bin/opencode-pi"
  }
  ```

OpenChamber starts its existing user service on port 4096 with `--lan`. The
unit file is unchanged; OmO-specific process settings live in
`~/.config/systemd/user/openchamber.service.d/omo.conf`:

```ini
[Service]
Environment=PATH=/home/eliott/nvm/versions/node/v22.23.1/bin:/home/eliott/.bun/bin:/home/eliott/.bun/install/global/node_modules/.bin:/home/linuxbrew/.linuxbrew/bin:/home/eliott/.local/bin:/usr/local/bin:/usr/bin:/bin
Environment=OCPI_PI_BINARY=/home/eliott/.bun/install/global/node_modules/.bin/omo
Environment=PI_CODING_AGENT_DIR=/home/eliott/.omo/agent
Environment=OCPI_STATE_DIR=/home/eliott/.config/openchamber-pi-connector
Environment=OCPI_AGENT=OmO
Environment=OCPI_IDLE_TIMEOUT_MS=900000
Environment=OCPI_MAX_LIVE=8
KillMode=control-group
TimeoutStopSec=20
```

The UI password remains in the existing service unit. Do not copy it into the
drop-in or this document.

## Private-host teardown prerequisite

On Linux, connector-owned OmO task hosts require `/bin/python3` with
`os.pidfd_open` and `signal.pidfd_send_signal` (Python 3.9+, Linux 5.3+).
The WSL2 deployment has Python 3.12 and Linux 6.18. Node 22 has no pidfd API,
so shutdown starts one isolated, standard-library-only Python helper, bounded
to 15 seconds. It inherits the verified hosts' open proc directories, opens
and validates pidfds, then uses only those pidfds for TERM/KILL and exit
notifications. It does not signal a service cgroup or a shared LSP daemon.

This is an operating-system runtime dependency, not an npm dependency. If
Python or pidfd support is unavailable, private-host teardown rejects with an
error and sends no host signals; it never falls back to numeric PID signalling.
Keep this prerequisite when moving the service to another machine.

## Child transcripts and empty Changes bodies

OmO process-backed children report `host_session.session_path`. In-process
children, including the `explore` agent observed during F3, instead report
`child_session_id`; their JSONL lives in the owning task store at
`children/<task_id>/sessions/<task_id>/<timestamp>_<child_session_id>.jsonl`.
The connector resolves both forms, tails the transcript while the task runs,
and archives it to `$OCPI_STATE_DIR/children/<task_id>.jsonl` at completion.
The task record must belong to the parent session. A transcript for another
retained run is not a substitute for the recorded child session.

OpenChamber's workspace **Changes** panel is distinct from the connector's
session-diff API. In the installed version inspected during F3:

- Connector `GET /session/:id/diff` (proxied as `/api/session/:id/diff`) returns
  `before`, `after`, counts, and a unified `patch`. Its Git invocation already
  uses `--no-ext-diff`.
- Workspace Changes obtains file bodies from OpenChamber's own
  `GET /api/git/diff?directory=...&path=...`. That invocation honors
  `diff.external`; `diff.external=difft` produces human-readable side-by-side
  text rather than the unified patch the panel expects. Counts still work,
  but expanding a file can show an empty body.

Diagnose this by comparing the two raw responses and checking
`git config --show-origin --get diff.external` in the affected repository.
If the connector response has `@@` hunks but the native response has a
`filename --- Text` header, changing connector payloads cannot repair that
panel. The environment must provide ordinary unified Git output to
OpenChamber, or OpenChamber's native Git invocation must disable external
diff drivers. Keep `difft` available as an explicit terminal command instead
of a global `diff.external` setting if both uses are needed.

F3's controlled proof launched only its throwaway OpenChamber with
`GIT_CONFIG_GLOBAL=/dev/null`: native unified hunks and the expanded panel
returned. This is an isolation experiment, not a recommended production
setting; it also ignores unrelated global Git settings. F3 did not change
the user's Git configuration, installed OpenChamber, or live service.

## Upgrade to a new connector tag

Keep the current deployment worktree in place while preparing the next tag in
a separate versioned worktree. Run the OmO smoke before changing
`opencodeBinary`; it requires `OCPI_PI_BINARY` to name the OmO executable.

```bash
set -euo pipefail
tag=omo-v7
version="${tag#omo-}"
repo="$HOME/git/openchamber-pi-connector"
deploy="$HOME/.local/share/openchamber-omo/connector-$version"

git -C "$repo" fetch --tags origin
git -C "$repo" worktree add "$deploy" "$tag"
cd "$deploy"
npm ci && npm run build
OCPI_PI_BINARY="$HOME/.bun/install/global/node_modules/.bin/omo" npm run omo-smoke
```

Require the smoke command to exit 0 with no failed or skipped checks. Only
after build and smoke pass, preserve the current settings and atomically point
OpenChamber at the new worktree. Do not overwrite an existing backup:

```bash
settings="$HOME/.config/openchamber/settings.json"
backup="$settings.pre-$version"
test ! -e "$backup"
cp -p "$settings" "$backup"
tmp=$(mktemp "${settings}.XXXXXX")
jq --arg binary "$deploy/bin/opencode-pi" \
  '.opencodeBinary = $binary' "$settings" > "$tmp"
chmod --reference="$settings" "$tmp"
mv "$tmp" "$settings"
systemctl --user restart openchamber
```

Within three minutes, confirm `systemctl --user is-enabled openchamber` and
`systemctl --user is-active openchamber` succeed and
`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4096/` returns 200
or 401. Keep the prior deployment worktree available until the new tag is
accepted.

## Roll back to a previous OmO tag

To return from v6 to the retained v5 worktree without removing the OmO service
configuration, change only `opencodeBinary` and restart:

```bash
set -euo pipefail
settings="$HOME/.config/openchamber/settings.json"
previous="$HOME/.local/share/openchamber-omo/connector-v5"
tmp=$(mktemp "${settings}.XXXXXX")
jq --arg binary "$previous/bin/opencode-pi" \
  '.opencodeBinary = $binary' "$settings" > "$tmp"
chmod --reference="$settings" "$tmp"
mv "$tmp" "$settings"
systemctl --user restart openchamber
```

Verify the service is active and the local HTTP check returns 200 or 401.
Keep all versioned worktrees until the deployment no longer needs them for
rollback.

## Roll back to plain OpenCode

The plain OpenCode backend was verified live on October 13, 2026. Remove only
the `opencodeBinary` override and restart OpenChamber; this preserves every
other settings value:

```bash
set -euo pipefail
settings="$HOME/.config/openchamber/settings.json"
tmp=$(mktemp "${settings}.XXXXXX")
jq 'del(.opencodeBinary)' "$settings" > "$tmp"
chmod --reference="$settings" "$tmp"
mv "$tmp" "$settings"
systemctl --user restart openchamber
```

Confirm the service is active and the local HTTP check returns 200 or 401.
With no `opencodeBinary` override, OpenChamber uses its normal OpenCode
backend.

## Restore the pre-OmO service configuration

To restore the pre-OmO settings and remove the OmO-specific systemd drop-in,
restore the verified backup, reload systemd, and restart the service:

```bash
cp -p ~/.config/openchamber/settings.json.pre-omo \
  ~/.config/openchamber/settings.json
rm ~/.config/systemd/user/openchamber.service.d/omo.conf
systemctl --user daemon-reload
systemctl --user restart openchamber
```

If the connector fails to become ready during activation, use the prepared
failure rollback below. It restores the same settings and drop-in state, then
stops and disables the service rather than leaving a failing process running:

```bash
cp -p ~/.config/openchamber/settings.json.pre-omo \
  ~/.config/openchamber/settings.json
rm ~/.config/systemd/user/openchamber.service.d/omo.conf
systemctl --user daemon-reload
systemctl --user disable --now openchamber
```

After that stopped-service rollback, restore the standard OpenCode service
with `systemctl --user enable --now openchamber` when ready.

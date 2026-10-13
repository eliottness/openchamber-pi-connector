# OpenChamber OmO deployment

## Current deployment

- Connector tag: `omo-v1`, commit `4610c29`.
- Deployment worktree: `/home/eliott/.local/share/openchamber-omo/connector`.
- Settings file: `~/.config/openchamber/settings.json`.
- Backend setting:

  ```json
  {
    "opencodeBinary": "/home/eliott/.local/share/openchamber-omo/connector/bin/opencode-pi"
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

## Upgrade to a new connector tag

Keep the current deployment worktree in place while preparing the next tag in
a separate versioned worktree. Run the OmO smoke before changing
`opencodeBinary`; it requires `OCPI_PI_BINARY` to name the OmO executable.

```bash
tag=omo-v2
repo="$HOME/git/openchamber-pi-connector"
deploy="$HOME/.local/share/openchamber-omo/connector-$tag"

git -C "$repo" fetch --tags origin
git -C "$repo" worktree add "$deploy" "$tag"
cd "$deploy"
npm ci && npm run build
OCPI_PI_BINARY="$HOME/.bun/install/global/node_modules/.bin/omo" npm run omo-smoke
```

Only after build and smoke pass, preserve the current settings and atomically
point OpenChamber at the new worktree:

```bash
settings="$HOME/.config/openchamber/settings.json"
cp -p "$settings" "$settings.pre-$tag"
tmp=$(mktemp "${settings}.XXXXXX")
jq --arg binary "$deploy/bin/opencode-pi" \
  '.opencodeBinary = $binary' "$settings" > "$tmp"
mv "$tmp" "$settings"
systemctl --user restart openchamber
```

Check `systemctl --user is-active openchamber` and
`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4096/`. The expected
HTTP status is 200 or 401. Keep the prior deployment worktree available until
the new tag is accepted.

## Roll back

To return from an upgrade to the original `omo-v1` worktree without removing
the OmO service configuration:

```bash
settings="$HOME/.config/openchamber/settings.json"
previous="$HOME/.local/share/openchamber-omo/connector"
tmp=$(mktemp "${settings}.XXXXXX")
jq --arg binary "$previous/bin/opencode-pi" \
  '.opencodeBinary = $binary' "$settings" > "$tmp"
mv "$tmp" "$settings"
systemctl --user restart openchamber
```

To restore the pre-OmO OpenChamber settings and use the default OpenCode
backend, restore the verified backup, remove the drop-in, reload systemd, and
restart the service:

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

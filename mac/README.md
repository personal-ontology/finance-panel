# Mac launchd agent — timezone sync

When the panel runs on a remote server, the server doesn't know which timezone
*you* are in — and you want the 4x/day refresh to fire at 7/12/17/22 *local*,
not server-local. This agent runs on your Mac, reads its current IANA
timezone, and POSTs it to the panel's `/timezone` endpoint on every login and
once per hour.

## Files

- `tz-sync.sh` — the script that posts the timezone. Reads `PANEL_URL` and
  `BEARER_TOKEN_FILE` from the environment (set in the plist).
- `com.paulschappert.finance-panel-tz.plist` — launchd agent. Edit the
  absolute paths for your own setup if you're forking this repo.

## Install (per machine)

```bash
chmod +x mac/tz-sync.sh

# Edit the plist's PANEL_URL, BEARER_TOKEN_FILE, and the ProgramArguments
# second entry (script path) to match your paths, then:
cp mac/com.*.finance-panel-tz.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.*.finance-panel-tz.plist
```

Verify with:

```bash
cat /tmp/finance-panel-tz-sync.log
curl -sS -H "Authorization: Bearer $(cat <BEARER_TOKEN_FILE>)" \
  <PANEL_URL>/health | python3 -m json.tool
```

You should see your local IANA tz in `data.schedule.timezone`.

## Uninstall

```bash
launchctl unload ~/Library/LaunchAgents/com.*.finance-panel-tz.plist
rm ~/Library/LaunchAgents/com.*.finance-panel-tz.plist
```

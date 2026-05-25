#!/bin/bash
# Reports this Mac's current IANA timezone to a deployed finance-panel so the
# panel's refresh cron fires at the right local-time slots. Idempotent — safe
# to call repeatedly; the panel no-ops when the tz hasn't changed.
#
# Driven by a launchd agent (mac/com.paulschappert.finance-panel-tz.plist)
# that runs this on login and every hour thereafter.
#
# Required env (typically set via the launchd plist):
#   PANEL_URL          e.g. https://finance.paulschappert.com
#   BEARER_TOKEN_FILE  absolute path to a file containing only the panel's
#                      bearer token (chmod 600, off any cloud-synced folder)

set -euo pipefail

PANEL_URL="${PANEL_URL:?PANEL_URL not set}"
BEARER_TOKEN_FILE="${BEARER_TOKEN_FILE:?BEARER_TOKEN_FILE not set}"

if [[ ! -r "$BEARER_TOKEN_FILE" ]]; then
  echo "[tz-sync] bearer token file unreadable: $BEARER_TOKEN_FILE" >&2
  exit 1
fi

# /etc/localtime is a symlink to .../zoneinfo/<IANA name> on macOS.
TZ_LINK=$(readlink /etc/localtime)
TZ_NAME=${TZ_LINK#*/zoneinfo/}

if [[ -z "$TZ_NAME" || "$TZ_NAME" == "$TZ_LINK" ]]; then
  echo "[tz-sync] could not derive IANA tz from /etc/localtime ($TZ_LINK)" >&2
  exit 1
fi

TOKEN=$(< "$BEARER_TOKEN_FILE")
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)

RESPONSE=$(curl -sS --max-time 15 -w "\n%{http_code}" -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"tz\":\"$TZ_NAME\"}" \
  "$PANEL_URL/timezone" || true)

HTTP_CODE=$(printf '%s' "$RESPONSE" | tail -n1)
BODY=$(printf '%s' "$RESPONSE" | sed '$d')

if [[ "$HTTP_CODE" == "200" ]]; then
  echo "[tz-sync $TS] OK tz=$TZ_NAME body=$BODY"
else
  echo "[tz-sync $TS] FAILED http=$HTTP_CODE tz=$TZ_NAME body=$BODY" >&2
  exit 1
fi

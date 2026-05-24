# finance-panel

Personal finance panel for [personal-ontology](https://github.com/personal-ontology) — pulls bank account balances and transactions via [Enable Banking](https://enablebanking.com) (PSD2 AISP). Single-user, self-hosted, bring-your-own-credentials.

## Status

Early. Right now this is a CLI that completes the Enable Banking OAuth flow with one bank and prints balances. Next: persist transactions to SQLite, expose as an HTTP panel, run continuously.

## Setup

You will need:
- An Enable Banking account with an active Production app in **restricted mode** (you whitelist your own bank accounts only — see Enable Banking docs).
- The private RSA key (`.pem`) that Enable Banking generated at app registration. Keep it outside any cloud-synced folder, `chmod 600`.
- A registered HTTPS redirect URL on the app (does NOT need to be reachable for the CLI; the browser still shows the URL with `?code=…` after SCA, which you paste back into the CLI).

```bash
cp .env.example .env
# fill EB_APPLICATION_ID, EB_PRIVATE_KEY_PATH, EB_REDIRECT_URI,
# EB_BANK_NAME (e.g. "DKB"), EB_BANK_COUNTRY (e.g. "DE")

bun install
bun run start
```

The CLI prints an authorization URL → you open it → complete the bank's SCA → copy the redirected URL back into the prompt → get balances.

## Stack

TypeScript + Bun. No HTTP server yet (CLI only).

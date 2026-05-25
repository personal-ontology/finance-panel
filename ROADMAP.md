# Finance panel roadmap

Status of the finance panel within the broader [personal-ontology](https://github.com/personal-ontology) project.

## Done

- **Enable Banking account active in Production restricted mode.** 2 DKB accounts linked (Girokonto + Tagesgeldkonto). Application ID `03d16141…`, RSA private key off any cloud-synced folder, chmod 600.
- **CLI + HTTP server (TypeScript + Bun + Hono + bun:sqlite + Caddy auto-TLS).** Bearer-authed REST API on `https://finance.paulschappert.com`. Per-panel HTML view at `/` (Tokyo Night palette).
- **Refresh logic:** idempotent (entry_reference + account_uid dedupe), 2-day overlap buffer, configurable bootstrap window. Persistent SQLite at `/srv/finance-panel/data/finance.db`.
- **TZ-aware cron scheduler (croner).** Default `0 7,12,17,22 * * *` in the operator's local IANA timezone. Auto-tracks the operator's Mac via a launchd agent that POSTs `/timezone` on login + hourly.
- **Browser-driven reauth + add-account flow.** `/reauth/start` returns a fresh Enable Banking SCA URL; `/finance/callback` validates state, exchanges code, saves new session, redirects back to `/` with a confirmation banner.
- **Deployed on the Hetzner box** with bearer auth, auto-Let's-Encrypt TLS, and an in-process scheduler.

## Next up (queue order)

1. **Historical backfill from 2026-01-01.** Once `?date_from=` ships, one curl pulls 5 months of transactions instead of the default 90 days.
2. **CSV import for archived accounts.** `POST /import/csv` endpoint + a small Mac script that takes DKB's CSV export and pushes transactions into the panel as a "frozen" account. Originally driven by Paul's cancelled DKB Visa Card whose data is no longer reachable via PSD2 — generalizes to any closed account, pre-Enable-Banking history, or non-PSD2 banks.
3. **Smart monthly spending (intelligence service).** Build a separate `intelligence` panel exposing `POST /reason`, `POST /categorize-transactions`, `POST /summarize-month`. Finance panel calls it to render a "this month so far" tile and a categorized spend breakdown. Uses Anthropic SDK with prompt caching.
4. **Multi-bank support.** Right now the panel hardcodes one ASPSP (DKB/DE) per session. Restructure storage to allow N bank sessions (one per ASPSP), with the panel iterating them on refresh. Unlocks adding N26, Sparkasse, or non-German banks.
5. **Per-account categorization + budgets.** Tag accounts (checking, savings, credit, joint) and group transactions by category over time.
6. **Dashboard integration.** When the Swift `dashboard-mac` exists, the finance panel exposes a structured tile (`GET /tile`) returning the data shape the dashboard composes.

## Backlog / nice-to-have

- **Webhook ingestion** — if Enable Banking adds webhooks (currently polling-only), wire them up to remove the cron lag.
- **Outgoing notifications** — push/email when a large transaction posts.
- **Anomaly detection** — flag unusual charges through the intelligence layer.
- **Exchange-rate normalization** — convert non-EUR transactions to EUR via a daily FX feed.

## Out of scope (deliberately)

- **Payments / transfers.** Read-only forever — Enable Banking's PIS scope is not enabled on the app, and we don't want the liability of initiating payments.
- **Multi-tenant operation.** Single user, single operator. Open-source as bring-your-own-credentials, not as a SaaS.

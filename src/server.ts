import { Hono } from "hono";
import { Cron } from "croner";
import { refreshAll, loadValidSession, saveSession } from "./refresh.ts";
import { startAuth, createSession } from "./enable_banking.ts";
import {
  listAccounts,
  latestBalances,
  txCount,
  listTransactions,
  maxLastRefresh,
} from "./db.ts";
import { readFileSync } from "node:fs";

const UI_HTML = readFileSync(new URL("./ui.html", import.meta.url), "utf8");

const SOURCE = "finance";
const PORT = Number(process.env.PORT || 8001);
const HOSTNAME = process.env.HOSTNAME || "127.0.0.1";
const BEARER_TOKEN = process.env.PANEL_BEARER_TOKEN; // when set, all requests must carry it
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || "0 7,12,17,22 * * *"; // 07:00 12:00 17:00 22:00
let currentTimezone = process.env.TIMEZONE || "Europe/Berlin";

function envelope<T>(data: T) {
  return {
    data,
    refreshed_at: new Date().toISOString(),
    source: SOURCE,
  };
}

const app = new Hono();

// Bearer-auth middleware. No-op when PANEL_BEARER_TOKEN is unset (loopback dev mode).
// Active when set (deployments behind Caddy on the Hetzner box).
// `/` and `/favicon.ico` are intentionally exempt — the HTML page itself contains no
// secrets and asks the user to paste their token, which is stored in localStorage and
// sent on every subsequent API call.
// `/finance/callback` is also exempt — the bank redirects there with no bearer
// available; we authenticate that request by validating a state parameter we issued
// when initiating /reauth/start.
const UNAUTHED_PATHS = new Set(["/", "/favicon.ico", "/finance/callback"]);
app.use("*", async (c, next) => {
  if (!BEARER_TOKEN) return next();
  if (UNAUTHED_PATHS.has(c.req.path)) return next();
  const header = c.req.header("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (token !== BEARER_TOKEN) {
    return c.json(envelope({ error: "unauthorized" }), 401);
  }
  return next();
});

// ── HTML view ───────────────────────────────────────────────────────────────
app.get("/", (c) => c.html(UI_HTML));

// ── Health ──────────────────────────────────────────────────────────────────
app.get("/health", (c) => {
  const session = loadValidSession();
  const lastRefresh = maxLastRefresh();
  const accounts = listAccounts();

  let status: "ok" | "needs_reconnect" | "stale" = "ok";
  if (!session) status = "needs_reconnect";
  else if (
    lastRefresh &&
    Date.now() - new Date(lastRefresh).getTime() > 24 * 60 * 60 * 1000
  ) {
    status = "stale";
  }

  return c.json(
    envelope({
      ok: !!session,
      status,
      session: session
        ? {
            valid_until: session.access.valid_until,
            expires_in_days: Math.floor(
              (new Date(session.access.valid_until).getTime() - Date.now()) /
                (24 * 60 * 60 * 1000),
            ),
          }
        : null,
      accounts_count: accounts.length,
      last_refresh_at: lastRefresh,
      schedule: {
        cron: CRON_SCHEDULE,
        timezone: currentTimezone,
        next_run: cronJob?.nextRun()?.toISOString() ?? null,
      },
    }),
  );
});

// ── Headline summary (this is what the dashboard tile reads) ────────────────
app.get("/data", (c) => {
  const accounts = listAccounts().map((a) => {
    const balances = latestBalances(a.uid);
    // Prefer Closing booked → Closing available → Interim available → first
    const headline =
      balances.find((b) => b.balance_type === "CLBD") ??
      balances.find((b) => b.balance_type === "CLAV") ??
      balances.find((b) => b.balance_type === "ITAV") ??
      balances[0] ??
      null;
    return {
      uid: a.uid,
      iban: a.iban,
      name: a.name,
      currency: a.currency,
      aspsp_name: a.aspsp_name,
      headline_balance: headline,
      balances,
      transactions_count: txCount(a.uid),
      last_refresh_at: a.last_refresh_at,
      consent_expires_at: a.consent_expires_at,
    };
  });
  return c.json(envelope({ accounts }));
});

// ── List accounts (lightweight) ─────────────────────────────────────────────
app.get("/accounts", (c) => {
  return c.json(envelope({ accounts: listAccounts() }));
});

// ── Transactions for an account ─────────────────────────────────────────────
app.get("/accounts/:uid/transactions", (c) => {
  const uid = c.req.param("uid");
  const date_from = c.req.query("date_from") || undefined;
  const date_to = c.req.query("date_to") || undefined;
  const limitStr = c.req.query("limit");
  const limit = limitStr ? Math.min(Number(limitStr), 1000) : 100;

  const txs = listTransactions(uid, { date_from, date_to, limit });
  return c.json(envelope({ transactions: txs, count: txs.length }));
});

// ── Trigger refresh ─────────────────────────────────────────────────────────
app.post("/refresh", async (c) => {
  const session = loadValidSession();
  if (!session) {
    return c.json(
      envelope({
        ok: false,
        error: "no_valid_session",
        message: "Run the CLI (`bun run start`) to re-authorize.",
      }),
      409,
    );
  }
  try {
    const result = await refreshAll(session);
    return c.json(envelope({ ok: true, result }));
  } catch (e) {
    return c.json(envelope({ ok: false, error: (e as Error).message }), 500);
  }
});

// ── Reauth / add-account flow ───────────────────────────────────────────────
// Two-step browser flow for renewing the 90-day Enable Banking consent and/or
// adding additional accounts (e.g. a credit card not selected on the first SCA).
//
//   GET /reauth/start         → returns { auth_url } that the operator opens
//   GET /finance/callback     → receives ?code= back from the bank, exchanges
//                               for a new session, saves it, redirects to /
//
// We issue a random `state` per /reauth/start and stash it in memory. The
// callback handler validates the state we receive back from the bank against
// the in-memory set — that's the CSRF defense for the unauthed callback path.
type PendingState = { issuedAt: number };
const pendingStates = new Map<string, PendingState>();
const STATE_TTL_MS = 30 * 60 * 1000;

setInterval(() => {
  const cutoff = Date.now() - STATE_TTL_MS;
  for (const [k, v] of pendingStates) if (v.issuedAt < cutoff) pendingStates.delete(k);
}, 5 * 60 * 1000);

app.get("/reauth/start", async (c) => {
  const state = crypto.randomUUID();
  pendingStates.set(state, { issuedAt: Date.now() });
  try {
    const { url, authorization_id } = await startAuth(state);
    return c.json(envelope({ auth_url: url, authorization_id, state }));
  } catch (e) {
    pendingStates.delete(state);
    return c.json(envelope({ error: (e as Error).message }), 500);
  }
});

app.get("/finance/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const errorParam = c.req.query("error");

  function errorPage(message: string, status: 400 | 500 = 400) {
    const safe = message.replace(/</g, "&lt;");
    return c.html(
      `<!doctype html><meta charset="utf-8"><title>Reconnect failed</title>` +
        `<style>body{font-family:-apple-system,sans-serif;background:#282828;color:#eaeaea;padding:40px;max-width:600px;margin:auto}h1{color:#f7768e;font-weight:500}a{color:#7aa2f7}pre{background:#1f1f1f;padding:12px;border-radius:6px;overflow:auto}</style>` +
        `<h1>Reconnect failed</h1><pre>${safe}</pre><p><a href="/">← back to panel</a></p>`,
      status,
    );
  }

  if (errorParam) return errorPage(`Bank returned an error: ${errorParam}`);
  if (!code || !state) return errorPage("Missing code or state in callback URL.");
  if (!pendingStates.has(state)) {
    return errorPage(
      "Unknown or expired state — was this SCA initiated by this panel within the last 30 minutes? If not, start again from the panel.",
    );
  }
  pendingStates.delete(state);
  try {
    const session = await createSession(code);
    saveSession(session);
    console.log(
      `[reauth] new session saved, valid until ${session.access.valid_until}, ${session.accounts.length} accounts`,
    );
    return c.redirect("/?reconnected=1");
  } catch (e) {
    return errorPage((e as Error).message, 500);
  }
});

// ── Set / update scheduler timezone ─────────────────────────────────────────
// Mac sends its current IANA timezone here (via a launchd agent) so the box's
// 4x/day cron fires at the right local-time slots regardless of where Paul is.
app.post("/timezone", async (c) => {
  let body: { tz?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json(envelope({ error: "invalid_json" }), 400);
  }
  const newTz = typeof body?.tz === "string" ? body.tz : "";
  if (!newTz) return c.json(envelope({ error: "missing tz" }), 400);
  // Validate by constructing a throwaway cron with this tz — invalid IANA throws.
  try {
    new Cron("0 0 * * *", { timezone: newTz, paused: true });
  } catch {
    return c.json(envelope({ error: "invalid_timezone", tz: newTz }), 400);
  }
  const changed = newTz !== currentTimezone;
  if (changed) {
    console.log(`[scheduler] timezone changed: ${currentTimezone} -> ${newTz}`);
    currentTimezone = newTz;
    scheduleCron();
  }
  return c.json(
    envelope({
      ok: true,
      timezone: currentTimezone,
      changed,
      next_run: cronJob?.nextRun()?.toISOString() ?? null,
    }),
  );
});

// ── 404 fallback ────────────────────────────────────────────────────────────
app.notFound((c) =>
  c.json(envelope({ error: "not_found", path: c.req.path }), 404),
);

// ── Auto-refresh scheduler ──────────────────────────────────────────────────
// Cron-driven via croner with a configurable IANA timezone. Default schedule
// fires at 07:00, 12:00, 17:00, 22:00 local. Timezone is the operator's Mac's
// timezone, kept in sync by a launchd agent POSTing to /timezone. Also fires
// once ~10s after startup as a smoke check. Skips silently with a log line
// when there's no valid session.
async function scheduledRefresh(reason: string) {
  const session = loadValidSession();
  if (!session) {
    console.log(`[scheduler:${reason}] skipped — no valid session`);
    return;
  }
  console.log(`[scheduler:${reason}] starting refresh at ${new Date().toISOString()}`);
  try {
    const result = await refreshAll(session);
    const summary = result.accounts
      .map((a) => `${a.name || a.uid.slice(0, 8)}=${a.transactions_inserted}new`)
      .join(", ");
    console.log(`[scheduler:${reason}] done — ${summary}`);
  } catch (e) {
    console.error(`[scheduler:${reason}] error:`, (e as Error).message);
  }
}

let cronJob: Cron | null = null;
function scheduleCron() {
  if (cronJob) cronJob.stop();
  cronJob = new Cron(CRON_SCHEDULE, { timezone: currentTimezone }, () =>
    scheduledRefresh("cron"),
  );
  const next = cronJob.nextRun();
  console.log(
    `[scheduler] cron='${CRON_SCHEDULE}' tz=${currentTimezone} next=${next?.toISOString() ?? "never"}`,
  );
}

scheduleCron();
setTimeout(() => scheduledRefresh("startup"), 10_000);

console.log(`finance-panel listening on http://${HOSTNAME}:${PORT}`);

export default {
  port: PORT,
  hostname: HOSTNAME,
  fetch: app.fetch,
};

// Helpers exposed inside the same module for /health
export function getScheduleInfo() {
  return {
    cron: CRON_SCHEDULE,
    timezone: currentTimezone,
    next_run: cronJob?.nextRun()?.toISOString() ?? null,
  };
}

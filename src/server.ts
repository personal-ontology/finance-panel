import { Hono } from "hono";
import { refreshAll, loadValidSession } from "./refresh.ts";
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
const REFRESH_INTERVAL_HOURS = Number(process.env.REFRESH_INTERVAL_HOURS || 12);

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
const UNAUTHED_PATHS = new Set(["/", "/favicon.ico"]);
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

// ── 404 fallback ────────────────────────────────────────────────────────────
app.notFound((c) =>
  c.json(envelope({ error: "not_found", path: c.req.path }), 404),
);

// ── Auto-refresh scheduler ──────────────────────────────────────────────────
// Runs in-process via setInterval. Fires once ~10s after startup (smoke check),
// then every REFRESH_INTERVAL_HOURS. Skips silently when there's no valid
// session so a stale/expired consent doesn't spam errors.
async function scheduledRefresh(reason: "startup" | "interval") {
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

const intervalMs = REFRESH_INTERVAL_HOURS * 60 * 60 * 1000;
setTimeout(() => scheduledRefresh("startup"), 10_000);
setInterval(() => scheduledRefresh("interval"), intervalMs);

console.log(
  `finance-panel listening on http://${HOSTNAME}:${PORT} — auto-refresh every ${REFRESH_INTERVAL_HOURS}h`,
);

export default {
  port: PORT,
  hostname: HOSTNAME,
  fetch: app.fetch,
};

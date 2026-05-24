import {
  startAuth,
  createSession,
  getBalances,
  getAllTransactions,
  type SessionResponse,
  type Transaction,
} from "./enable_banking.ts";
import {
  upsertAccount,
  setLastRefresh,
  getLastRefresh,
  insertBalance,
  upsertTransaction,
  txCount,
  recentTransactions,
} from "./db.ts";
import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

const SESSION_PATH = "./data/session.json";

// PSD2 balance type codes (ISO 20022 BalanceType12Code) → human names
const BALANCE_TYPE_NAMES: Record<string, string> = {
  CLBD: "Closing booked",
  CLAV: "Closing available",
  OPBD: "Opening booked",
  OPAV: "Opening available",
  ITBD: "Interim booked",
  ITAV: "Interim available",
  XPCD: "Expected",
  FWAV: "Forward available",
  PRCD: "Previously closed booked",
  INFO: "Information",
  AUTH: "Authorised",
  NOTC: "Noticed",
  AVLB: "Available",
  VALU: "Value-dated",
};

function prompt(question: string): Promise<string> {
  process.stdout.write(question);
  return new Promise((resolve) => {
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", (chunk) => resolve(chunk.toString().trim()));
  });
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function loadValidSession(): SessionResponse | null {
  if (!existsSync(SESSION_PATH)) return null;
  try {
    const s = JSON.parse(readFileSync(SESSION_PATH, "utf8")) as SessionResponse;
    if (new Date(s.access.valid_until).getTime() > Date.now()) return s;
    console.log(`Saved session expired at ${s.access.valid_until} — re-authorizing.`);
    return null;
  } catch {
    return null;
  }
}

async function doOAuth(): Promise<SessionResponse> {
  console.log("\n→ Starting authorization...\n");
  const { url } = await startAuth();
  console.log("1. Open this URL in your browser:\n");
  console.log("   " + url + "\n");
  console.log("2. Complete the SCA on your bank's app.");
  console.log("3. Browser will fail to load the redirect (no server yet) —");
  console.log("   copy the full URL from the address bar.\n");
  const input = await prompt("Paste the redirected URL (or just the code): ");
  let code: string;
  if (input.startsWith("http")) {
    code = new URL(input).searchParams.get("code") || "";
  } else {
    code = input;
  }
  if (!code) throw new Error("No code in input");
  console.log("\n→ Exchanging code for session...");
  const session = await createSession(code);
  mkdirSync(dirname(SESSION_PATH), { recursive: true });
  writeFileSync(SESSION_PATH, JSON.stringify(session, null, 2));
  return session;
}

function txToRow(tx: Transaction, accountUid: string, fetchedAt: string) {
  const isDebit = tx.credit_debit_indicator === "DBIT";
  const counterparty = isDebit ? tx.creditor : tx.debtor;
  const counterpartyAccount = isDebit ? tx.creditor_account : tx.debtor_account;
  return {
    entry_reference: tx.entry_reference,
    account_uid: accountUid,
    booking_date: tx.booking_date ?? null,
    value_date: tx.value_date ?? null,
    amount_value: tx.transaction_amount.amount,
    amount_currency: tx.transaction_amount.currency,
    credit_debit: tx.credit_debit_indicator ?? null,
    status: tx.status ?? null,
    counterparty_name: counterparty?.name ?? null,
    counterparty_iban: counterpartyAccount?.iban ?? null,
    remittance: tx.remittance_information?.join(" / ") ?? null,
    raw_json: JSON.stringify(tx),
    fetched_at: fetchedAt,
  };
}

async function main() {
  let session = loadValidSession();
  if (session) {
    console.log(`Using saved session, valid until ${session.access.valid_until}.`);
  } else {
    session = await doOAuth();
  }

  for (const acc of session.accounts) {
    upsertAccount({
      uid: acc.uid,
      iban: acc.account_id.iban ?? null,
      name: acc.name ?? null,
      currency: acc.currency ?? null,
      aspsp_name: session.aspsp.name,
      aspsp_country: session.aspsp.country,
      session_id: session.session_id,
      consent_expires_at: session.access.valid_until,
    });
  }
  console.log(`\nRefreshing ${session.accounts.length} account(s)...\n`);

  const now = new Date();
  const nowIso = now.toISOString();
  const dateTo = ymd(now);

  for (const acc of session.accounts) {
    const label = acc.name || acc.account_id.iban || acc.uid;
    console.log(`▸ ${label}`);

    try {
      const { balances } = await getBalances(acc.uid);
      for (const b of balances) {
        insertBalance({
          account_uid: acc.uid,
          balance_type: b.balance_type,
          amount: b.balance_amount.amount,
          currency: b.balance_amount.currency,
          fetched_at: nowIso,
        });
        const friendly = BALANCE_TYPE_NAMES[b.balance_type] || b.balance_type;
        const amt = `${b.balance_amount.amount} ${b.balance_amount.currency}`;
        console.log(`    ${friendly.padEnd(26)} ${amt.padStart(16)}`);
      }
    } catch (e) {
      console.log(`    balances: (error: ${(e as Error).message})`);
    }

    const lastRefresh = getLastRefresh(acc.uid);
    let dateFrom: string;
    if (lastRefresh) {
      const lr = new Date(lastRefresh);
      lr.setDate(lr.getDate() - 2);
      dateFrom = ymd(lr);
    } else {
      const d = new Date(now);
      d.setDate(d.getDate() - 90);
      dateFrom = ymd(d);
    }

    try {
      const txs = await getAllTransactions(acc.uid, { date_from: dateFrom, date_to: dateTo });
      let inserted = 0;
      for (const tx of txs) {
        if (!tx.entry_reference) continue;
        const result = upsertTransaction(txToRow(tx, acc.uid, nowIso));
        if (result.inserted) inserted++;
      }
      const total = txCount(acc.uid);
      console.log(
        `    transactions: ${dateFrom} → ${dateTo}: ${txs.length} fetched, ${inserted} new (${total} total)`,
      );

      if (inserted > 0) {
        const recent = recentTransactions(acc.uid, 3);
        for (const r of recent) {
          const sign = r.credit_debit === "DBIT" ? "−" : "+";
          const amt = `${sign}${r.amount_value} ${r.amount_currency}`;
          const cp = r.counterparty_name || r.remittance?.slice(0, 50) || "?";
          console.log(`      ${r.booking_date}  ${amt.padStart(14)}  ${cp}`);
        }
      }
    } catch (e) {
      console.log(`    transactions: (error: ${(e as Error).message})`);
    }

    setLastRefresh(acc.uid, nowIso);
    console.log();
  }

  console.log("✓ Done.\n");
  process.exit(0);
}

main().catch((err) => {
  console.error("\nError:", err.message);
  process.exit(1);
});

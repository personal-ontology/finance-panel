import {
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
} from "./db.ts";
import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

const SESSION_PATH = "./data/session.json";

export function loadValidSession(): SessionResponse | null {
  if (!existsSync(SESSION_PATH)) return null;
  try {
    const s = JSON.parse(readFileSync(SESSION_PATH, "utf8")) as SessionResponse;
    if (new Date(s.access.valid_until).getTime() > Date.now()) return s;
    return null;
  } catch {
    return null;
  }
}

export function saveSession(session: SessionResponse): void {
  mkdirSync(dirname(SESSION_PATH), { recursive: true });
  writeFileSync(SESSION_PATH, JSON.stringify(session, null, 2));
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
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

export type AccountRefreshResult = {
  uid: string;
  name: string | null;
  balances: number;
  transactions_pulled: number;
  transactions_inserted: number;
  date_from: string;
  date_to: string;
  error: string | null;
};

export type RefreshResult = {
  session_valid_until: string;
  accounts: AccountRefreshResult[];
  ran_at: string;
};

export async function refreshAll(
  session: SessionResponse,
  opts?: { dateFromOverride?: string },
): Promise<RefreshResult> {
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

  const now = new Date();
  const nowIso = now.toISOString();
  const dateTo = ymd(now);
  const results: AccountRefreshResult[] = [];

  for (const acc of session.accounts) {
    const lastRefresh = getLastRefresh(acc.uid);
    let dateFrom: string;
    if (opts?.dateFromOverride) {
      dateFrom = opts.dateFromOverride;
    } else if (lastRefresh) {
      const lr = new Date(lastRefresh);
      lr.setDate(lr.getDate() - 2);
      dateFrom = ymd(lr);
    } else {
      const d = new Date(now);
      d.setDate(d.getDate() - 90);
      dateFrom = ymd(d);
    }

    const result: AccountRefreshResult = {
      uid: acc.uid,
      name: acc.name ?? null,
      balances: 0,
      transactions_pulled: 0,
      transactions_inserted: 0,
      date_from: dateFrom,
      date_to: dateTo,
      error: null,
    };

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
      }
      result.balances = balances.length;
    } catch (e) {
      result.error = `balances: ${(e as Error).message}`;
    }

    try {
      const txs = await getAllTransactions(acc.uid, { date_from: dateFrom, date_to: dateTo });
      result.transactions_pulled = txs.length;
      let inserted = 0;
      for (const tx of txs) {
        if (!tx.entry_reference) continue;
        const r = upsertTransaction(txToRow(tx, acc.uid, nowIso));
        if (r.inserted) inserted++;
      }
      result.transactions_inserted = inserted;
    } catch (e) {
      result.error =
        (result.error ? result.error + "; " : "") + `transactions: ${(e as Error).message}`;
    }

    setLastRefresh(acc.uid, nowIso);
    results.push(result);
  }

  return {
    session_valid_until: session.access.valid_until,
    accounts: results,
    ran_at: nowIso,
  };
}

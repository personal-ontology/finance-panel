import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const DB_PATH = "./data/finance.db";

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH, { create: true });
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    uid                 TEXT PRIMARY KEY,
    iban                TEXT,
    name                TEXT,
    currency            TEXT,
    aspsp_name          TEXT NOT NULL,
    aspsp_country       TEXT NOT NULL,
    session_id          TEXT NOT NULL,
    consent_expires_at  TEXT NOT NULL,
    last_refresh_at     TEXT
  );

  CREATE TABLE IF NOT EXISTS balances (
    account_uid   TEXT NOT NULL,
    balance_type  TEXT NOT NULL,
    amount        TEXT NOT NULL,
    currency      TEXT NOT NULL,
    fetched_at    TEXT NOT NULL,
    PRIMARY KEY (account_uid, balance_type, fetched_at)
  );

  CREATE TABLE IF NOT EXISTS transactions (
    entry_reference    TEXT NOT NULL,
    account_uid        TEXT NOT NULL,
    booking_date       TEXT,
    value_date         TEXT,
    amount_value       TEXT NOT NULL,
    amount_currency    TEXT NOT NULL,
    credit_debit       TEXT,
    status             TEXT,
    counterparty_name  TEXT,
    counterparty_iban  TEXT,
    remittance         TEXT,
    raw_json           TEXT NOT NULL,
    fetched_at         TEXT NOT NULL,
    PRIMARY KEY (entry_reference, account_uid)
  );

  CREATE INDEX IF NOT EXISTS idx_tx_account_date
    ON transactions(account_uid, booking_date DESC);
`);

// Enable Banking re-issues account UIDs on every reauth (same IBAN, new UID).
// Without migration, every reconnect would double up the data. This collapses
// the old UID's children (transactions, balances) into the new UID, deduping
// on the existing PKs, then drops the old account row.
function migrateAccountUid(oldUid: string, newUid: string): void {
  const tx = db.transaction(() => {
    // 1) Drop old-side transactions whose entry_reference already exists under the new UID
    db.prepare(
      `DELETE FROM transactions
       WHERE account_uid = ?
         AND entry_reference IN (SELECT entry_reference FROM transactions WHERE account_uid = ?)`,
    ).run(oldUid, newUid);
    db.prepare("UPDATE transactions SET account_uid = ? WHERE account_uid = ?").run(
      newUid,
      oldUid,
    );

    // 2) Same for balances (PK is account_uid + balance_type + fetched_at)
    db.prepare(
      `DELETE FROM balances
       WHERE account_uid = ?
         AND (balance_type, fetched_at) IN
             (SELECT balance_type, fetched_at FROM balances WHERE account_uid = ?)`,
    ).run(oldUid, newUid);
    db.prepare("UPDATE balances SET account_uid = ? WHERE account_uid = ?").run(
      newUid,
      oldUid,
    );

    // 3) Drop the stale account row
    db.prepare("DELETE FROM accounts WHERE uid = ?").run(oldUid);
  });
  tx();
}

export function upsertAccount(row: {
  uid: string;
  iban: string | null;
  name: string | null;
  currency: string | null;
  aspsp_name: string;
  aspsp_country: string;
  session_id: string;
  consent_expires_at: string;
}): void {
  // If this IBAN already exists under a different UID (i.e. reauth issued a new
  // account identity for the same real-world account), migrate the old UID's
  // data over before we INSERT the new one.
  if (row.iban) {
    const existing = db
      .prepare("SELECT uid FROM accounts WHERE iban = ? AND uid != ?")
      .get(row.iban, row.uid) as { uid: string } | undefined;
    if (existing) {
      console.log(
        `[migrate] re-pointing account ${existing.uid} -> ${row.uid} (iban …${row.iban.slice(-4)})`,
      );
      migrateAccountUid(existing.uid, row.uid);
    }
  }

  db.prepare(
    `INSERT INTO accounts (uid, iban, name, currency, aspsp_name, aspsp_country, session_id, consent_expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(uid) DO UPDATE SET
       iban = excluded.iban,
       name = excluded.name,
       currency = excluded.currency,
       aspsp_name = excluded.aspsp_name,
       aspsp_country = excluded.aspsp_country,
       session_id = excluded.session_id,
       consent_expires_at = excluded.consent_expires_at`,
  ).run(
    row.uid,
    row.iban,
    row.name,
    row.currency,
    row.aspsp_name,
    row.aspsp_country,
    row.session_id,
    row.consent_expires_at,
  );
}

export function setLastRefresh(uid: string, ts: string): void {
  db.prepare("UPDATE accounts SET last_refresh_at = ? WHERE uid = ?").run(ts, uid);
}

export function getLastRefresh(uid: string): string | null {
  const row = db
    .prepare("SELECT last_refresh_at FROM accounts WHERE uid = ?")
    .get(uid) as { last_refresh_at: string | null } | undefined;
  return row?.last_refresh_at ?? null;
}

export function insertBalance(row: {
  account_uid: string;
  balance_type: string;
  amount: string;
  currency: string;
  fetched_at: string;
}): void {
  db.prepare(
    `INSERT OR IGNORE INTO balances (account_uid, balance_type, amount, currency, fetched_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(row.account_uid, row.balance_type, row.amount, row.currency, row.fetched_at);
}

export type TxRow = {
  entry_reference: string;
  account_uid: string;
  booking_date: string | null;
  value_date: string | null;
  amount_value: string;
  amount_currency: string;
  credit_debit: string | null;
  status: string | null;
  counterparty_name: string | null;
  counterparty_iban: string | null;
  remittance: string | null;
  raw_json: string;
  fetched_at: string;
};

export function upsertTransaction(row: TxRow): { inserted: boolean } {
  const result = db
    .prepare(
      `INSERT INTO transactions
       (entry_reference, account_uid, booking_date, value_date, amount_value, amount_currency,
        credit_debit, status, counterparty_name, counterparty_iban, remittance, raw_json, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(entry_reference, account_uid) DO NOTHING`,
    )
    .run(
      row.entry_reference,
      row.account_uid,
      row.booking_date,
      row.value_date,
      row.amount_value,
      row.amount_currency,
      row.credit_debit,
      row.status,
      row.counterparty_name,
      row.counterparty_iban,
      row.remittance,
      row.raw_json,
      row.fetched_at,
    );
  return { inserted: result.changes > 0 };
}

// ─── read queries used by CLI + HTTP server ─────────────────────────────────

export type AccountRow = {
  uid: string;
  iban: string | null;
  name: string | null;
  currency: string | null;
  aspsp_name: string;
  aspsp_country: string;
  consent_expires_at: string;
  last_refresh_at: string | null;
};

export function listAccounts(): AccountRow[] {
  return db
    .prepare(
      `SELECT uid, iban, name, currency, aspsp_name, aspsp_country, consent_expires_at, last_refresh_at
       FROM accounts ORDER BY COALESCE(name, uid)`,
    )
    .all() as AccountRow[];
}

export type LatestBalance = {
  balance_type: string;
  amount: string;
  currency: string;
  fetched_at: string;
};

export function latestBalances(accountUid: string): LatestBalance[] {
  return db
    .prepare(
      `SELECT b.balance_type, b.amount, b.currency, b.fetched_at
       FROM balances b
       INNER JOIN (
         SELECT balance_type, MAX(fetched_at) AS max_at
         FROM balances WHERE account_uid = ?
         GROUP BY balance_type
       ) latest ON b.balance_type = latest.balance_type AND b.fetched_at = latest.max_at
       WHERE b.account_uid = ?
       ORDER BY b.balance_type`,
    )
    .all(accountUid, accountUid) as LatestBalance[];
}

export function txCount(accountUid: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS c FROM transactions WHERE account_uid = ?")
    .get(accountUid) as { c: number };
  return row.c;
}

export function recentTransactions(accountUid: string, limit = 5): TxRow[] {
  return db
    .prepare(
      `SELECT * FROM transactions WHERE account_uid = ?
       ORDER BY booking_date DESC, entry_reference DESC LIMIT ?`,
    )
    .all(accountUid, limit) as TxRow[];
}

export function listTransactions(
  accountUid: string,
  opts: { date_from?: string; date_to?: string; limit?: number },
): TxRow[] {
  let sql = "SELECT * FROM transactions WHERE account_uid = ?";
  const params: (string | number)[] = [accountUid];
  if (opts.date_from) {
    sql += " AND booking_date >= ?";
    params.push(opts.date_from);
  }
  if (opts.date_to) {
    sql += " AND booking_date <= ?";
    params.push(opts.date_to);
  }
  sql += " ORDER BY booking_date DESC, entry_reference DESC";
  if (opts.limit) {
    sql += " LIMIT ?";
    params.push(opts.limit);
  }
  return db.prepare(sql).all(...params) as TxRow[];
}

export function maxLastRefresh(): string | null {
  const row = db.prepare("SELECT MAX(last_refresh_at) AS t FROM accounts").get() as {
    t: string | null;
  };
  return row.t;
}

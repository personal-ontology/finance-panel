import jwt from "jsonwebtoken";
import { readFileSync } from "node:fs";

const APP_ID = process.env.EB_APPLICATION_ID!;
const KEY_PATH = process.env.EB_PRIVATE_KEY_PATH!;
const REDIRECT_URI = process.env.EB_REDIRECT_URI!;
const API_BASE = process.env.EB_API_BASE || "https://api.enablebanking.com";
const BANK_NAME = process.env.EB_BANK_NAME!;
const BANK_COUNTRY = process.env.EB_BANK_COUNTRY!;

for (const [name, val] of Object.entries({
  EB_APPLICATION_ID: APP_ID,
  EB_PRIVATE_KEY_PATH: KEY_PATH,
  EB_REDIRECT_URI: REDIRECT_URI,
  EB_BANK_NAME: BANK_NAME,
  EB_BANK_COUNTRY: BANK_COUNTRY,
})) {
  if (!val) throw new Error(`Missing required env var: ${name}`);
}

const PRIVATE_KEY = readFileSync(KEY_PATH, "utf8");

function signJWT(): string {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    {
      iss: "enablebanking.com",
      aud: "api.enablebanking.com",
      iat: now,
      exp: now + 3600,
    },
    PRIVATE_KEY,
    { algorithm: "RS256", keyid: APP_ID },
  );
}

async function call<T>(method: string, path: string, body?: object): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${signJWT()}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}

export type StartAuthResponse = {
  url: string;
  authorization_id: string;
};

export async function startAuth(): Promise<StartAuthResponse> {
  const validUntil = new Date(Date.now() + 89 * 24 * 60 * 60 * 1000).toISOString();
  return call("POST", "/auth", {
    access: { valid_until: validUntil },
    aspsp: { name: BANK_NAME, country: BANK_COUNTRY },
    state: crypto.randomUUID(),
    redirect_url: REDIRECT_URI,
    psu_type: "personal",
  });
}

export type Account = {
  account_id: { iban?: string; bban?: string; other?: { identification: string } };
  uid: string;
  name?: string;
  currency?: string;
};

export type SessionResponse = {
  session_id: string;
  accounts: Account[];
  aspsp: { name: string; country: string };
  access: { valid_until: string };
};

export async function createSession(code: string): Promise<SessionResponse> {
  return call("POST", "/sessions", { code });
}

export type Balance = {
  name: string;
  balance_amount: { amount: string; currency: string };
  balance_type: string;
};

export type BalancesResponse = {
  balances: Balance[];
};

export async function getBalances(accountUid: string): Promise<BalancesResponse> {
  return call("GET", `/accounts/${accountUid}/balances`);
}

export type Transaction = {
  entry_reference: string;
  transaction_amount: { amount: string; currency: string };
  booking_date?: string;
  value_date?: string;
  transaction_date?: string;
  credit_debit_indicator?: "CRDT" | "DBIT";
  status?: string;
  debtor?: { name?: string };
  debtor_account?: { iban?: string };
  creditor?: { name?: string };
  creditor_account?: { iban?: string };
  remittance_information?: string[];
};

export type TransactionsResponse = {
  transactions: Transaction[];
  continuation_key?: string;
};

export async function getTransactions(
  accountUid: string,
  opts: { date_from: string; date_to: string; continuation_key?: string },
): Promise<TransactionsResponse> {
  const params = new URLSearchParams({
    date_from: opts.date_from,
    date_to: opts.date_to,
  });
  if (opts.continuation_key) params.set("continuation_key", opts.continuation_key);
  return call("GET", `/accounts/${accountUid}/transactions?${params}`);
}

export async function getAllTransactions(
  accountUid: string,
  opts: { date_from: string; date_to: string },
): Promise<Transaction[]> {
  const all: Transaction[] = [];
  let cursor: string | undefined;
  do {
    const page = await getTransactions(accountUid, { ...opts, continuation_key: cursor });
    all.push(...page.transactions);
    cursor = page.continuation_key;
  } while (cursor);
  return all;
}

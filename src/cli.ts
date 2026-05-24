import { startAuth, createSession, type SessionResponse } from "./enable_banking.ts";
import { refreshAll, loadValidSession, saveSession } from "./refresh.ts";
import { latestBalances, recentTransactions } from "./db.ts";

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
  saveSession(session);
  return session;
}

async function main() {
  let session = loadValidSession();
  if (session) {
    console.log(`Using saved session, valid until ${session.access.valid_until}.`);
  } else {
    session = await doOAuth();
  }

  const result = await refreshAll(session);
  console.log(`\nRefresh complete (${result.accounts.length} account(s)):\n`);

  for (const r of result.accounts) {
    const label = r.name || r.uid;
    console.log(`▸ ${label}`);
    if (r.error) console.log(`    ⚠ ${r.error}`);

    const balances = latestBalances(r.uid);
    for (const b of balances) {
      const friendly = BALANCE_TYPE_NAMES[b.balance_type] || b.balance_type;
      const amt = `${b.amount} ${b.currency}`;
      console.log(`    ${friendly.padEnd(26)} ${amt.padStart(16)}`);
    }
    console.log(
      `    transactions: ${r.date_from} → ${r.date_to}: ${r.transactions_pulled} fetched, ${r.transactions_inserted} new`,
    );

    if (r.transactions_inserted > 0) {
      const recent = recentTransactions(r.uid, 3);
      for (const t of recent) {
        const sign = t.credit_debit === "DBIT" ? "−" : "+";
        const amt = `${sign}${t.amount_value} ${t.amount_currency}`;
        const cp = t.counterparty_name || t.remittance?.slice(0, 50) || "?";
        console.log(`      ${t.booking_date}  ${amt.padStart(14)}  ${cp}`);
      }
    }
    console.log();
  }

  console.log("✓ Done.\n");
  process.exit(0);
}

main().catch((err) => {
  console.error("\nError:", err.message);
  process.exit(1);
});

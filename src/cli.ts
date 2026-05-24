import { startAuth, createSession, getBalances } from "./enable_banking.ts";
import { writeFileSync, mkdirSync } from "node:fs";
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

async function main() {
  console.log("\n→ Starting authorization...\n");
  const { url } = await startAuth();

  console.log("1. Open this URL in your browser:\n");
  console.log("   " + url + "\n");
  console.log("2. Complete the SCA on your DKB App.");
  console.log("3. Your browser will try to redirect to:");
  console.log("   " + process.env.EB_REDIRECT_URI);
  console.log("   That URL has no server, so the page will fail to load —");
  console.log("   but the address bar will show ?code=XYZ. Copy the full URL.\n");

  const input = await prompt("Paste the redirected URL (or just the code): ");

  let code: string;
  if (input.startsWith("http")) {
    code = new URL(input).searchParams.get("code") || "";
  } else {
    code = input;
  }
  if (!code) {
    console.error("\nNo code found in input. Aborting.");
    process.exit(1);
  }

  console.log("\n→ Exchanging code for session...\n");
  const session = await createSession(code);

  mkdirSync(dirname(SESSION_PATH), { recursive: true });
  writeFileSync(SESSION_PATH, JSON.stringify(session, null, 2));
  console.log(`Session saved to ${SESSION_PATH}`);
  console.log(`Session ID:   ${session.session_id}`);
  console.log(`Valid until:  ${session.access.valid_until}`);
  console.log(`\n${session.accounts.length} accounts linked.\n`);

  console.log("→ Fetching balances...\n");
  for (const acc of session.accounts) {
    const label = acc.account_id.iban || acc.account_id.bban || acc.uid;
    console.log(`${acc.name || label}:`);
    try {
      const { balances } = await getBalances(acc.uid);
      for (const b of balances) {
        const friendly = BALANCE_TYPE_NAMES[b.balance_type] || b.balance_type;
        const amt = `${b.balance_amount.amount} ${b.balance_amount.currency}`;
        console.log(`  ${friendly.padEnd(26)} ${amt.padStart(16)}`);
      }
    } catch (e) {
      console.log(`  (error: ${(e as Error).message})`);
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

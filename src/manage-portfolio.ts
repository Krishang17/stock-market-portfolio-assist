// Add / remove / edit a holding in portfolio.json from GitHub Actions inputs.
//
// Driven by env vars that the workflow sets from the "Run workflow" form, so you
// can manage holdings with form fields instead of hand-editing JSON. Safe: it
// runs inside an authenticated Actions job — no token is ever exposed to a page.
//
//   ACTION   = add | remove | none
//   SYMBOL   = ticker, e.g. INFY (required for add/remove)
//   NAME     = company name (optional, for add)
//   EXCHANGE = NS | BO (default NS)
//   QTY      = shares (for add)
//   BUYPRICE = average buy price in ₹ (for add)

import fs from "node:fs";
import path from "node:path";

import type { Exchange, Holding } from "./types";

const PORTFOLIO_PATH = path.join(process.cwd(), "portfolio.json");

function load(): Holding[] {
  try {
    const arr = JSON.parse(fs.readFileSync(PORTFOLIO_PATH, "utf8"));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function save(holdings: Holding[]): void {
  fs.writeFileSync(PORTFOLIO_PATH, JSON.stringify(holdings, null, 2) + "\n");
}

function fail(msg: string): never {
  console.error(`[portfolio] ${msg}`);
  process.exit(1);
}

const action = (process.env.ACTION || "none").trim().toLowerCase();
if (action === "none" || action === "") {
  console.log("[portfolio] no portfolio change requested.");
  process.exit(0);
}

const symbol = (process.env.SYMBOL || "").trim().toUpperCase();
const exchange: Exchange =
  (process.env.EXCHANGE || "NS").trim().toUpperCase() === "BO" ? "BO" : "NS";

if (!symbol) fail(`action "${action}" requires a ticker SYMBOL.`);

const holdings = load();
const idx = holdings.findIndex(
  (h) => h.symbol.toUpperCase() === symbol && h.exchange === exchange,
);

if (action === "remove") {
  if (idx === -1) fail(`${symbol} (${exchange}) is not in the portfolio; nothing removed.`);
  holdings.splice(idx, 1);
  save(holdings);
  console.log(`[portfolio] removed ${symbol} (${exchange}).`);
  process.exit(0);
}

if (action === "add") {
  const qty = Number(process.env.QTY || "0");
  const buyPrice = Number(process.env.BUYPRICE || "0");
  if (!Number.isFinite(qty) || qty < 0) fail(`invalid quantity "${process.env.QTY}".`);
  if (!Number.isFinite(buyPrice) || buyPrice <= 0) {
    fail(`invalid buy price "${process.env.BUYPRICE}" (must be greater than 0).`);
  }
  // Use the given name; if updating and none was given, keep the existing one.
  const name =
    (process.env.NAME || "").trim() ||
    (idx !== -1 ? holdings[idx].name : symbol);
  const holding: Holding = { symbol, name, exchange, qty, buyPrice };
  if (idx === -1) {
    holdings.push(holding);
    console.log(`[portfolio] added ${symbol} (${exchange}): ${qty} @ ₹${buyPrice}.`);
  } else {
    holdings[idx] = holding;
    console.log(`[portfolio] updated ${symbol} (${exchange}): ${qty} @ ₹${buyPrice}.`);
  }
  save(holdings);
  process.exit(0);
}

fail(`unknown action "${action}" (expected add, remove, or none).`);

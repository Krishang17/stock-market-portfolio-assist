// One-off, ZERO-COST backfill: adds the two free fields the dashboard's
// per-stock detail pages need — `priceHistory` (6-month chart, from Yahoo) and
// `recentCalls` (past-calls table, from the local history file) — to the
// EXISTING docs/briefing.json, WITHOUT calling Claude. Used to light up the
// detail pages after the snapshot shape changed, so we don't have to spend a
// paid LLM run just to render charts. The existing reads are left untouched.

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";

import { fetchHistory, toYahooSymbol } from "./prices";
import type { CallRecord, Exchange, History } from "./types";

const ROOT = process.cwd();
const SNAPSHOT_PATH = path.join(ROOT, "docs", "briefing.json");
const PORTFOLIO_PATH = path.join(ROOT, "portfolio.json");
const HISTORY_PATH = path.join(ROOT, "data", "history.json");

function codeFromLabel(label: string): Exchange {
  return label === "BSE" || label === "BO" ? "BO" : "NS";
}

function loadHistory(): History {
  try {
    const obj = JSON.parse(fs.readFileSync(HISTORY_PATH, "utf8"));
    if (obj && Array.isArray(obj.calls)) return obj as History;
  } catch {
    /* start empty */
  }
  return { calls: [] };
}

// Mirrors index.ts's recentCallsFor() + mapping exactly.
function recentCallsFor(
  history: History,
  symbol: string,
  exchange: Exchange,
  n: number,
): CallRecord[] {
  return history.calls
    .filter((c) => c.symbol === symbol && c.exchange === exchange)
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .slice(0, n);
}

async function main(): Promise<void> {
  const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, "utf8"));
  const history = loadHistory();

  // symbol -> exchange code, from portfolio.json (authoritative).
  const codeBySymbol = new Map<string, Exchange>();
  try {
    const portfolio = JSON.parse(fs.readFileSync(PORTFOLIO_PATH, "utf8"));
    for (const h of portfolio) {
      if (h?.symbol && (h.exchange === "NS" || h.exchange === "BO")) {
        codeBySymbol.set(String(h.symbol).toUpperCase(), h.exchange);
      }
    }
  } catch {
    /* fall back to the label on each holding */
  }

  const holdings: any[] = snapshot.holdings ?? [];
  let charted = 0;

  await Promise.all(
    holdings.map(async (h) => {
      const code =
        codeBySymbol.get(String(h.symbol).toUpperCase()) ??
        codeFromLabel(h.exchange);
      const ticker = toYahooSymbol(h.symbol, code);

      h.priceHistory = await fetchHistory(ticker);
      if (h.priceHistory.length > 1) charted++;

      h.recentCalls = recentCallsFor(history, h.symbol, code, 8).map((c) => ({
        date: c.date,
        stance: c.stance,
        confidence: c.confidence,
        outcome: c.outcome,
        stockReturnPct: c.stockReturnPct ?? null,
        benchmarkReturnPct: c.benchmarkReturnPct ?? null,
      }));

      console.log(
        `[backfill] ${h.symbol}: ${h.priceHistory.length} price pts, ${h.recentCalls.length} past call(s)`,
      );
    }),
  );

  // Note in the snapshot that charts/past-calls were backfilled for free,
  // without re-running the (paid) analysis. Reads keep their original date.
  snapshot.chartsBackfilledAt = new Date().toISOString();

  fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2) + "\n");
  console.log(
    `[backfill] updated docs/briefing.json — ${charted}/${holdings.length} holdings now have a chart. No Claude calls were made.`,
  );
}

main().catch((err) => {
  console.error("[backfill] fatal:", err);
  process.exitCode = 1;
});

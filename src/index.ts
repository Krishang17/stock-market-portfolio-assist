// Orchestrator: reads the portfolio, evaluates the previous run's calls, asks
// Claude for an honest read on each holding (with source links), writes a
// snapshot for the GitHub Pages dashboard, and persists the track record so it
// survives to the next run.
//
// Every external step is wrapped so one stock's failure never crashes the run.

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";

import { analyzeHolding, suggestIdeas } from "./claude";
import { computeCalibration, computeHitRate, evaluatePending } from "./evaluate";
import { fetchRawPrice, indexSymbolFor, toYahooSymbol } from "./prices";
import type {
  Analysis,
  CallRecord,
  Exchange,
  History,
  Holding,
  Stance,
} from "./types";

const ROOT = process.cwd();
const PORTFOLIO_PATH = path.join(ROOT, "portfolio.json");
const HISTORY_PATH = path.join(ROOT, "data", "history.json");
// The dashboard (docs/) is served by GitHub Pages and reads this snapshot.
const SNAPSHOT_PATH = path.join(ROOT, "docs", "briefing.json");

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function exchangeLabel(e: Exchange): string {
  return e === "NS" ? "NSE" : "BSE";
}

/** Plain-English action shown on the dashboard alongside the raw stance. */
function actionLabel(stance: Stance): string {
  switch (stance) {
    case "Add":
      return "Buy more";
    case "Trim":
      return "Trim";
    case "Avoid":
      return "Sell / avoid";
    case "Hold":
      return "Hold";
    case "Watch":
      return "Watch";
  }
}

// ---- loading / saving -------------------------------------------------------

function loadPortfolio(): Holding[] {
  const arr = JSON.parse(fs.readFileSync(PORTFOLIO_PATH, "utf8"));
  if (!Array.isArray(arr)) throw new Error("portfolio.json must be a JSON array");
  const valid: Holding[] = [];
  for (const h of arr) {
    if (
      h &&
      typeof h.symbol === "string" &&
      (h.exchange === "NS" || h.exchange === "BO") &&
      typeof h.buyPrice === "number"
    ) {
      valid.push({
        symbol: h.symbol,
        name: typeof h.name === "string" ? h.name : h.symbol,
        exchange: h.exchange,
        qty: typeof h.qty === "number" ? h.qty : 0,
        buyPrice: h.buyPrice,
      });
    } else {
      console.warn("[portfolio] skipping invalid entry:", JSON.stringify(h));
    }
  }
  return valid;
}

function loadHistory(): History {
  try {
    const obj = JSON.parse(fs.readFileSync(HISTORY_PATH, "utf8"));
    if (obj && Array.isArray(obj.calls)) return obj as History;
  } catch {
    /* missing or invalid -> start fresh */
  }
  return { calls: [] };
}

function saveHistory(history: History): void {
  fs.mkdirSync(path.dirname(HISTORY_PATH), { recursive: true });
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2) + "\n");
}

function saveSnapshot(snapshot: unknown): void {
  fs.mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true });
  fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2) + "\n");
}

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

// ---- price cache (shared by evaluation + today's analysis) ------------------

const priceCache = new Map<string, number | null>();
async function getRaw(ticker: string): Promise<number | null> {
  if (priceCache.has(ticker)) return priceCache.get(ticker) ?? null;
  const p = await fetchRawPrice(ticker);
  priceCache.set(ticker, p);
  return p;
}
async function getPrice(
  symbol: string,
  exchange: Exchange,
): Promise<number | null> {
  return getRaw(toYahooSymbol(symbol, exchange));
}

// ---- main -------------------------------------------------------------------

interface StockView {
  holding: Holding;
  price: number | null;
  analysis: Analysis;
}

async function main(): Promise<void> {
  const today = todayISO();

  let portfolio: Holding[];
  try {
    portfolio = loadPortfolio();
  } catch (err) {
    console.error(
      "[main] could not load portfolio.json:",
      err instanceof Error ? err.message : err,
    );
    return;
  }
  if (!portfolio.length) {
    console.error("[main] portfolio.json has no valid holdings; nothing to do.");
    return;
  }

  const history = loadHistory();

  // 1. Evaluate how the PREVIOUS run's calls turned out.
  try {
    const resolved = await evaluatePending(history, getRaw, today);
    console.log(`[main] evaluated ${resolved} prior call(s).`);
  } catch (err) {
    console.error(
      "[main] evaluation step failed:",
      err instanceof Error ? err.message : err,
    );
  }

  // Calibration over the (now freshly-evaluated) record; fed into each prompt
  // and shown on the dashboard.
  const calibration = computeCalibration(history);

  // 2. Fetch prices + ask Claude for an honest, sourced read on each holding.
  const views: StockView[] = [];
  const newCalls: CallRecord[] = [];
  for (const holding of portfolio) {
    const price = await getPrice(holding.symbol, holding.exchange);
    // Capture the benchmark level now so this call can later be scored as
    // outperformance vs the index, not just raw direction.
    const indexSymbol = indexSymbolFor(holding.exchange);
    const indexAtCall = await getRaw(indexSymbol);
    const recent = recentCallsFor(history, holding.symbol, holding.exchange, 5);
    const analysis = await analyzeHolding(holding, price, recent, calibration);
    views.push({ holding, price, analysis });
    newCalls.push({
      date: today,
      symbol: holding.symbol,
      exchange: holding.exchange,
      name: holding.name,
      stance: analysis.stance,
      confidence: analysis.confidence,
      priceAtCall: price,
      indexSymbol,
      indexAtCall,
      reasoning: analysis.reasoning,
      keyNews: analysis.keyNews,
      sources: analysis.sources ?? [],
      outcome: "pending",
    });
    console.log(
      `[main] ${holding.symbol}: ${analysis.stance} (${analysis.confidence})`,
    );
  }

  // 3. A few research ideas the user does NOT already hold.
  let ideas = [] as Awaited<ReturnType<typeof suggestIdeas>>["ideas"];
  let ideaSources = [] as Awaited<ReturnType<typeof suggestIdeas>>["sources"];
  try {
    const res = await suggestIdeas(portfolio.map((p) => p.symbol));
    ideas = res.ideas;
    ideaSources = res.sources;
  } catch (err) {
    console.error(
      "[main] ideas step failed:",
      err instanceof Error ? err.message : err,
    );
  }

  // 4. Write the dashboard snapshot.
  const { right, wrong, rate } = computeHitRate(history);
  const snapshot = {
    generatedAt: new Date().toISOString(),
    date: today,
    model: process.env.MODEL?.trim() || "claude-sonnet-4-6",
    disclaimer:
      "This is information, not financial advice. Short-term calls are close to a coin flip — the track record is here to show that honestly.",
    degraded: views.some((v) => v.analysis.unavailable === true),
    track: { right, wrong, rate },
    calibration,
    holdings: views.map((v) => {
      const { holding, price, analysis } = v;
      const plPct =
        price != null ? ((price - holding.buyPrice) / holding.buyPrice) * 100 : null;
      const plAbs = price != null ? (price - holding.buyPrice) * holding.qty : null;
      return {
        symbol: holding.symbol,
        name: holding.name,
        exchange: exchangeLabel(holding.exchange),
        qty: holding.qty,
        buyPrice: holding.buyPrice,
        price,
        plPct,
        plAbs,
        stance: analysis.stance,
        confidence: analysis.confidence,
        action: actionLabel(analysis.stance),
        reasoning: analysis.reasoning,
        keyNews: analysis.keyNews,
        sources: analysis.sources ?? [],
        unavailable: analysis.unavailable === true,
      };
    }),
    ideas: { items: ideas, sources: ideaSources },
  };

  try {
    saveSnapshot(snapshot);
    console.log(
      `[main] wrote docs/briefing.json (${snapshot.holdings.length} holdings, ${ideas.length} ideas, degraded=${snapshot.degraded}).`,
    );
  } catch (err) {
    console.error(
      "[main] failed to write snapshot:",
      err instanceof Error ? err.message : err,
    );
  }

  // 5. Persist today's calls so the record survives to the next run.
  history.calls.push(...newCalls);
  try {
    saveHistory(history);
    console.log(`[main] saved ${newCalls.length} new call(s) to history.`);
  } catch (err) {
    console.error(
      "[main] failed to write history:",
      err instanceof Error ? err.message : err,
    );
  }
}

main().catch((err) => {
  console.error("[main] fatal error:", err);
  process.exitCode = 1;
});

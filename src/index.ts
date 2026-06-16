// Orchestrator: reads the portfolio, evaluates the previous run's calls, asks
// Claude for an honest read on each holding (with source links), computes totals
// + index levels, writes a snapshot for the GitHub Pages dashboard, and persists
// the track record + a portfolio-value time series so they survive across runs.
//
// Every external step is wrapped so one stock's failure never crashes the run.

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";

import { analyzeHolding, getLastFailureReason, suggestIdeas } from "./claude";
import { computeCalibration, computeHitRate, evaluatePending } from "./evaluate";
import {
  MARKET_INDICES,
  fetchHistory,
  fetchIdeaData,
  fetchQuote,
  indexSymbolFor,
  toYahooSymbol,
  type PricePoint,
  type Quote,
} from "./prices";
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
const VALUE_HISTORY_PATH = path.join(ROOT, "data", "value-history.json");
// The dashboard (docs/) is served by GitHub Pages and reads this snapshot.
const SNAPSHOT_PATH = path.join(ROOT, "docs", "briefing.json");

interface ValuePoint {
  date: string;
  value: number;
  invested: number;
  pnlAbs: number;
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function exchangeLabel(e: Exchange): string {
  return e === "NS" ? "NSE" : "BSE";
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Run an async fn over items with bounded concurrency, preserving order. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return results;
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

function loadValueHistory(): ValuePoint[] {
  try {
    const arr = JSON.parse(fs.readFileSync(VALUE_HISTORY_PATH, "utf8"));
    return Array.isArray(arr) ? (arr as ValuePoint[]) : [];
  } catch {
    return [];
  }
}

function saveValueHistory(series: ValuePoint[]): void {
  fs.mkdirSync(path.dirname(VALUE_HISTORY_PATH), { recursive: true });
  fs.writeFileSync(VALUE_HISTORY_PATH, JSON.stringify(series, null, 2) + "\n");
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

// ---- quote cache (shared by evaluation, totals, and analysis) ---------------

const quoteCache = new Map<string, Quote>();
async function getQuote(ticker: string): Promise<Quote> {
  const cached = quoteCache.get(ticker);
  if (cached) return cached;
  const q = await fetchQuote(ticker);
  quoteCache.set(ticker, q);
  return q;
}
// evaluate.ts only needs the price.
async function getRaw(ticker: string): Promise<number | null> {
  return (await getQuote(ticker)).price;
}

// ---- main -------------------------------------------------------------------

interface StockView {
  holding: Holding;
  price: number | null;
  dayChangePct: number | null;
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

  // Calibration over the (now freshly-evaluated) record.
  const calibration = computeCalibration(history);

  // 2. Fetch quotes (parallel), then analyse each holding concurrently (bounded)
  //    and kick off the ideas call in parallel too. Doing these sequentially was
  //    slow (each web-search call can take ~a minute), so this cuts the whole run
  //    from many minutes to a couple.
  const quotes = await Promise.all(
    portfolio.map((h) => getQuote(toYahooSymbol(h.symbol, h.exchange))),
  );
  // Daily price history per holding (free Yahoo calls) — ~1y for the detail
  // charts (range toggles + 52-week stats on the dashboard).
  const histories = await Promise.all(
    portfolio.map((h) => fetchHistory(toYahooSymbol(h.symbol, h.exchange), 365)),
  );
  // Benchmark index level(s) — fetched once (cached) for scoring today's calls.
  for (const h of portfolio) await getRaw(indexSymbolFor(h.exchange));
  // Benchmark index price history (free) so detail charts can overlay the stock
  // against its index, rebased to 100. Keyed by Yahoo symbol (^NSEI / ^BSESN).
  const benchSymbols = Array.from(
    new Set(portfolio.map((h) => indexSymbolFor(h.exchange))),
  );
  const benchSeries = await Promise.all(
    benchSymbols.map((s) => fetchHistory(s, 365)),
  );
  const indexHistory: Record<string, PricePoint[]> = {};
  benchSymbols.forEach((s, i) => {
    indexHistory[s] = benchSeries[i];
  });

  const ideasPromise = suggestIdeas(portfolio.map((p) => p.symbol)).catch(
    (err) => {
      console.error(
        "[main] ideas step failed:",
        err instanceof Error ? err.message : err,
      );
      return { ideas: [], sources: [] };
    },
  );

  const analyses = await mapLimit(portfolio, 5, (holding, i) =>
    analyzeHolding(
      holding,
      quotes[i].price,
      recentCallsFor(history, holding.symbol, holding.exchange, 5),
      calibration,
    ),
  );

  const views: StockView[] = [];
  const newCalls: CallRecord[] = [];
  portfolio.forEach((holding, i) => {
    const q = quotes[i];
    const analysis = analyses[i];
    const indexSymbol = indexSymbolFor(holding.exchange);
    const indexAtCall = quoteCache.get(indexSymbol)?.price ?? null;
    views.push({ holding, price: q.price, dayChangePct: q.changePercent, analysis });
    newCalls.push({
      date: today,
      symbol: holding.symbol,
      exchange: holding.exchange,
      name: holding.name,
      stance: analysis.stance,
      confidence: analysis.confidence,
      priceAtCall: q.price,
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
  });

  // 3. Market indices (SENSEX / NIFTY 50 / BANK NIFTY).
  const indices = [];
  for (const { label, symbol } of MARKET_INDICES) {
    const q = await getQuote(symbol);
    indices.push({ label, symbol, price: q.price, changePercent: q.changePercent });
  }

  // 4. Portfolio totals (over holdings that have a price, so P/L is consistent).
  const priced = views.filter((v) => v.price != null);
  const invested = priced.reduce((s, v) => s + v.holding.qty * v.holding.buyPrice, 0);
  const value = priced.reduce((s, v) => s + v.holding.qty * (v.price as number), 0);
  const pnlAbs = value - invested;
  const totals = {
    invested: round2(invested),
    value: round2(value),
    pnlAbs: round2(pnlAbs),
    pnlPct: invested > 0 ? round2((pnlAbs / invested) * 100) : null,
    holdings: views.length,
    priced: priced.length,
    unpriced: views.length - priced.length,
  };

  // 5. Append today's value to the time series (only when we have real prices).
  const series = loadValueHistory();
  if (priced.length > 0) {
    const point: ValuePoint = {
      date: today,
      value: totals.value,
      invested: totals.invested,
      pnlAbs: totals.pnlAbs,
    };
    const i = series.findIndex((p) => p.date === today);
    if (i === -1) series.push(point);
    else series[i] = point;
    try {
      saveValueHistory(series);
    } catch (err) {
      console.error(
        "[main] failed to write value history:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  // 6. Research ideas (kicked off in parallel above), enriched with free Yahoo
  //    price + sparkline data so the dashboard's tip cards are clickable.
  const { ideas, sources: ideaSources } = await ideasPromise;
  const enrichedIdeas = await Promise.all(
    ideas.map(async (idea) => ({ ...idea, ...(await fetchIdeaData(idea.symbol)) })),
  );

  // 7. Write the dashboard snapshot.
  const { right, wrong, rate } = computeHitRate(history);
  const degraded = views.some((v) => v.analysis.unavailable === true);
  const degradedReason = degraded ? getLastFailureReason() : null;
  const snapshot = {
    generatedAt: new Date().toISOString(),
    date: today,
    model: process.env.MODEL?.trim() || "claude-sonnet-4-6",
    disclaimer:
      "This is information, not financial advice. Short-term calls are close to a coin flip — the track record is here to show that honestly.",
    degraded,
    degradedReason,
    totals,
    indices,
    valueSeries: series.slice(-90),
    track: { right, wrong, rate },
    calibration,
    indexHistory,
    holdings: views.map((v, i) => {
      const { holding, price, dayChangePct, analysis } = v;
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
        dayChangePct,
        value: price != null ? round2(price * holding.qty) : null,
        invested: round2(holding.buyPrice * holding.qty),
        plPct,
        plAbs,
        stance: analysis.stance,
        confidence: analysis.confidence,
        action: actionLabel(analysis.stance),
        reasoning: analysis.reasoning,
        keyNews: analysis.keyNews,
        sources: analysis.sources ?? [],
        unavailable: analysis.unavailable === true,
        benchmarkSymbol: indexSymbolFor(holding.exchange),
        priceHistory: histories[i],
        recentCalls: recentCallsFor(history, holding.symbol, holding.exchange, 8).map(
          (c) => ({
            date: c.date,
            stance: c.stance,
            confidence: c.confidence,
            outcome: c.outcome,
            stockReturnPct: c.stockReturnPct ?? null,
            benchmarkReturnPct: c.benchmarkReturnPct ?? null,
          }),
        ),
      };
    }),
    ideas: { items: enrichedIdeas, sources: ideaSources },
  };

  try {
    saveSnapshot(snapshot);
    console.log(
      `[main] wrote docs/briefing.json (${snapshot.holdings.length} holdings, value ₹${totals.value}, P/L ₹${totals.pnlAbs}, degraded=${snapshot.degraded}).`,
    );
  } catch (err) {
    console.error(
      "[main] failed to write snapshot:",
      err instanceof Error ? err.message : err,
    );
  }

  // 8. Persist today's calls so the record survives to the next run.
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

// Orchestrator: reads the portfolio, evaluates the previous run's calls, asks
// Claude for an honest read on each holding, sends the briefing to Telegram, and
// persists the updated track record so it survives to the next run.
//
// Every external step is wrapped so one stock's failure never crashes the run.

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";

import { analyzeHolding, suggestIdeas } from "./claude";
import { computeHitRate, evaluatePending } from "./evaluate";
import { fetchRawPrice, indexSymbolFor, toYahooSymbol } from "./prices";
import { mdSafe, packChunks, sendTelegram } from "./telegram";
import type {
  Analysis,
  CallRecord,
  Exchange,
  History,
  Holding,
  Idea,
} from "./types";

const ROOT = process.cwd();
const PORTFOLIO_PATH = path.join(ROOT, "portfolio.json");
const HISTORY_PATH = path.join(ROOT, "data", "history.json");

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function exchangeLabel(e: Exchange): string {
  return e === "NS" ? "NSE" : "BSE";
}

function inr(n: number): string {
  return (
    "₹" +
    n.toLocaleString("en-IN", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  );
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

// ---- message building -------------------------------------------------------

interface StockView {
  holding: Holding;
  price: number | null;
  analysis: Analysis;
}

function header(history: History): string {
  const { right, wrong, rate } = computeHitRate(history);
  const rateLine =
    rate == null
      ? "Track record: no scored directional calls yet."
      : `Track record: ${right}/${right + wrong} correct (${Math.round(rate * 100)}%) on scored directional calls.`;
  return [
    `*Morning Briefing — ${todayISO()}*`,
    `_This is information, not financial advice._`,
    `Short-term calls are close to a coin flip — the record below is here to show that honestly.`,
    ``,
    rateLine,
    `(Scored vs the index — "right" means the pick beat just holding the NIFTY/SENSEX over ~1 day; Add = beat it, Trim/Avoid = lagged it, Hold/Watch not scored. ~50% is a coin flip.)`,
  ].join("\n");
}

function stockSection(v: StockView): string {
  const { holding, price, analysis } = v;
  const lines: string[] = [];
  lines.push(
    `*${mdSafe(holding.symbol)}* (${exchangeLabel(holding.exchange)}) — ${mdSafe(holding.name)}`,
  );
  lines.push(`${analysis.stance} · ${analysis.confidence} confidence`);
  if (price != null) {
    const diffPct = ((price - holding.buyPrice) / holding.buyPrice) * 100;
    const totalAbs = (price - holding.buyPrice) * holding.qty;
    const sign = diffPct >= 0 ? "+" : "";
    const absSign = totalAbs >= 0 ? "+" : "";
    lines.push(
      `Price ${inr(price)} · P/L ${sign}${diffPct.toFixed(1)}% (${absSign}${inr(totalAbs)} on ${holding.qty}) vs buy ${inr(holding.buyPrice)}`,
    );
  } else {
    lines.push(`Price unavailable this run.`);
  }
  if (analysis.reasoning) lines.push(mdSafe(analysis.reasoning));
  if (analysis.keyNews.length) {
    lines.push("News:");
    for (const h of analysis.keyNews) lines.push(`• ${mdSafe(h)}`);
  }
  return lines.join("\n");
}

function ideasSection(ideas: Idea[]): string {
  if (!ideas.length) {
    return `*Ideas to research* — starting points, not calls\n(none generated this run)`;
  }
  const lines = [`*Ideas to research* — starting points, not calls`];
  for (const idea of ideas) {
    const name = idea.name ? ` (${mdSafe(idea.name)})` : "";
    lines.push(`*${mdSafe(idea.symbol)}*${name} — ${mdSafe(idea.why)}`);
    lines.push(`   Risk: ${mdSafe(idea.risk)}`);
  }
  return lines.join("\n");
}

// ---- main -------------------------------------------------------------------

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

  // 2. Fetch prices + ask Claude for an honest read on each holding.
  const views: StockView[] = [];
  const newCalls: CallRecord[] = [];
  for (const holding of portfolio) {
    const price = await getPrice(holding.symbol, holding.exchange);
    // Capture the benchmark level now so this call can later be scored as
    // outperformance vs the index, not just raw direction.
    const indexSymbol = indexSymbolFor(holding.exchange);
    const indexAtCall = await getRaw(indexSymbol);
    const recent = recentCallsFor(history, holding.symbol, holding.exchange, 5);
    const analysis = await analyzeHolding(holding, price, recent);
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
      outcome: "pending",
    });
    console.log(
      `[main] ${holding.symbol}: ${analysis.stance} (${analysis.confidence})`,
    );
  }

  // 3. A few research ideas the user does NOT already hold.
  let ideas: Idea[] = [];
  try {
    ideas = await suggestIdeas(portfolio.map((p) => p.symbol));
  } catch (err) {
    console.error(
      "[main] ideas step failed:",
      err instanceof Error ? err.message : err,
    );
  }

  // 4. Build and send the Telegram briefing.
  const sections = [
    header(history),
    ...views.map(stockSection),
    ideasSection(ideas),
  ];
  await sendTelegram(packChunks(sections));

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

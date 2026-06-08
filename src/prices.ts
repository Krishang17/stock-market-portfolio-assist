// Price lookups via yahoo-finance2.
//
// Yahoo Finance is an UNOFFICIAL data source. Every lookup is wrapped in
// try/catch so a single bad symbol (or a transient outage) returns null
// instead of killing the whole run.

import YahooFinance from "yahoo-finance2";

import type { Exchange } from "./types";

// yahoo-finance2 v3 is class-based. We suppress the one-time survey notice via
// the constructor so the run logs stay readable.
const yahooFinance = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

const SUFFIX: Record<Exchange, string> = { NS: ".NS", BO: ".BO" };

/** Build the Yahoo ticker, e.g. ("RELIANCE", "NS") -> "RELIANCE.NS". */
export function toYahooSymbol(symbol: string, exchange: Exchange): string {
  return `${symbol.trim().toUpperCase()}${SUFFIX[exchange]}`;
}

/**
 * Fetch the latest price for one holding. Returns null on any failure so the
 * caller can carry on with the rest of the portfolio.
 */
export async function fetchPrice(
  symbol: string,
  exchange: Exchange,
): Promise<number | null> {
  const ticker = toYahooSymbol(symbol, exchange);
  try {
    const quote = await yahooFinance.quote(ticker);
    const price = quote?.regularMarketPrice;
    if (typeof price === "number" && Number.isFinite(price)) return price;
    console.warn(`[prices] No usable price returned for ${ticker}`);
    return null;
  } catch (err) {
    console.error(
      `[prices] Lookup failed for ${ticker}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

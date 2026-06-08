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

// Benchmark index per exchange: NIFTY 50 for NSE, SENSEX for BSE. A call is
// only "right" if the pick beat simply holding this index (see evaluate.ts).
const INDEX: Record<Exchange, string> = { NS: "^NSEI", BO: "^BSESN" };

/** Build the Yahoo ticker, e.g. ("RELIANCE", "NS") -> "RELIANCE.NS". */
export function toYahooSymbol(symbol: string, exchange: Exchange): string {
  return `${symbol.trim().toUpperCase()}${SUFFIX[exchange]}`;
}

/** The benchmark index ticker for an exchange (e.g. "NS" -> "^NSEI"). */
export function indexSymbolFor(exchange: Exchange): string {
  return INDEX[exchange];
}

/**
 * Fetch the latest price for any raw Yahoo ticker (a stock like "RELIANCE.NS"
 * or an index like "^NSEI"). Returns null on any failure so the caller can
 * carry on.
 */
export async function fetchRawPrice(ticker: string): Promise<number | null> {
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

/** Convenience wrapper: fetch the price for one holding. */
export async function fetchPrice(
  symbol: string,
  exchange: Exchange,
): Promise<number | null> {
  return fetchRawPrice(toYahooSymbol(symbol, exchange));
}

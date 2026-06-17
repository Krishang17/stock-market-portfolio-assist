// Shared types for the morning-briefing service.

/** Indian exchange suffix selector: NSE = ".NS", BSE = ".BO". */
export type Exchange = "NS" | "BO";

/** The directional read the model returns for a holding. */
export type Stance = "Add" | "Hold" | "Trim" | "Watch" | "Avoid";

export type Confidence = "Low" | "Medium" | "High";

/**
 * Evaluation result for a stored call.
 * - "pending"  : not yet evaluated (waiting for the next run / a price)
 * - "right"    : a directional call that went the predicted way
 * - "wrong"    : a directional call that went the other way
 * - "unscored" : Hold/Watch (no direction), or a call we can't score
 */
export type Outcome = "pending" | "right" | "wrong" | "unscored";

/** One line of the portfolio.json config the user edits directly on GitHub. */
export interface Holding {
  symbol: string; // base ticker WITHOUT exchange suffix, e.g. "RELIANCE"
  name: string;
  exchange: Exchange;
  qty: number;
  buyPrice: number;
}

/** A source link Claude consulted via web search (for "backed by facts"). */
export interface Source {
  title: string;
  url: string;
}

/** The minified-JSON shape we ask Claude to return per holding. */
export interface Analysis {
  stance: Stance;
  confidence: Confidence;
  reasoning: string;
  keyNews: string[];
  sources?: Source[]; // links Claude consulted for this read
  unavailable?: boolean; // true when this was a fallback (model/credit/parse error)
}

/** A "research starting point" suggestion (explicitly NOT a call). */
export interface Idea {
  symbol: string;
  name?: string;
  why: string;
  risk: string;
  // Optional free-Yahoo enrichment (resolved exchange + live price + sparkline).
  exchange?: Exchange | null;
  price?: number | null;
  dayChangePct?: number | null;
  priceHistory?: { t: string; c: number }[];
}

/** A persisted call plus its eventual evaluated outcome. */
export interface CallRecord {
  date: string; // YYYY-MM-DD of the run that made the call
  symbol: string;
  exchange: Exchange;
  name: string;
  stance: Stance;
  confidence: Confidence;
  priceAtCall: number | null;
  reasoning: string;
  keyNews: string[];
  sources?: Source[]; // source links consulted for this call

  // Benchmark captured WHEN THE CALL WAS MADE, so the outcome can be scored as
  // outperformance vs the index rather than raw direction.
  indexSymbol?: string; // e.g. "^NSEI" (NIFTY 50) or "^BSESN" (SENSEX)
  indexAtCall?: number | null;

  // Evaluation (filled in on a later run):
  outcome: Outcome; // "pending" until evaluated
  evaluatedPrice?: number | null;
  evaluatedIndexPrice?: number | null;
  stockReturnPct?: number; // stock % change over the eval window
  benchmarkReturnPct?: number; // index % change (undefined if not benchmarked)
  benchmarked?: boolean; // was the outcome scored vs the index (vs raw fallback)?
  evaluatedDate?: string;
}

/** The whole persisted track record (data/history.json). */
export interface History {
  calls: CallRecord[];
}

/**
 * A persisted buy-tip plus the information used to generate it (why/risk/sources)
 * and its eventual benchmark-relative outcome. Stored in data/tips-history.json
 * so the tips can be SCORED over time and fed back into the prompt as context.
 */
export interface TipRecord {
  date: string; // YYYY-MM-DD of the run that suggested it
  symbol: string;
  name?: string;
  exchange: Exchange | null; // resolved NS/BO, or null if it couldn't be resolved
  why: string; // the near-term reason given
  risk: string; // the key risk given
  sources: Source[]; // the links the run consulted for ideas
  priceAtTip: number | null;
  indexSymbol: string | null; // benchmark captured at tip time
  indexAtTip: number | null;

  // Evaluation (filled in on a later run):
  outcome: Outcome; // "pending" until evaluated
  evaluatedPrice?: number | null;
  stockReturnPct?: number | null;
  benchmarkReturnPct?: number | null;
  evaluatedDate?: string;
}

/** The whole persisted tips record (data/tips-history.json). */
export interface TipHistory {
  tips: TipRecord[];
}

/** Empirical performance of all scored directional calls in one confidence bucket. */
export interface ConfidenceBucket {
  confidence: Confidence;
  count: number; // scored directional calls in this bucket
  right: number;
  wrong: number;
  rate: number | null; // right / count
}

/**
 * Calibration = does the model's stated confidence actually mean anything?
 * If "High" calls don't beat "Low" calls, the confidence signal is noise — and
 * this surfaces that honestly.
 */
export interface Calibration {
  buckets: ConfidenceBucket[]; // ordered High, Medium, Low
  scored: number; // total scored directional calls
  brier: number | null; // mean squared error vs the assumed confidence->prob map
}

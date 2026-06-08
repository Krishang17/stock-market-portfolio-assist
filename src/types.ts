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

/** The minified-JSON shape we ask Claude to return per holding. */
export interface Analysis {
  stance: Stance;
  confidence: Confidence;
  reasoning: string;
  keyNews: string[];
}

/** A "research starting point" suggestion (explicitly NOT a call). */
export interface Idea {
  symbol: string;
  name?: string;
  why: string;
  risk: string;
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

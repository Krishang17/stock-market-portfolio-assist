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
  outcome: Outcome; // "pending" until a later run evaluates it
  evaluatedPrice?: number | null;
  evaluatedDate?: string;
}

/** The whole persisted track record (data/history.json). */
export interface History {
  calls: CallRecord[];
}

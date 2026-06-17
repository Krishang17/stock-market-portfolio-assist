// Track-record evaluation — benchmark-relative.
//
// This is the ENTIRE "learning from mistakes" mechanism, and it is deliberately
// modest: we compare a call's outcome to a BENCHMARK (the NIFTY/SENSEX) over a
// ~1-trading-day horizon and record whether a directional call actually beat
// simply holding the index. That recorded history is later fed back into the
// prompt as plain context (see claude.ts) so the model can SEE its own record.
// The model is NOT retrained or fine-tuned and does NOT improve over time —
// there is no self-training here of any kind.
//
// Why benchmark-relative? Because "the price rose" is mostly market drift: in a
// rising market almost everything rises, so raw-direction scoring flatters the
// bot with skill it doesn't have. Scoring against the index measures the only
// thing that matters — did picking this stock beat just holding the market.

import { toYahooSymbol } from "./prices";
import type {
  Calibration,
  CallRecord,
  Confidence,
  ConfidenceBucket,
  History,
  Outcome,
  Stance,
  TipHistory,
} from "./types";

/**
 * Score a single directional call by OUTPERFORMANCE vs the benchmark.
 *
 * `stockReturn` and `benchmarkReturn` are fractional returns over the same
 * window (e.g. 0.012 = +1.2%). When no benchmark is available, callers pass
 * benchmarkReturn = 0, which gracefully degrades to raw-direction scoring.
 *
 *   - "Add"            is right if the stock OUTPERFORMED the benchmark
 *   - "Trim" / "Avoid" is right if the stock UNDERPERFORMED the benchmark
 *   - "Hold" / "Watch" are NOT scored (excluded from the hit rate)
 *
 * Exactly matching the benchmark is treated as "unscored".
 */
export function scoreCall(
  stance: Stance,
  stockReturn: number,
  benchmarkReturn: number,
): Outcome {
  const delta = stockReturn - benchmarkReturn; // out/under-performance
  const outperformed = delta > 0;
  const underperformed = delta < 0;
  if (stance === "Add") {
    return outperformed ? "right" : underperformed ? "wrong" : "unscored";
  }
  if (stance === "Trim" || stance === "Avoid") {
    return underperformed ? "right" : outperformed ? "wrong" : "unscored";
  }
  return "unscored"; // Hold, Watch
}

type RawPriceGetter = (ticker: string) => Promise<number | null>;

/**
 * Evaluate every still-pending call from PREVIOUS runs against its benchmark.
 * Mutates the records in `history` in place and returns how many were newly
 * resolved.
 */
export async function evaluatePending(
  history: History,
  getRawPrice: RawPriceGetter,
  todayISO: string,
): Promise<number> {
  let resolved = 0;
  for (const call of history.calls) {
    if (call.outcome !== "pending") continue;
    // Don't score calls made today (e.g. a manual same-day re-run); they need
    // at least one trading day to play out.
    if (call.date === todayISO) continue;

    // No price was captured at call time -> it can never be scored.
    if (call.priceAtCall == null) {
      call.outcome = "unscored";
      call.evaluatedDate = todayISO;
      resolved++;
      continue;
    }

    const stockNow = await getRawPrice(toYahooSymbol(call.symbol, call.exchange));
    if (stockNow == null) {
      // Couldn't fetch the stock price this run; leave pending and retry later.
      continue;
    }
    const stockReturn = stockNow / call.priceAtCall - 1;

    // Benchmark return over the same window (if we stored an index level at call
    // time and can fetch it now). Otherwise fall back to raw direction.
    let benchmarkReturn = 0;
    let benchmarked = false;
    let indexNow: number | null = null;
    if (call.indexSymbol && call.indexAtCall != null) {
      indexNow = await getRawPrice(call.indexSymbol);
      if (indexNow != null) {
        benchmarkReturn = indexNow / call.indexAtCall - 1;
        benchmarked = true;
      }
    }

    call.outcome = scoreCall(call.stance, stockReturn, benchmarkReturn);
    call.evaluatedPrice = stockNow;
    call.evaluatedIndexPrice = indexNow;
    call.stockReturnPct = stockReturn * 100;
    call.benchmarkReturnPct = benchmarked ? benchmarkReturn * 100 : undefined;
    call.benchmarked = benchmarked;
    call.evaluatedDate = todayISO;
    resolved++;
  }
  return resolved;
}

/** Running hit rate across all resolved directional calls. */
export function computeHitRate(history: History): {
  right: number;
  wrong: number;
  rate: number | null;
} {
  let right = 0;
  let wrong = 0;
  for (const c of history.calls) {
    if (c.outcome === "right") right++;
    else if (c.outcome === "wrong") wrong++;
  }
  const total = right + wrong;
  return { right, wrong, rate: total > 0 ? right / total : null };
}

/**
 * Assumed probability that a directional call is right, per stated confidence.
 *
 * The model returns a categorical Low/Medium/High — to compute a Brier score we
 * need a number. These are a DOCUMENTED ASSUMPTION (not the model's own
 * probability): "Low" still implies a lean past a coin flip, "High" implies a
 * strong one. The Brier score below then measures how well those implied
 * probabilities matched reality. The per-bucket hit rates are assumption-free
 * and are the primary signal.
 */
export const CONFIDENCE_PROB: Record<Confidence, number> = {
  Low: 0.55,
  Medium: 0.65,
  High: 0.75,
};

/**
 * Compute confidence calibration over all scored directional calls.
 *
 * This is the honest "learn from mistakes" loop: the result is fed back into the
 * prompt (see claude.ts) so the model confronts whether its own confidence has
 * meant anything. It does NOT retrain the model — it's a measured statistic the
 * model is shown as context.
 */
export function computeCalibration(history: History): Calibration {
  const order: Confidence[] = ["High", "Medium", "Low"];
  const acc: Record<Confidence, { right: number; wrong: number }> = {
    High: { right: 0, wrong: 0 },
    Medium: { right: 0, wrong: 0 },
    Low: { right: 0, wrong: 0 },
  };
  let brierSum = 0;
  let scored = 0;

  for (const c of history.calls) {
    if (c.outcome !== "right" && c.outcome !== "wrong") continue; // scored only
    scored++;
    const bucket = acc[c.confidence];
    if (c.outcome === "right") bucket.right++;
    else bucket.wrong++;
    const outcome = c.outcome === "right" ? 1 : 0;
    const forecast = CONFIDENCE_PROB[c.confidence];
    brierSum += (forecast - outcome) ** 2;
  }

  const buckets: ConfidenceBucket[] = order.map((confidence) => {
    const { right, wrong } = acc[confidence];
    const count = right + wrong;
    return { confidence, count, right, wrong, rate: count > 0 ? right / count : null };
  });

  return { buckets, scored, brier: scored > 0 ? brierSum / scored : null };
}

// ---- buy-tips track record --------------------------------------------------
// Tips are BUY ideas, so a tip is "right" if it OUTPERFORMED the index over the
// ~1-trading-day window after it was suggested (same yardstick as the calls).

/** Score every still-pending tip from previous runs against its benchmark. */
export async function evaluatePendingTips(
  tips: TipHistory,
  getRawPrice: RawPriceGetter,
  todayISO: string,
): Promise<number> {
  let resolved = 0;
  for (const t of tips.tips) {
    if (t.outcome !== "pending") continue;
    if (t.date === todayISO) continue; // needs at least one trading day
    if (t.priceAtTip == null || !t.exchange) {
      t.outcome = "unscored";
      t.evaluatedDate = todayISO;
      resolved++;
      continue;
    }
    const now = await getRawPrice(toYahooSymbol(t.symbol, t.exchange));
    if (now == null) continue; // retry next run
    const stockReturn = now / t.priceAtTip - 1;

    let benchmarkReturn = 0;
    let benchmarked = false;
    if (t.indexSymbol && t.indexAtTip != null) {
      const indexNow = await getRawPrice(t.indexSymbol);
      if (indexNow != null) {
        benchmarkReturn = indexNow / t.indexAtTip - 1;
        benchmarked = true;
      }
    }
    const delta = stockReturn - benchmarkReturn;
    t.outcome = delta > 0 ? "right" : delta < 0 ? "wrong" : "unscored";
    t.evaluatedPrice = now;
    t.stockReturnPct = stockReturn * 100;
    t.benchmarkReturnPct = benchmarked ? benchmarkReturn * 100 : null;
    t.evaluatedDate = todayISO;
    resolved++;
  }
  return resolved;
}

export interface TipsTrack {
  right: number;
  wrong: number;
  scored: number;
  rate: number | null; // right / (right+wrong)
  avgReturnPct: number | null; // mean ~1-day return of scored tips
  avgVsIndexPct: number | null; // mean outperformance vs the index
}

/** Running track record across all scored tips. */
export function computeTipsTrack(tips: TipHistory): TipsTrack {
  let right = 0;
  let wrong = 0;
  let rSum = 0;
  let rN = 0;
  let vSum = 0;
  let vN = 0;
  for (const t of tips.tips) {
    if (t.outcome === "right") right++;
    else if (t.outcome === "wrong") wrong++;
    else continue;
    if (typeof t.stockReturnPct === "number") {
      rSum += t.stockReturnPct;
      rN++;
      if (typeof t.benchmarkReturnPct === "number") {
        vSum += t.stockReturnPct - t.benchmarkReturnPct;
        vN++;
      }
    }
  }
  const total = right + wrong;
  return {
    right,
    wrong,
    scored: total,
    rate: total > 0 ? right / total : null,
    avgReturnPct: rN > 0 ? rSum / rN : null,
    avgVsIndexPct: vN > 0 ? vSum / vN : null,
  };
}

/**
 * Equity curve for the tips treated as an equal-weight, daily-rebalanced 1-day
 * strategy: for each evaluation date, compound the average return of the tips
 * scored that day. Returned as an index that starts at 100.
 */
export function buildTipsEquitySeries(
  tips: TipHistory,
): { date: string; value: number }[] {
  const byDate = new Map<string, number[]>();
  for (const t of tips.tips) {
    if (
      (t.outcome === "right" || t.outcome === "wrong") &&
      typeof t.stockReturnPct === "number" &&
      t.evaluatedDate
    ) {
      const arr = byDate.get(t.evaluatedDate) ?? [];
      arr.push(t.stockReturnPct);
      byDate.set(t.evaluatedDate, arr);
    }
  }
  const dates = [...byDate.keys()].sort();
  const out: { date: string; value: number }[] = [];
  let v = 100;
  for (const d of dates) {
    const rs = byDate.get(d) as number[];
    const avg = rs.reduce((s, x) => s + x, 0) / rs.length; // percent
    v = v * (1 + avg / 100);
    out.push({ date: d, value: Math.round(v * 100) / 100 });
  }
  return out;
}

/** Re-export for callers that want the record type handy. */
export type { CallRecord };

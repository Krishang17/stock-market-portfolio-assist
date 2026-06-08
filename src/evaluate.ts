// Track-record evaluation.
//
// This is the ENTIRE "learning from mistakes" mechanism, and it is deliberately
// modest: we compare the price stored when a call was made to the current price
// and record whether a directional call went the predicted way. That recorded
// history is later fed back into the prompt as plain context (see claude.ts) so
// the model can SEE its own record. The model is NOT retrained or fine-tuned and
// does NOT improve over time — there is no self-training here of any kind.

import type { Exchange, History, Outcome, Stance } from "./types";

/**
 * Score a single directional call over a ~1-trading-day horizon.
 *
 * Only directional stances count toward the hit rate:
 *   - "Add"            is right if the price ROSE
 *   - "Trim" / "Avoid" is right if the price FELL
 *   - "Hold" / "Watch" are NOT scored (excluded from the hit rate)
 *
 * An exactly-flat price is treated as "unscored" rather than wrong — we can't
 * honestly call a non-move either way.
 */
export function scoreCall(
  stance: Stance,
  priceAtCall: number,
  currentPrice: number,
): Outcome {
  const rose = currentPrice > priceAtCall;
  const fell = currentPrice < priceAtCall;
  if (stance === "Add") return rose ? "right" : fell ? "wrong" : "unscored";
  if (stance === "Trim" || stance === "Avoid") {
    return fell ? "right" : rose ? "wrong" : "unscored";
  }
  return "unscored"; // Hold, Watch
}

type PriceGetter = (
  symbol: string,
  exchange: Exchange,
) => Promise<number | null>;

/**
 * Evaluate every still-pending call from PREVIOUS runs by comparing the stored
 * price-at-call to the current price. Mutates the records in `history` in place
 * and returns how many calls were newly resolved.
 */
export async function evaluatePending(
  history: History,
  getPrice: PriceGetter,
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

    const current = await getPrice(call.symbol, call.exchange);
    if (current == null) {
      // Couldn't fetch a price this run; leave it pending and retry next time.
      continue;
    }

    call.outcome = scoreCall(call.stance, call.priceAtCall, current);
    call.evaluatedPrice = current;
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

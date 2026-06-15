// Claude client: per-holding analysis + research ideas, WITH source links.
//
// We call the Anthropic Messages API (https://api.anthropic.com/v1/messages)
// through the official SDK with the server-side `web_search` tool enabled, so the
// model pulls current news itself (no separate news API) AND we capture the
// source URLs it consulted — so every read on the dashboard can link to where
// the facts came from.
//
// On "learning from mistakes": recent past calls + outcomes are formatted into
// the prompt as plain text context (see formatRecentCalls / formatCalibration).
// The model can SEE its own record, but it is NOT retrained or fine-tuned and
// does NOT improve between runs.

import Anthropic from "@anthropic-ai/sdk";

import type {
  Analysis,
  Calibration,
  CallRecord,
  Confidence,
  Holding,
  Idea,
  Source,
  Stance,
} from "./types";

// Default Claude model; overridable via the MODEL env var / repo variable.
const DEFAULT_MODEL = "claude-sonnet-4-6";

// Lazy singleton so importing this module never throws when ANTHROPIC_API_KEY
// is absent (e.g. during local type-checking).
let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic();
  return client;
}
function model(): string {
  return process.env.MODEL?.trim() || DEFAULT_MODEL;
}

// Capture WHY analysis fell back, so the dashboard can show the real reason
// (e.g. "credit balance too low" vs "no API key") instead of guessing.
let lastFailureReason: string | null = null;
export function getLastFailureReason(): string | null {
  return lastFailureReason;
}
function noteFailure(err: unknown): void {
  const raw = err instanceof Error ? err.message : String(err);
  // Pull the human-readable message out of an API error JSON if present.
  const m = raw.match(/"message"\s*:\s*"([^"]+)"/);
  lastFailureReason = (m ? m[1] : raw).slice(0, 240);
}

// web_search runs server-side; dynamic filtering is built into this version.
// max_uses caps searches per call — web-search results are token-heavy, so this
// is the main lever on cost (and latency) per holding.
const WEB_SEARCH_TOOL = {
  type: "web_search_20260209",
  name: "web_search",
  max_uses: 3,
} as const;

function extractText(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

/**
 * Collect the source links Claude consulted via web search, so the dashboard can
 * show "here's where this came from". We read web_search_tool_result blocks (and
 * any inline text citations). Nested server-tool block shapes vary across SDK
 * versions, so we read them defensively.
 */
function extractSources(content: Anthropic.ContentBlock[]): Source[] {
  const out: Source[] = [];
  const seen = new Set<string>();
  const add = (url: unknown, title: unknown) => {
    if (typeof url !== "string" || !url || seen.has(url)) return;
    seen.add(url);
    out.push({ url, title: typeof title === "string" && title ? title : url });
  };
  for (const block of content as unknown as Array<Record<string, unknown>>) {
    if (block?.type === "web_search_tool_result" && Array.isArray(block.content)) {
      for (const r of block.content as Array<Record<string, unknown>>) {
        if (r?.type === "web_search_result") add(r.url, r.title);
      }
    }
    if (block?.type === "text" && Array.isArray(block.citations)) {
      for (const c of block.citations as Array<Record<string, unknown>>) {
        add(c?.url, c?.title);
      }
    }
  }
  return out.slice(0, 6);
}

interface WebSearchResult {
  text: string;
  sources: Source[];
}

/**
 * Run one Messages request with web search enabled; return the final text plus
 * the sources consulted. Server-side tool loops can stop with "pause_turn"; when
 * that happens we re-send the assistant turn so the server resumes.
 */
async function askWithWebSearch(
  system: string,
  userText: string,
  maxTokens: number,
): Promise<WebSearchResult> {
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: userText },
  ];
  let finalText = "";
  const sources: Source[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < 4; i++) {
    const resp = await getClient().messages.create({
      model: model(),
      max_tokens: maxTokens,
      system,
      tools: [WEB_SEARCH_TOOL],
      messages,
    });
    const text = extractText(resp.content);
    if (text) finalText = text;
    for (const s of extractSources(resp.content)) {
      if (!seen.has(s.url)) {
        seen.add(s.url);
        sources.push(s);
      }
    }
    if (resp.stop_reason === "pause_turn") {
      messages.push({
        role: "assistant",
        content: resp.content as unknown as Anthropic.ContentBlockParam[],
      });
      continue;
    }
    break;
  }
  return { text: finalText, sources: sources.slice(0, 6) };
}

// ---- robust JSON extraction -------------------------------------------------

/** Pull the first {...} object out of a response, tolerating fences/prose. */
function extractJsonObject(raw: string): string | null {
  if (!raw) return null;
  const s = raw.replace(/```(?:json)?/gi, "").replace(/```/g, "");
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  return s.slice(start, end + 1);
}

/** Pull the first [...] array out of a response, tolerating fences/prose. */
function extractJsonArray(raw: string): string | null {
  if (!raw) return null;
  const s = raw.replace(/```(?:json)?/gi, "").replace(/```/g, "");
  const start = s.indexOf("[");
  const end = s.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return null;
  return s.slice(start, end + 1);
}

const STANCES: readonly Stance[] = ["Add", "Hold", "Trim", "Watch", "Avoid"];
const CONFIDENCES: readonly Confidence[] = ["Low", "Medium", "High"];

function normalizeAnalysis(parsed: unknown): Analysis | null {
  if (!parsed || typeof parsed !== "object") return null;
  const p = parsed as Record<string, unknown>;
  const stance = STANCES.includes(p.stance as Stance)
    ? (p.stance as Stance)
    : null;
  if (!stance) return null;
  const confidence = CONFIDENCES.includes(p.confidence as Confidence)
    ? (p.confidence as Confidence)
    : "Low";
  const reasoning = typeof p.reasoning === "string" ? p.reasoning.trim() : "";
  const keyNews = Array.isArray(p.keyNews)
    ? p.keyNews.filter((x): x is string => typeof x === "string").slice(0, 3)
    : [];
  return {
    stance,
    confidence,
    reasoning: reasoning || "(no reasoning returned)",
    keyNews,
  };
}

/** Honest fallback when the model call or JSON parse fails for one stock. */
export function fallbackAnalysis(): Analysis {
  return {
    stance: "Watch",
    confidence: "Low",
    reasoning:
      "Automated analysis was unavailable this run (model, credit, or parse error). Recorded as Watch, which is not scored.",
    keyNews: [],
    sources: [],
    unavailable: true,
  };
}

function fmtPct(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
}

function formatRecentCalls(recent: CallRecord[]): string {
  if (!recent.length) return "Your prior calls on this stock: none on record yet.";
  const lines = recent.map((c) => {
    const at = c.priceAtCall != null ? `₹${c.priceAtCall}` : "n/a";
    let res: string = c.outcome;
    if (c.outcome === "right" || c.outcome === "wrong") {
      if (
        typeof c.stockReturnPct === "number" &&
        typeof c.benchmarkReturnPct === "number"
      ) {
        res += ` (stock ${fmtPct(c.stockReturnPct)} vs index ${fmtPct(c.benchmarkReturnPct)})`;
      } else if (typeof c.stockReturnPct === "number") {
        res += ` (stock ${fmtPct(c.stockReturnPct)}, no benchmark)`;
      }
    }
    return `- ${c.date}: ${c.stance} @ ${at} -> ${res}`;
  });
  return (
    "Your prior calls on this stock (most recent first), scored as outperformance " +
    "vs the index. This is shown ONLY as honest context so you can see your own " +
    "record — it does NOT mean you have learned, improved, or been retrained:\n" +
    lines.join("\n")
  );
}

/**
 * Format the confidence-calibration stats for the prompt. This is the feedback
 * loop: the model is shown whether its OWN past confidence has meant anything,
 * so it can pick today's confidence honestly. (Still just context — no retrain.)
 */
function formatCalibration(cal: Calibration): string {
  if (!cal || cal.scored === 0) {
    return "Calibration: no scored directional calls yet — keep your confidence modest.";
  }
  const parts = cal.buckets
    .filter((b) => b.count > 0)
    .map(
      (b) =>
        `${b.confidence} confidence: beat the index ${Math.round((b.rate ?? 0) * 100)}% of the time (${b.count} call${b.count === 1 ? "" : "s"})`,
    );
  const small = cal.scored < 20 ? " (small sample so far — treat as a weak signal)" : "";
  const brier =
    cal.brier != null
      ? ` Overall Brier score ${cal.brier.toFixed(2)} (0.25 is what you'd get always saying "50/50"; lower is better).`
      : "";
  return (
    "Calibration of YOUR OWN past directional calls, scored vs the index" +
    small +
    ":\n" +
    parts.join("\n") +
    "." +
    brier +
    "\nIf higher confidence has NOT led to better outcomes, do not inflate your confidence here — say Low or Medium."
  );
}

// ---- per-holding analysis ---------------------------------------------------

const ANALYSIS_SYSTEM = `You are a careful equity analyst writing a brief, honest morning note on ONE existing holding in an Indian retail investor's portfolio (NSE/BSE).

Honesty rules (do not soften these):
- This is information, not financial advice.
- Short-term direction (about one trading day) is close to a coin flip. Never imply reliability. No hype, no price targets, no guarantees.
- Your track record is scored as OUTPERFORMANCE vs the index (NIFTY/SENSEX): an "Add" only counts as right if the stock beats simply holding the index over ~1 day, and "Trim"/"Avoid" only if it lags. Beating the market short-term is hard — stay humble.
- Base every claim on what you find via the web_search tool. Search for the most recent, relevant news for THIS specific company before forming a view. Do not state facts you did not find.

You may be shown your own recent past calls and how they turned out. That history is context only — it does not mean you have been retrained or that you improve over time.

Output ONLY a single minified JSON object, no code fences and no other text:
{"stance":"Add|Hold|Trim|Watch|Avoid","confidence":"Low|Medium|High","reasoning":"at most 3 short plain sentences, honest about uncertainty, no hype","keyNews":["short headline", up to 3]}`;

export async function analyzeHolding(
  holding: Holding,
  price: number | null,
  recent: CallRecord[],
  calibration: Calibration,
): Promise<Analysis> {
  const exch = holding.exchange === "NS" ? "NSE" : "BSE";
  const priceLine =
    price != null
      ? `Current price: ₹${price} (your buy price: ₹${holding.buyPrice})`
      : "Current price: unavailable this run.";
  const user = `Holding: ${holding.name} (${holding.symbol}, ${exch})
${priceLine}

${formatRecentCalls(recent)}

${formatCalibration(calibration)}

Search for current news on this company, then return your JSON read now.`;

  let result: WebSearchResult;
  try {
    result = await askWithWebSearch(ANALYSIS_SYSTEM, user, 1500);
  } catch (err) {
    console.error(
      `[claude] analyzeHolding failed for ${holding.symbol}:`,
      err instanceof Error ? err.message : err,
    );
    noteFailure(err);
    return fallbackAnalysis();
  }

  const json = extractJsonObject(result.text);
  if (!json) {
    lastFailureReason ??= "the model returned output with no JSON";
    return fallbackAnalysis();
  }
  try {
    const parsed = normalizeAnalysis(JSON.parse(json));
    if (!parsed) {
      lastFailureReason ??= "the model returned JSON that didn't match the expected shape";
      return fallbackAnalysis();
    }
    parsed.sources = result.sources;
    return parsed;
  } catch {
    lastFailureReason ??= "the model returned invalid JSON";
    return fallbackAnalysis();
  }
}

// ---- research ideas ---------------------------------------------------------

const IDEAS_SYSTEM = `You suggest Indian-market stock ideas as STARTING POINTS FOR RESEARCH ONLY — never recommendations or calls.

Honesty rules:
- This is information, not financial advice.
- You cannot predict short-term moves; present these only as things to look into.
- Base every claim on what you find via the web_search tool.

Output ONLY a single minified JSON array, no code fences and no other text:
[{"symbol":"TICKER","name":"Company","why":"one short line","risk":"one short line"}]
Return 2 or 3 ideas.`;

export interface IdeasResult {
  ideas: Idea[];
  sources: Source[];
}

export async function suggestIdeas(held: string[]): Promise<IdeasResult> {
  const user = `I already hold: ${held.join(", ") || "(nothing yet)"}.
Suggest 2-3 liquid Indian-listed stocks I do NOT already hold, each with a one-line reason to look into it and a one-line key risk. Return the JSON array now.`;

  let result: WebSearchResult;
  try {
    result = await askWithWebSearch(IDEAS_SYSTEM, user, 2000);
  } catch (err) {
    console.error(
      "[claude] suggestIdeas failed:",
      err instanceof Error ? err.message : err,
    );
    noteFailure(err);
    return { ideas: [], sources: [] };
  }

  const json = extractJsonArray(result.text);
  if (!json) return { ideas: [], sources: result.sources };
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return { ideas: [], sources: result.sources };
    const heldSet = new Set(held.map((h) => h.toUpperCase()));
    const ideas = arr
      .filter(
        (x: unknown): x is Record<string, unknown> =>
          !!x &&
          typeof x === "object" &&
          typeof (x as Record<string, unknown>).symbol === "string" &&
          typeof (x as Record<string, unknown>).why === "string" &&
          typeof (x as Record<string, unknown>).risk === "string",
      )
      .filter((x) => !heldSet.has(String(x.symbol).toUpperCase()))
      .slice(0, 3)
      .map((x) => ({
        symbol: String(x.symbol),
        name: typeof x.name === "string" ? x.name : undefined,
        why: String(x.why),
        risk: String(x.risk),
      }));
    return { ideas, sources: result.sources };
  } catch {
    return { ideas: [], sources: result.sources };
  }
}

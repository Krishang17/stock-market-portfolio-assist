// Claude client: per-holding analysis + research ideas.
//
// We call the Anthropic Messages API (https://api.anthropic.com/v1/messages)
// through the official SDK with the server-side `web_search` tool enabled, so
// the model pulls current news itself — there is no separate news API.
//
// On "learning from mistakes": the only thing that happens is that recent past
// calls and their outcomes are formatted into the prompt as plain text context
// (see formatRecentCalls). The model can therefore SEE its own record, but it is
// NOT retrained or fine-tuned and does NOT improve between runs.

import Anthropic from "@anthropic-ai/sdk";

import type {
  Analysis,
  CallRecord,
  Confidence,
  Holding,
  Idea,
  Stance,
} from "./types";

// The user asked for "a current Claude Sonnet model, configurable via MODEL".
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

// web_search runs server-side; dynamic filtering is built into this version.
const WEB_SEARCH_TOOL = {
  type: "web_search_20260209",
  name: "web_search",
} as const;

function extractText(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

/**
 * Run one Messages request with web search enabled and return the final text.
 * Server-side tool loops can stop with reason "pause_turn"; when that happens we
 * re-send the assistant turn so the server resumes where it left off.
 */
async function askWithWebSearch(
  system: string,
  userText: string,
  maxTokens: number,
): Promise<string> {
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: userText },
  ];
  let finalText = "";
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
    if (resp.stop_reason === "pause_turn") {
      messages.push({
        role: "assistant",
        content: resp.content as unknown as Anthropic.ContentBlockParam[],
      });
      continue;
    }
    break;
  }
  return finalText;
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
  const reasoning =
    typeof p.reasoning === "string" ? p.reasoning.trim() : "";
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
      "Automated analysis was unavailable this run (model or parse error). Recorded as Watch, which is not scored.",
    keyNews: [],
  };
}

function formatRecentCalls(recent: CallRecord[]): string {
  if (!recent.length) return "Your prior calls on this stock: none on record yet.";
  const lines = recent.map((c) => {
    const at = c.priceAtCall != null ? `₹${c.priceAtCall}` : "n/a";
    let res: string = c.outcome;
    if (
      (c.outcome === "right" || c.outcome === "wrong") &&
      c.evaluatedPrice != null
    ) {
      res += ` (price next session ₹${c.evaluatedPrice})`;
    }
    return `- ${c.date}: ${c.stance} @ ${at} -> ${res}`;
  });
  return (
    "Your prior calls on this stock (most recent first). This is shown ONLY as " +
    "honest context so you can acknowledge your own record — it does NOT mean " +
    "you have learned, improved, or been retrained:\n" +
    lines.join("\n")
  );
}

// ---- per-holding analysis ---------------------------------------------------

const ANALYSIS_SYSTEM = `You are a careful equity analyst writing a brief, honest morning note on ONE existing holding in an Indian retail investor's portfolio (NSE/BSE).

Honesty rules (do not soften these):
- This is information, not financial advice.
- Short-term direction (about one trading day) is close to a coin flip. Never imply reliability. No hype, no price targets, no guarantees.
- Use the web_search tool to find the most recent, relevant news for THIS specific company before forming a view.

You may be shown your own recent past calls and how they turned out. That history is context only — it does not mean you have been retrained or that you improve over time.

Output ONLY a single minified JSON object, no code fences and no other text:
{"stance":"Add|Hold|Trim|Watch|Avoid","confidence":"Low|Medium|High","reasoning":"at most 3 short plain sentences, honest about uncertainty, no hype","keyNews":["short headline", up to 3]}`;

export async function analyzeHolding(
  holding: Holding,
  price: number | null,
  recent: CallRecord[],
): Promise<Analysis> {
  const exch = holding.exchange === "NS" ? "NSE" : "BSE";
  const priceLine =
    price != null
      ? `Current price: ₹${price} (your buy price: ₹${holding.buyPrice})`
      : "Current price: unavailable this run.";
  const user = `Holding: ${holding.name} (${holding.symbol}, ${exch})
${priceLine}

${formatRecentCalls(recent)}

Search for current news on this company, then return your JSON read now.`;

  let raw = "";
  try {
    raw = await askWithWebSearch(ANALYSIS_SYSTEM, user, 1500);
  } catch (err) {
    console.error(
      `[claude] analyzeHolding failed for ${holding.symbol}:`,
      err instanceof Error ? err.message : err,
    );
    return fallbackAnalysis();
  }

  const json = extractJsonObject(raw);
  if (!json) return fallbackAnalysis();
  try {
    return normalizeAnalysis(JSON.parse(json)) ?? fallbackAnalysis();
  } catch {
    return fallbackAnalysis();
  }
}

// ---- research ideas ---------------------------------------------------------

const IDEAS_SYSTEM = `You suggest Indian-market stock ideas as STARTING POINTS FOR RESEARCH ONLY — never recommendations or calls.

Honesty rules:
- This is information, not financial advice.
- You cannot predict short-term moves; present these only as things to look into.
- Use the web_search tool for current context.

Output ONLY a single minified JSON array, no code fences and no other text:
[{"symbol":"TICKER","name":"Company","why":"one short line","risk":"one short line"}]
Return 2 or 3 ideas.`;

export async function suggestIdeas(held: string[]): Promise<Idea[]> {
  const user = `I already hold: ${held.join(", ") || "(nothing yet)"}.
Suggest 2-3 liquid Indian-listed stocks I do NOT already hold, each with a one-line reason to look into it and a one-line key risk. Return the JSON array now.`;

  let raw = "";
  try {
    raw = await askWithWebSearch(IDEAS_SYSTEM, user, 2000);
  } catch (err) {
    console.error(
      "[claude] suggestIdeas failed:",
      err instanceof Error ? err.message : err,
    );
    return [];
  }

  const json = extractJsonArray(raw);
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return [];
    const heldSet = new Set(held.map((h) => h.toUpperCase()));
    return arr
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
  } catch {
    return [];
  }
}

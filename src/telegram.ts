// Telegram delivery.
//
// Sends the briefing via https://api.telegram.org/bot<token>/sendMessage,
// splitting into multiple messages when it would exceed Telegram's ~4096-char
// limit. If a chunk fails to parse as Markdown, we retry it as plain text so the
// briefing always gets through.

const API_BASE = "https://api.telegram.org";
const TELEGRAM_HARD_LIMIT = 4096;
// Stay comfortably under the hard limit to leave room for Markdown overhead.
const CHUNK_LIMIT = 3800;

/**
 * Strip characters that break Telegram's legacy Markdown when they appear in
 * dynamic text we don't control (news headlines, reasoning, company names).
 * Our own structural markup (e.g. *bold*) is applied to safe literals only.
 */
export function mdSafe(s: string): string {
  return s
    .replace(/[*_`[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Pack pre-formatted sections into messages under Telegram's size limit. */
export function packChunks(sections: string[], limit = CHUNK_LIMIT): string[] {
  const safeLimit = Math.min(limit, TELEGRAM_HARD_LIMIT);
  const out: string[] = [];
  let cur = "";
  for (const raw of sections) {
    const piece = raw.trim();
    if (!piece) continue;
    if (piece.length > safeLimit) {
      // A single section is itself too big — flush and hard-split it.
      if (cur) {
        out.push(cur);
        cur = "";
      }
      for (let i = 0; i < piece.length; i += safeLimit) {
        out.push(piece.slice(i, i + safeLimit));
      }
      continue;
    }
    if (cur && cur.length + 2 + piece.length > safeLimit) {
      out.push(cur);
      cur = "";
    }
    cur = cur ? `${cur}\n\n${piece}` : piece;
  }
  if (cur) out.push(cur);
  return out;
}

async function postMessage(
  token: string,
  chatId: string,
  text: string,
  markdown: boolean,
): Promise<boolean> {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  };
  if (markdown) body.parse_mode = "Markdown";

  const res = await fetch(`${API_BASE}/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error(
      `[telegram] send failed (${markdown ? "Markdown" : "plain"}): ${res.status} ${detail}`,
    );
    return false;
  }
  return true;
}

/**
 * Send each chunk. If creds are missing, print the briefing to stdout instead
 * (useful for local dry runs). If Markdown parsing fails, retry once as plain
 * text so a stray character never blocks delivery.
 */
export async function sendTelegram(chunks: string[]): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.error(
      "[telegram] TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set; printing briefing instead:\n",
    );
    console.log(chunks.join("\n\n----------\n\n"));
    return;
  }

  for (const chunk of chunks) {
    try {
      const ok = await postMessage(token, chatId, chunk, true);
      if (!ok) await postMessage(token, chatId, chunk, false);
    } catch (err) {
      console.error(
        "[telegram] unexpected error:",
        err instanceof Error ? err.message : err,
      );
    }
  }
}

// Renders docs/briefing.json into the dashboard. Pure vanilla JS, no build step.
// All dynamic text goes through textContent / typed DOM nodes (never innerHTML),
// so model/news text can't inject markup.

const inr = (n) =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2,
  }).format(n);

const pct = (n) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

const PILL = { Add: "buy", Avoid: "sell", Trim: "trim", Hold: "hold", Watch: "watch" };

function sourcesRow(sources) {
  if (!sources || !sources.length) return null;
  const row = el("div", { class: "sources" }, [el("span", { class: "label", text: "Sources:" })]);
  sources.forEach((s, i) => {
    const a = el("a", { href: s.url, target: "_blank", rel: "noopener noreferrer" });
    let host = s.title;
    try {
      host = new URL(s.url).hostname.replace(/^www\./, "");
    } catch {
      /* keep title */
    }
    a.textContent = s.title && s.title !== s.url ? s.title : host;
    a.title = s.url;
    row.appendChild(a);
    if (i < sources.length - 1) row.appendChild(document.createTextNode(""));
  });
  return row;
}

function renderTrack(data) {
  const root = document.getElementById("track");
  root.innerHTML = "";
  const t = data.track || {};
  const cal = data.calibration || {};

  const row = el("div", { class: "row" });
  if (t.rate == null) {
    row.appendChild(el("span", { class: "big", text: "No scored calls yet" }));
    row.appendChild(
      el("span", { class: "muted", text: "calls need a day to be scored vs the index" }),
    );
  } else {
    row.appendChild(el("span", { class: "big", text: `${Math.round(t.rate * 100)}% hit rate` }));
    row.appendChild(
      el("span", { class: "muted", text: `${t.right}/${t.right + t.wrong} directional calls beat the index` }),
    );
  }

  if (cal.scored > 0 && Array.isArray(cal.buckets)) {
    const parts = cal.buckets
      .filter((b) => b.count > 0)
      .map((b) => `${b.confidence} ${Math.round((b.rate ?? 0) * 100)}% (${b.count})`)
      .join(" · ");
    const brier = cal.brier != null ? ` · Brier ${cal.brier.toFixed(2)}` : "";
    row.appendChild(el("span", { class: "muted", text: `Confidence: ${parts}${brier}` }));
  }
  root.appendChild(row);

  root.appendChild(
    el("p", {
      class: "note",
      text:
        '"Right" = the pick beat just holding the NIFTY/SENSEX over ~1 day (Buy more = beat it, Trim/Sell = lagged it; Hold/Watch not scored). ~50% is a coin flip; Brier 0.25 = always guessing 50/50.',
    }),
  );
}

function holdingCard(h) {
  const card = el("div", { class: "stock" });

  const pill = el("span", {
    class: `pill ${PILL[h.stance] || "watch"}`,
    text: h.action || h.stance,
  });
  const top = el("div", { class: "top" }, [
    el("div", {}, [
      el("div", { class: "sym", text: `${h.symbol} ` }, [
        el("span", { class: "muted", text: `(${h.exchange})` }),
      ]),
      el("div", { class: "name", text: h.name || "" }),
    ]),
    el("div", {}, [pill, el("span", { class: "conf", text: `${h.confidence}` })]),
  ]);
  card.appendChild(top);

  if (h.price != null) {
    const line = el("div", { class: "priceline" });
    line.appendChild(document.createTextNode(`${inr(h.price)}  ·  `));
    if (h.plPct != null) {
      line.appendChild(
        el("span", { class: h.plPct >= 0 ? "pos" : "neg", text: pct(h.plPct) }),
      );
      if (h.plAbs != null) {
        line.appendChild(
          document.createTextNode(
            ` (${h.plAbs >= 0 ? "+" : ""}${inr(h.plAbs)} on ${h.qty}) vs buy ${inr(h.buyPrice)}`,
          ),
        );
      }
    }
    card.appendChild(line);
  } else {
    card.appendChild(el("div", { class: "priceline muted", text: "Price unavailable" }));
  }

  if (h.reasoning) card.appendChild(el("p", { class: "reasoning", text: h.reasoning }));

  if (h.keyNews && h.keyNews.length) {
    const ul = el("ul", { class: "news" });
    h.keyNews.forEach((n) => ul.appendChild(el("li", { text: n })));
    card.appendChild(ul);
  }

  const src = sourcesRow(h.sources);
  if (src) card.appendChild(src);

  return card;
}

function renderHoldings(data) {
  const root = document.getElementById("holdings");
  root.innerHTML = "";
  (data.holdings || []).forEach((h) => root.appendChild(holdingCard(h)));
}

function ideaCard(idea) {
  const card = el("div", { class: "stock idea" });
  card.appendChild(
    el("div", { class: "top" }, [
      el("div", {}, [
        el("div", { class: "sym", text: idea.symbol }),
        idea.name ? el("div", { class: "name", text: idea.name }) : null,
      ]),
      el("span", { class: "pill watch", text: "Research" }),
    ]),
  );
  if (idea.why) card.appendChild(el("p", { class: "why", text: idea.why }));
  if (idea.risk) card.appendChild(el("p", { class: "risk", text: `Risk: ${idea.risk}` }));
  return card;
}

function renderIdeas(data) {
  const root = document.getElementById("ideas");
  root.innerHTML = "";
  const ideas = (data.ideas && data.ideas.items) || [];
  if (!ideas.length) {
    root.appendChild(el("p", { class: "muted", text: "No ideas generated this run." }));
  } else {
    ideas.forEach((i) => root.appendChild(ideaCard(i)));
  }
  const src = sourcesRow(data.ideas && data.ideas.sources);
  if (src) root.appendChild(src);
}

function renderMeta(data) {
  const meta = document.getElementById("meta");
  let when = data.generatedAt;
  try {
    when = new Date(data.generatedAt).toLocaleString();
  } catch {
    /* keep raw */
  }
  meta.textContent = `Last updated ${when} · model ${data.model || "—"}`;

  const banner = document.getElementById("banner");
  if (data.degraded) {
    banner.classList.remove("hidden");
    banner.textContent =
      "⚠️ Claude analysis was unavailable for this run — most likely the Anthropic account has no credit balance (Plans & Billing). Prices are live, but the stances below are placeholders until analysis runs.";
  } else {
    banner.classList.add("hidden");
  }
}

async function main() {
  try {
    const res = await fetch(`./briefing.json?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderMeta(data);
    renderTrack(data);
    renderHoldings(data);
    renderIdeas(data);
  } catch (err) {
    document.getElementById("meta").innerHTML = "";
    document.getElementById("meta").appendChild(
      el("span", {
        class: "error",
        text: `Could not load briefing.json (${err.message}). The first scheduled run hasn't published data yet, or Pages isn't serving /docs.`,
      }),
    );
  }
}

main();

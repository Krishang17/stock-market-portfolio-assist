// Renders docs/briefing.json into the dashboard. Vanilla JS + Chart.js (CDN).
// Dynamic text goes through textContent / typed DOM nodes (never innerHTML).

const inr = (n) =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2,
  }).format(n);

const inr0 = (n) =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(n);

const pct = (n) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
const cls = (n) => (n >= 0 ? "pos" : "neg");

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
const PALETTE = [
  "#58a6ff", "#3fb950", "#d29922", "#f85149", "#bc8cff", "#39c5cf",
  "#ff7b72", "#7ee787", "#ffa657", "#a5d6ff", "#f0883e", "#d2a8ff",
];

// ---- summary + indices ------------------------------------------------------

function stat(label, valueNode, subNode) {
  return el("div", { class: "stat" }, [
    el("div", { class: "label", text: label }),
    valueNode,
    subNode || null,
  ]);
}

function renderSummary(data) {
  const root = document.getElementById("summary");
  root.innerHTML = "";
  const t = data.totals;
  if (!t) return;

  root.appendChild(
    stat("Total value", el("div", { class: "val", text: inr(t.value) })),
  );
  root.appendChild(
    stat("Invested", el("div", { class: "val", text: inr(t.invested) })),
  );
  const plVal = el("div", { class: `val ${cls(t.pnlAbs)}` }, [
    (t.pnlAbs >= 0 ? "+" : "") + inr(t.pnlAbs),
  ]);
  const plSub =
    t.pnlPct != null
      ? el("div", { class: `sub ${cls(t.pnlPct)}`, text: pct(t.pnlPct) })
      : null;
  root.appendChild(stat("Total P/L (unrealised)", plVal, plSub));

  const sub =
    t.unpriced > 0
      ? el("div", { class: "sub muted", text: `${t.unpriced} without a price` })
      : null;
  root.appendChild(
    stat("Holdings", el("div", { class: "val", text: String(t.holdings) }), sub),
  );
}

function renderIndices(data) {
  const root = document.getElementById("indices");
  root.innerHTML = "";
  (data.indices || []).forEach((ix) => {
    const chip = el("span", { class: "index-chip" }, [
      el("span", { class: "nm", text: ix.label }),
    ]);
    if (ix.price != null) {
      chip.appendChild(
        document.createTextNode(
          ix.price.toLocaleString("en-IN", { maximumFractionDigits: 2 }),
        ),
      );
      if (ix.changePercent != null) {
        chip.appendChild(document.createTextNode("  "));
        chip.appendChild(
          el("span", { class: cls(ix.changePercent), text: pct(ix.changePercent) }),
        );
      }
    } else {
      chip.appendChild(document.createTextNode("—"));
    }
    root.appendChild(chip);
  });
}

// ---- charts -----------------------------------------------------------------

function renderCharts(data) {
  if (typeof Chart === "undefined") return; // CDN blocked — skip silently
  Chart.defaults.color = "#9aa3af";
  Chart.defaults.borderColor = "#2a2f3a";
  Chart.defaults.font.family = "inherit";

  const holdings = data.holdings || [];
  const priced = holdings.filter((h) => h.price != null && h.value != null);

  // Allocation donut (by market value)
  const alloc = priced.filter((h) => h.value > 0);
  if (alloc.length) {
    new Chart(document.getElementById("allocChart"), {
      type: "doughnut",
      data: {
        labels: alloc.map((h) => h.symbol),
        datasets: [
          {
            data: alloc.map((h) => h.value),
            backgroundColor: alloc.map((_, i) => PALETTE[i % PALETTE.length]),
            borderWidth: 0,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: "right", labels: { boxWidth: 12, font: { size: 11 } } },
          tooltip: { callbacks: { label: (c) => `${c.label}: ${inr0(c.parsed)}` } },
        },
      },
    });
  }

  // P/L by stock (bar)
  const plH = holdings.filter((h) => h.plAbs != null);
  if (plH.length) {
    new Chart(document.getElementById("plChart"), {
      type: "bar",
      data: {
        labels: plH.map((h) => h.symbol),
        datasets: [
          {
            data: plH.map((h) => h.plAbs),
            backgroundColor: plH.map((h) => (h.plAbs >= 0 ? "#3fb950" : "#f85149")),
            borderWidth: 0,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (c) => inr0(c.parsed.y) } },
        },
        scales: { x: { ticks: { font: { size: 10 } } } },
      },
    });
  }

  // Portfolio value over time (line)
  const series = data.valueSeries || [];
  if (series.length) {
    new Chart(document.getElementById("valueChart"), {
      type: "line",
      data: {
        labels: series.map((p) => p.date),
        datasets: [
          {
            label: "Value",
            data: series.map((p) => p.value),
            borderColor: "#58a6ff",
            backgroundColor: "rgba(88,166,255,0.12)",
            fill: true,
            tension: 0.25,
            pointRadius: series.length > 30 ? 0 : 3,
          },
          {
            label: "Invested",
            data: series.map((p) => p.invested),
            borderColor: "#9aa3af",
            borderDash: [5, 4],
            fill: false,
            tension: 0,
            pointRadius: 0,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { labels: { boxWidth: 12, font: { size: 11 } } },
          tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${inr0(c.parsed.y)}` } },
        },
        scales: { y: { ticks: { callback: (v) => inr0(v) } } },
      },
    });
  } else {
    const c = document.getElementById("valueChart");
    if (c && c.parentElement) {
      c.parentElement.appendChild(
        el("p", { class: "muted", text: "Builds up as the daily job runs." }),
      );
    }
  }
}

// ---- track record -----------------------------------------------------------

function renderTrack(data) {
  const root = document.getElementById("track");
  root.innerHTML = "";
  const t = data.track || {};
  const cal = data.calibration || {};

  const row = el("div", { class: "row" });
  if (t.rate == null) {
    row.appendChild(el("span", { class: "big", text: "No scored calls yet" }));
    row.appendChild(
      el("span", { class: "muted", text: "directional calls get scored vs the index after a day" }),
    );
  } else {
    row.appendChild(el("span", { class: "big", text: `${Math.round(t.rate * 100)}% hit rate` }));
    row.appendChild(
      el("span", { class: "muted", text: `${t.right}/${t.right + t.wrong} beat the index` }),
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
        '"Right" = the pick beat just holding the NIFTY/SENSEX over ~1 day. Hold/Watch not scored. ~50% is a coin flip; Brier 0.25 = always guessing 50/50.',
    }),
  );
}

// ---- holdings + ideas -------------------------------------------------------

function sourcesRow(sources) {
  if (!sources || !sources.length) return null;
  const row = el("div", { class: "sources" }, [el("span", { class: "label", text: "Sources:" })]);
  sources.forEach((s) => {
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
  });
  return row;
}

function holdingCard(h) {
  const card = el("div", { class: "stock" });

  const pill = el("span", { class: `pill ${PILL[h.stance] || "watch"}`, text: h.action || h.stance });
  card.appendChild(
    el("div", { class: "top" }, [
      el("div", {}, [
        el("div", { class: "sym" }, [`${h.symbol} `, el("span", { class: "muted", text: `(${h.exchange})` })]),
        el("div", { class: "name", text: h.name || "" }),
      ]),
      el("div", {}, [pill, el("span", { class: "conf", text: h.confidence })]),
    ]),
  );

  if (h.price != null) {
    const line = el("div", { class: "priceline" });
    line.appendChild(document.createTextNode(`${inr(h.price)}`));
    if (h.dayChangePct != null) {
      line.appendChild(document.createTextNode("  "));
      line.appendChild(el("span", { class: cls(h.dayChangePct), text: pct(h.dayChangePct) + " today" }));
    }
    card.appendChild(line);

    const pl = el("div", { class: "priceline" });
    if (h.plPct != null && h.plAbs != null) {
      pl.appendChild(el("span", { class: cls(h.plPct), text: `${pct(h.plPct)} (${h.plAbs >= 0 ? "+" : ""}${inr(h.plAbs)})` }));
      pl.appendChild(document.createTextNode(`  ·  ${h.qty} @ ${inr(h.buyPrice)}  ·  val ${inr0(h.value)}`));
    }
    card.appendChild(pl);
  } else {
    card.appendChild(el("div", { class: "priceline muted", text: `Price unavailable · ${h.qty} @ ${inr(h.buyPrice)}` }));
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
  // Show biggest positions first.
  const holdings = [...(data.holdings || [])].sort(
    (a, b) => (b.value ?? 0) - (a.value ?? 0),
  );
  holdings.forEach((h) => root.appendChild(holdingCard(h)));
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
      "⚠️ Claude analysis was unavailable for this run — most likely the Anthropic account has no credit balance (Plans & Billing). Prices, totals and charts are live; only the stance/reasoning are placeholders until analysis runs.";
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
    renderSummary(data);
    renderIndices(data);
    renderCharts(data);
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

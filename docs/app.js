// Renders docs/briefing.json into the dashboard. Vanilla JS + Chart.js (CDN).
// Overview at "#"; per-stock detail at "#/SYMBOL". Dynamic text goes through
// textContent / typed DOM nodes (never innerHTML).

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
const round2 = (n) => Math.round(n * 100) / 100;

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

// Chart date ranges for the per-stock detail view (count of trading days).
const RANGES = [
  { key: "1M", days: 22 },
  { key: "3M", days: 66 },
  { key: "6M", days: 132 },
  { key: "1Y", days: 252 },
  { key: "MAX", days: null },
];
const INDEX_NAME = { "^NSEI": "NIFTY 50", "^BSESN": "SENSEX", "^NSEBANK": "BANK NIFTY" };
const BENCH_FOR_LABEL = { NSE: "^NSEI", BSE: "^BSESN" };
const SPARK_DAYS = 66; // ~3 months for the card sparklines

let DATA = null;
let detailChart = null;

// detail-chart state (kept across prev/next navigation for a smooth UX)
let currentDetail = null;
let detailRange = 132; // 6M default
let detailBench = false;

// holdings list state
let filterText = "";
let sortKey = "value";

/** Read a CSS custom property off :root (so charts follow the theme). */
function getCssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Create a chart, destroying any previous one bound to the same canvas. */
function chartOn(canvasId, config) {
  if (typeof Chart === "undefined") return null;
  const c = document.getElementById(canvasId);
  if (!c) return null;
  Chart.getChart(c)?.destroy();
  return new Chart(c, config);
}

/** Point Chart.js defaults at the current theme's colours. */
function applyChartTheme() {
  if (typeof Chart === "undefined") return;
  Chart.defaults.color = getCssVar("--muted") || "#9aa3af";
  Chart.defaults.borderColor = getCssVar("--border") || "#2a2f3a";
  Chart.defaults.font.family = "inherit";
}

// A thin vertical guide line at the hovered point (works with mode:'index').
const crosshairPlugin = {
  id: "crosshair",
  afterDraw(chart) {
    const active = chart._active;
    if (!active || !active.length || !chart.chartArea) return;
    const x = active[0].element.x;
    const { top, bottom } = chart.chartArea;
    const ctx = chart.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = "rgba(154,163,175,0.55)";
    ctx.stroke();
    ctx.restore();
  },
};

// Shared options for the zoomable/hoverable time-series charts.
function timeSeriesOptions({ yFmt, rebased }) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: { labels: { boxWidth: 12, font: { size: 11 } } },
      tooltip: {
        callbacks: {
          label: (c) =>
            rebased
              ? `${c.dataset.label}: ${c.parsed.y.toFixed(1)} (base 100)`
              : `${c.dataset.label}: ${inr(c.parsed.y)}`,
        },
      },
      // Ignored gracefully if chartjs-plugin-zoom didn't load.
      zoom: {
        zoom: {
          wheel: { enabled: true },
          pinch: { enabled: true },
          drag: { enabled: true, backgroundColor: "rgba(88,166,255,0.15)" },
          mode: "x",
        },
        pan: { enabled: true, mode: "x", modifierKey: "shift" },
        limits: { x: { minRange: 3 } },
      },
    },
    scales: {
      x: { ticks: { maxTicksLimit: 8, font: { size: 10 } } },
      y: { ticks: { callback: (v) => yFmt(v) } },
    },
  };
}

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

// ---- small shared helpers ---------------------------------------------------

function fmtRelative(iso) {
  const then = new Date(iso).getTime();
  if (!isFinite(then)) return "";
  const s = (Date.now() - then) / 1000;
  if (s < 90) return "just now";
  const m = s / 60;
  if (m < 90) return `${Math.round(m)}m ago`;
  const h = m / 60;
  if (h < 36) return `${Math.round(h)}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** Tiny inline SVG sparkline from [{t,c}] points (green up / red down). */
function sparklineSVG(points) {
  if (!points || points.length < 2) return null;
  const vals = points.map((p) => p.c);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const w = 132;
  const h = 30;
  const stepX = w / (vals.length - 1);
  const coords = vals.map(
    (v, i) => `${(i * stepX).toFixed(1)},${(h - ((v - min) / span) * h).toFixed(1)}`,
  );
  const up = vals[vals.length - 1] >= vals[0];
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("class", "spark");
  const poly = document.createElementNS(NS, "polyline");
  poly.setAttribute("points", coords.join(" "));
  poly.setAttribute("fill", "none");
  poly.setAttribute("stroke", up ? "#3fb950" : "#f85149");
  poly.setAttribute("stroke-width", "1.5");
  poly.setAttribute("stroke-linejoin", "round");
  poly.setAttribute("stroke-linecap", "round");
  svg.appendChild(poly);
  return svg;
}

/** Stats derived purely from a price-history array (no extra data needed). */
function computeSeriesStats(hist) {
  if (!hist || hist.length < 2) return null;
  const vals = hist.map((p) => p.c);
  const last = vals[vals.length - 1];
  const high = Math.max(...vals);
  const low = Math.min(...vals);
  const retLast = (n) => {
    const i = vals.length - 1 - n;
    return i >= 0 ? (last / vals[i] - 1) * 100 : null;
  };
  let sum = 0;
  let sum2 = 0;
  let n = 0;
  for (let i = 1; i < vals.length; i++) {
    const r = Math.log(vals[i] / vals[i - 1]);
    if (isFinite(r)) {
      sum += r;
      sum2 += r * r;
      n++;
    }
  }
  const mean = n ? sum / n : 0;
  const variance = n ? Math.max(0, sum2 / n - mean * mean) : 0;
  const vol = n ? Math.sqrt(variance) * Math.sqrt(252) * 100 : null;
  return {
    high,
    low,
    last,
    pctBelowHigh: ((last - high) / high) * 100,
    ret1m: retLast(22),
    ret6m: retLast(132),
    // History is capped at ~1y, so the oldest point is ~1y ago.
    ret1y: vals.length > 1 ? (last / vals[0] - 1) * 100 : null,
    vol,
  };
}

function benchPointsFor(h) {
  const sym = h.benchmarkSymbol || BENCH_FOR_LABEL[h.exchange];
  return (DATA.indexHistory && DATA.indexHistory[sym]) || [];
}
function benchNameFor(h) {
  const sym = h.benchmarkSymbol || BENCH_FOR_LABEL[h.exchange];
  return INDEX_NAME[sym] || "Index";
}

/** Holdings in the canonical overview order (value, high → low). */
function orderedSymbols() {
  return [...(DATA.holdings || [])]
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
    .map((h) => h.symbol);
}

function toast(msg) {
  let t = document.getElementById("toast");
  if (!t) {
    t = el("div", { id: "toast", class: "toast" });
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), 1800);
}

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
  root.appendChild(stat("Total value", el("div", { class: "val", text: inr(t.value) })));
  root.appendChild(stat("Invested", el("div", { class: "val", text: inr(t.invested) })));
  const plVal = el("div", { class: `val ${cls(t.pnlAbs)}` }, [
    (t.pnlAbs >= 0 ? "+" : "") + inr(t.pnlAbs),
  ]);
  const plSub =
    t.pnlPct != null ? el("div", { class: `sub ${cls(t.pnlPct)}`, text: pct(t.pnlPct) }) : null;
  root.appendChild(stat("Total P/L (unrealised)", plVal, plSub));
  const sub =
    t.unpriced > 0 ? el("div", { class: "sub muted", text: `${t.unpriced} without a price` }) : null;
  root.appendChild(stat("Holdings", el("div", { class: "val", text: String(t.holdings) }), sub));
}

function renderIndices(data) {
  const root = document.getElementById("indices");
  root.innerHTML = "";
  (data.indices || []).forEach((ix) => {
    const chip = el("span", { class: "index-chip" }, [el("span", { class: "nm", text: ix.label })]);
    if (ix.price != null) {
      chip.appendChild(
        document.createTextNode(ix.price.toLocaleString("en-IN", { maximumFractionDigits: 2 })),
      );
      if (ix.changePercent != null) {
        chip.appendChild(document.createTextNode("  "));
        chip.appendChild(el("span", { class: cls(ix.changePercent), text: pct(ix.changePercent) }));
      }
    } else {
      chip.appendChild(document.createTextNode("—"));
    }
    root.appendChild(chip);
  });
}

// ---- today's movers ---------------------------------------------------------

function renderMovers(data) {
  const root = document.getElementById("movers");
  if (!root) return;
  root.innerHTML = "";
  const withDay = (data.holdings || []).filter((h) => typeof h.dayChangePct === "number");
  if (!withDay.length) {
    root.classList.add("hidden");
    return;
  }
  const sorted = [...withDay].sort((a, b) => b.dayChangePct - a.dayChangePct);
  const gainers = sorted.filter((h) => h.dayChangePct > 0).slice(0, 3);
  const negs = sorted.filter((h) => h.dayChangePct < 0);
  const losers = negs.slice(-3).reverse();
  const make = (label, arr) => {
    if (!arr.length) return null;
    const wrap = el("div", { class: "movers-group" }, [el("span", { class: "mlabel", text: label })]);
    arr.forEach((h) => {
      const chip = el("button", { class: "mchip" }, [
        el("span", { class: "ms", text: h.symbol }),
        el("span", { class: cls(h.dayChangePct), text: " " + pct(h.dayChangePct) }),
      ]);
      chip.addEventListener("click", () => {
        location.hash = "#/" + encodeURIComponent(h.symbol);
      });
      wrap.appendChild(chip);
    });
    return wrap;
  };
  const g = make("▲ Gainers", gainers);
  const l = make("▼ Losers", losers);
  if (!g && !l) {
    root.classList.add("hidden");
    return;
  }
  root.classList.remove("hidden");
  if (g) root.appendChild(g);
  if (l) root.appendChild(l);
}

// ---- portfolio health / risk insights --------------------------------------

function renderHealth(data) {
  const root = document.getElementById("health");
  if (!root) return;
  root.innerHTML = "";
  const t = data.totals || {};
  const hs = (data.holdings || []).filter((h) => h.value != null && h.value > 0);
  if (!hs.length || !t.value) {
    root.classList.add("hidden");
    return;
  }
  root.classList.remove("hidden");
  const byVal = [...hs].sort((a, b) => b.value - a.value);
  const top = byVal[0];
  const topPct = (top.value / t.value) * 100;
  const top3 = (byVal.slice(0, 3).reduce((s, h) => s + h.value, 0) / t.value) * 100;
  const withPl = (data.holdings || []).filter((h) => typeof h.plPct === "number");
  const losers = withPl.filter((h) => h.plPct < 0);
  const worst = losers.length ? losers.reduce((w, h) => (h.plPct < w.plPct ? h : w)) : null;
  const best = withPl.length ? withPl.reduce((b, h) => (h.plPct > b.plPct ? h : b)) : null;

  root.appendChild(el("h3", { class: "muted", text: "Portfolio health" }));
  const row = el("div", { class: "health-row" });
  const chip = (label, val, klass) =>
    el("div", { class: "hchip" }, [
      el("div", { class: "label", text: label }),
      el("div", { class: "v" + (klass ? " " + klass : ""), text: val }),
    ]);
  row.appendChild(chip("Largest position", `${top.symbol} · ${topPct.toFixed(0)}%`, topPct > 30 ? "neg" : null));
  row.appendChild(chip("Top-3 concentration", `${top3.toFixed(0)}%`, top3 > 60 ? "neg" : null));
  row.appendChild(chip("Holdings in loss", `${losers.length}/${(data.holdings || []).length}`));
  if (best) row.appendChild(chip("Best performer", `${best.symbol} · ${pct(best.plPct)}`, "pos"));
  if (worst) row.appendChild(chip("Worst performer", `${worst.symbol} · ${pct(worst.plPct)}`, "neg"));
  root.appendChild(row);
  if (topPct > 30) {
    root.appendChild(
      el("p", {
        class: "note",
        text: `⚠️ ${top.symbol} is ${topPct.toFixed(0)}% of your portfolio — that's concentrated. Spreading it out reduces single-stock risk.`,
      }),
    );
  }
}

// ---- overview charts --------------------------------------------------------

function renderCharts(data) {
  if (typeof Chart === "undefined") return;
  applyChartTheme();

  const holdings = data.holdings || [];
  const priced = holdings.filter((h) => h.price != null && h.value != null);

  const alloc = priced.filter((h) => h.value > 0);
  if (alloc.length) {
    chartOn("allocChart", {
      type: "doughnut",
      data: {
        labels: alloc.map((h) => h.symbol),
        datasets: [{ data: alloc.map((h) => h.value), backgroundColor: alloc.map((_, i) => PALETTE[i % PALETTE.length]), borderWidth: 0 }],
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

  const plH = holdings.filter((h) => h.plAbs != null);
  if (plH.length) {
    chartOn("plChart", {
      type: "bar",
      data: {
        labels: plH.map((h) => h.symbol),
        datasets: [{ data: plH.map((h) => h.plAbs), backgroundColor: plH.map((h) => (h.plAbs >= 0 ? "#3fb950" : "#f85149")), borderWidth: 0 }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => inr0(c.parsed.y) } } },
        scales: { x: { ticks: { font: { size: 10 } } } },
      },
    });
  }

  const series = data.valueSeries || [];
  if (series.length) {
    chartOn("valueChart", {
      type: "line",
      data: {
        labels: series.map((p) => p.date),
        datasets: [
          { label: "Value", data: series.map((p) => p.value), borderColor: "#58a6ff", backgroundColor: "rgba(88,166,255,0.12)", fill: true, tension: 0.25, pointRadius: series.length > 30 ? 0 : 3 },
          { label: "Invested", data: series.map((p) => p.invested), borderColor: "#9aa3af", borderDash: [5, 4], fill: false, tension: 0, pointRadius: 0 },
        ],
      },
      options: timeSeriesOptions({ yFmt: (v) => inr0(v), rebased: false }),
      plugins: [crosshairPlugin],
    });
    const vc = document.getElementById("valueChart");
    if (vc) vc.ondblclick = () => Chart.getChart(vc)?.resetZoom?.();
  } else {
    const c = document.getElementById("valueChart");
    if (c && c.parentElement && !c.parentElement.querySelector(".muted")) {
      c.parentElement.appendChild(el("p", { class: "muted", text: "Builds up as the daily job runs." }));
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
    row.appendChild(el("span", { class: "muted", text: "directional calls get scored vs the index after a day" }));
  } else {
    row.appendChild(el("span", { class: "big", text: `${Math.round(t.rate * 100)}% hit rate` }));
    row.appendChild(el("span", { class: "muted", text: `${t.right}/${t.right + t.wrong} beat the index` }));
  }
  if (cal.scored > 0 && Array.isArray(cal.buckets)) {
    const parts = cal.buckets.filter((b) => b.count > 0).map((b) => `${b.confidence} ${Math.round((b.rate ?? 0) * 100)}% (${b.count})`).join(" · ");
    const brier = cal.brier != null ? ` · Brier ${cal.brier.toFixed(2)}` : "";
    row.appendChild(el("span", { class: "muted", text: `Confidence: ${parts}${brier}` }));
  }
  root.appendChild(row);
  root.appendChild(el("p", { class: "note", text: '"Right" = the pick beat just holding the NIFTY/SENSEX over ~1 day. Hold/Watch not scored. ~50% is a coin flip; Brier 0.25 = always guessing 50/50.' }));
}

// ---- overview holdings (compact, clickable) ---------------------------------

function holdingCard(h) {
  const card = el("div", { class: "stock clickable" });
  card.appendChild(
    el("div", { class: "top" }, [
      el("div", {}, [
        el("div", { class: "sym" }, [`${h.symbol} `, el("span", { class: "muted", text: `(${h.exchange})` })]),
        el("div", { class: "name", text: h.name || "" }),
      ]),
      el("div", {}, [el("span", { class: `pill ${PILL[h.stance] || "watch"}`, text: h.action || h.stance }), el("span", { class: "conf", text: h.confidence })]),
    ]),
  );
  if (h.price != null) {
    const line = el("div", { class: "priceline" });
    line.appendChild(document.createTextNode(inr(h.price)));
    if (h.dayChangePct != null) {
      line.appendChild(document.createTextNode("  "));
      line.appendChild(el("span", { class: cls(h.dayChangePct), text: pct(h.dayChangePct) + " today" }));
    }
    card.appendChild(line);
    if (h.plPct != null && h.plAbs != null) {
      card.appendChild(
        el("div", { class: "priceline" }, [
          el("span", { class: cls(h.plPct), text: `${pct(h.plPct)} (${h.plAbs >= 0 ? "+" : ""}${inr(h.plAbs)})` }),
          document.createTextNode(`  ·  val ${inr0(h.value)}`),
        ]),
      );
    }
  } else {
    card.appendChild(el("div", { class: "priceline muted", text: `Price unavailable · ${h.qty} @ ${inr(h.buyPrice)}` }));
  }
  const spark = sparklineSVG((h.priceHistory || []).slice(-SPARK_DAYS));
  if (spark) card.appendChild(el("div", { class: "spark-wrap" }, [spark]));
  card.appendChild(el("div", { class: "muted tap-hint", text: "Tap for prediction + charts →" }));
  card.addEventListener("click", () => {
    location.hash = "#/" + encodeURIComponent(h.symbol);
  });
  return card;
}

function sortedFilteredHoldings(data) {
  let hs = [...(data.holdings || [])];
  const q = filterText.trim().toLowerCase();
  if (q) hs = hs.filter((h) => h.symbol.toLowerCase().includes(q) || (h.name || "").toLowerCase().includes(q));
  const num = (v) => (typeof v === "number" ? v : -Infinity);
  switch (sortKey) {
    case "plPct":
      hs.sort((a, b) => num(b.plPct) - num(a.plPct));
      break;
    case "day":
      hs.sort((a, b) => num(b.dayChangePct) - num(a.dayChangePct));
      break;
    case "name":
      hs.sort((a, b) => (a.name || a.symbol).localeCompare(b.name || b.symbol));
      break;
    case "stance":
      hs.sort((a, b) => (a.stance || "").localeCompare(b.stance || ""));
      break;
    default:
      hs.sort((a, b) => num(b.value) - num(a.value));
  }
  return hs;
}

function renderHoldings(data) {
  const root = document.getElementById("holdings");
  root.innerHTML = "";
  const hs = sortedFilteredHoldings(data);
  if (!hs.length) {
    root.appendChild(el("p", { class: "muted", text: "No holdings match your filter." }));
    return;
  }
  hs.forEach((h) => root.appendChild(holdingCard(h)));
}

// Research links for a tip, built from the (resolved) ticker + exchange.
function researchLinks(symbol, exchange) {
  const sym = encodeURIComponent(symbol);
  const ySuffix = exchange === "BO" ? ".BO" : ".NS";
  const tvEx = exchange === "BO" ? "BSE" : "NSE";
  const links = [
    ["Screener", `https://www.screener.in/company/${sym}/`],
    ["Chart", `https://www.tradingview.com/symbols/${tvEx}-${sym}/`],
    ["Yahoo", `https://finance.yahoo.com/quote/${sym}${ySuffix}`],
    ["News", `https://news.google.com/search?q=${sym}%20stock`],
  ];
  const row = el("div", { class: "research-links" });
  links.forEach(([label, href]) => {
    const a = el("a", { class: "rlink", href, target: "_blank", rel: "noopener noreferrer" }, [label]);
    a.addEventListener("click", (e) => e.stopPropagation()); // don't trigger the card
    row.appendChild(a);
  });
  return row;
}

function ideaCard(idea) {
  const card = el("div", { class: "stock idea clickable" });
  card.appendChild(
    el("div", { class: "top" }, [
      el("div", {}, [el("div", { class: "sym", text: idea.symbol }), idea.name ? el("div", { class: "name", text: idea.name }) : null]),
      el("span", { class: "pill watch", text: "Research" }),
    ]),
  );
  if (typeof idea.price === "number") {
    const line = el("div", { class: "priceline" });
    line.appendChild(document.createTextNode(inr(idea.price)));
    if (typeof idea.dayChangePct === "number") {
      line.appendChild(document.createTextNode("  "));
      line.appendChild(el("span", { class: cls(idea.dayChangePct), text: pct(idea.dayChangePct) + " today" }));
    }
    card.appendChild(line);
  }
  const spark = sparklineSVG((idea.priceHistory || []).slice(-SPARK_DAYS));
  if (spark) card.appendChild(el("div", { class: "spark-wrap" }, [spark]));
  if (idea.why) card.appendChild(el("p", { class: "why" }, [el("strong", { text: "Why " }), document.createTextNode(idea.why)]));
  if (idea.risk) card.appendChild(el("p", { class: "risk" }, [el("strong", { text: "Risk " }), document.createTextNode(idea.risk)]));
  card.appendChild(researchLinks(idea.symbol, idea.exchange));
  // Whole card opens Screener.in (the go-to fundamentals site for Indian stocks).
  card.addEventListener("click", () => {
    window.open(`https://www.screener.in/company/${encodeURIComponent(idea.symbol)}/`, "_blank", "noopener");
  });
  return card;
}

function renderIdeas(data) {
  const root = document.getElementById("ideas");
  root.innerHTML = "";
  const ideas = (data.ideas && data.ideas.items) || [];
  if (!ideas.length) root.appendChild(el("p", { class: "muted", text: "No buy candidates generated this run." }));
  else ideas.forEach((i) => root.appendChild(ideaCard(i)));
  const src = sourcesRow(data.ideas && data.ideas.sources);
  if (src) root.appendChild(src);
}

// ---- export / share ---------------------------------------------------------

function csvCell(v) {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function exportCSV() {
  if (!DATA) return;
  const rows = [
    ["Symbol", "Name", "Exchange", "Qty", "BuyPrice", "Price", "DayChange%", "Value", "Invested", "P/L", "P/L%", "Stance", "Confidence"],
  ];
  (DATA.holdings || []).forEach((h) =>
    rows.push([h.symbol, h.name || "", h.exchange, h.qty, h.buyPrice, h.price ?? "", h.dayChangePct ?? "", h.value ?? "", h.invested ?? "", h.plAbs ?? "", h.plPct ?? "", h.stance, h.confidence]),
  );
  const csv = rows.map((r) => r.map(csvCell).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: `portfolio-${DATA.date || "snapshot"}.csv` });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast("Downloaded CSV");
}

function copySummary() {
  if (!DATA) return;
  const t = DATA.totals || {};
  const lines = [`Portfolio — ${DATA.date || ""}`];
  if (t.value != null) {
    lines.push(
      `Value ${inr0(t.value)} · Invested ${inr0(t.invested)} · P/L ${(t.pnlAbs >= 0 ? "+" : "")}${inr0(t.pnlAbs)} (${t.pnlPct != null ? pct(t.pnlPct) : "—"})`,
    );
  }
  lines.push("");
  [...(DATA.holdings || [])]
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
    .forEach((h) => {
      lines.push(`${h.symbol}: ${h.action || h.stance} (${h.confidence})${h.plPct != null ? " · " + pct(h.plPct) : ""}`);
    });
  const text = lines.join("\n");
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => toast("Copied summary"), () => toast("Copy failed"));
  } else {
    toast("Clipboard unavailable");
  }
}

// ---- per-stock detail -------------------------------------------------------

function drawDetailChart() {
  const h = currentDetail;
  if (!h) return;
  if (detailChart) {
    detailChart.destroy();
    detailChart = null;
  }
  const full = h.priceHistory || [];
  const vis = detailRange == null ? full : full.slice(Math.max(0, full.length - detailRange));
  if (vis.length < 2) return;
  applyChartTheme();
  const labels = vis.map((p) => p.t);

  let datasets;
  let yFmt;
  let rebased = false;
  if (detailBench) {
    rebased = true;
    const idxMap = new Map(benchPointsFor(h).map((p) => [p.t, p.c]));
    const idxVals = vis.map((p) => (idxMap.has(p.t) ? idxMap.get(p.t) : null));
    const sBase = vis[0].c;
    const iBase = idxVals.find((v) => v != null);
    datasets = [
      { label: h.symbol, data: vis.map((p) => (p.c / sBase) * 100), borderColor: "#58a6ff", backgroundColor: "rgba(88,166,255,0.12)", fill: true, tension: 0.2, pointRadius: 0 },
      { label: benchNameFor(h), data: idxVals.map((v) => (v == null || !iBase ? null : (v / iBase) * 100)), borderColor: "#d29922", backgroundColor: "transparent", fill: false, tension: 0.2, pointRadius: 0, spanGaps: true },
    ];
    yFmt = (v) => v.toFixed(0);
  } else {
    datasets = [
      { label: h.symbol, data: vis.map((p) => p.c), borderColor: "#58a6ff", backgroundColor: "rgba(88,166,255,0.12)", fill: true, tension: 0.2, pointRadius: 0 },
      { label: "Avg buy", data: vis.map(() => h.buyPrice), borderColor: "#9aa3af", borderDash: [5, 4], fill: false, pointRadius: 0 },
    ];
    yFmt = (v) => inr0(v);
  }

  detailChart = chartOn("detailPriceChart", {
    type: "line",
    data: { labels, datasets },
    options: timeSeriesOptions({ yFmt, rebased }),
    plugins: [crosshairPlugin],
  });
}

function renderDetail(h) {
  const root = document.getElementById("detail");
  if (detailChart) {
    detailChart.destroy();
    detailChart = null;
  }
  root.innerHTML = "";

  // Back + prev/next navigation
  const order = orderedSymbols();
  const idx = order.indexOf(h.symbol);
  const prevSym = idx > 0 ? order[idx - 1] : null;
  const nextSym = idx >= 0 && idx < order.length - 1 ? order[idx + 1] : null;
  const navRow = el("div", { class: "detail-nav" });
  navRow.appendChild(el("a", { class: "back", href: "#" }, ["← Back to portfolio"]));
  const navBtns = el("div", { class: "nav-btns" });
  const prevB = el("button", { class: "rbtn", text: "‹ Prev" });
  if (!prevSym) prevB.disabled = true;
  else prevB.addEventListener("click", () => { location.hash = "#/" + encodeURIComponent(prevSym); });
  const nextB = el("button", { class: "rbtn", text: "Next ›" });
  if (!nextSym) nextB.disabled = true;
  else nextB.addEventListener("click", () => { location.hash = "#/" + encodeURIComponent(nextSym); });
  navBtns.appendChild(prevB);
  navBtns.appendChild(nextB);
  navRow.appendChild(navBtns);
  root.appendChild(navRow);

  root.appendChild(
    el("div", { class: "d-head" }, [
      el("div", {}, [
        el("h2", { class: "d-title" }, [`${h.symbol} `, el("span", { class: "muted", text: `(${h.exchange})` })]),
        el("div", { class: "d-name", text: h.name || "" }),
      ]),
      el("div", {}, [el("span", { class: `pill ${PILL[h.stance] || "watch"}`, text: h.action || h.stance }), el("span", { class: "conf", text: h.confidence + " confidence" })]),
    ]),
  );

  // Position line
  const pos = el("div", { class: "d-pos" });
  fillPos(pos, h);
  root.appendChild(pos);

  // Stats derived from price history
  const stats = computeSeriesStats(h.priceHistory);
  if (stats) {
    const grid = el("div", { class: "stat-grid" });
    const add = (label, val, klass) =>
      grid.appendChild(
        el("div", { class: "mini-stat" }, [
          el("div", { class: "label", text: label }),
          el("div", { class: "v" + (klass ? " " + klass : ""), text: val }),
        ]),
      );
    add("1Y high", inr0(stats.high));
    add("1Y low", inr0(stats.low));
    add("Below high", pct(stats.pctBelowHigh), cls(stats.pctBelowHigh));
    if (stats.ret1m != null) add("1M return", pct(stats.ret1m), cls(stats.ret1m));
    if (stats.ret6m != null) add("6M return", pct(stats.ret6m), cls(stats.ret6m));
    if (stats.ret1y != null) add("1Y return", pct(stats.ret1y), cls(stats.ret1y));
    if (stats.vol != null) add("Volatility (ann.)", `${stats.vol.toFixed(0)}%`);
    root.appendChild(el("div", { class: "card stat-card" }, [el("h3", { class: "muted", text: "Stats (from price history)" }), grid]));
  }

  // Prediction
  const pred = el("div", { class: "pred" });
  pred.appendChild(el("h3", { text: "Prediction (information, not advice)" }));
  pred.appendChild(el("div", {}, [el("span", { class: `pill ${PILL[h.stance] || "watch"}`, text: h.action || h.stance }), el("span", { class: "conf", text: h.confidence + " confidence" })]));
  if (h.reasoning) pred.appendChild(el("p", { class: "reasoning", text: h.reasoning }));
  if (h.keyNews && h.keyNews.length) {
    const ul = el("ul", { class: "news" });
    h.keyNews.forEach((n) => ul.appendChild(el("li", { text: n })));
    pred.appendChild(ul);
  }
  const src = sourcesRow(h.sources);
  if (src) pred.appendChild(src);
  root.appendChild(pred);

  // Price chart (range toggles + benchmark overlay + hover crosshair + zoom)
  const hist = h.priceHistory || [];
  const chartCard = el("div", { class: "chart-card" }, [el("h3", { text: "Price history" })]);
  if (hist.length > 1) {
    const toolbar = el("div", { class: "chart-toolbar" });
    RANGES.forEach((r) => {
      const b = el("button", { class: "rbtn range" + (r.days === detailRange ? " active" : ""), text: r.key });
      b.addEventListener("click", () => {
        detailRange = r.days;
        toolbar.querySelectorAll(".range").forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
        drawDetailChart();
      });
      toolbar.appendChild(b);
    });
    const benchBtn = el("button", { class: "rbtn bench" + (detailBench ? " active" : ""), text: "vs " + benchNameFor(h) });
    benchBtn.addEventListener("click", () => {
      detailBench = !detailBench;
      benchBtn.classList.toggle("active", detailBench);
      drawDetailChart();
    });
    toolbar.appendChild(benchBtn);
    const resetBtn = el("button", { class: "rbtn", text: "Reset zoom" });
    resetBtn.addEventListener("click", () => detailChart?.resetZoom?.());
    toolbar.appendChild(resetBtn);
    chartCard.appendChild(toolbar);

    const canvas = el("canvas", { id: "detailPriceChart" });
    chartCard.appendChild(el("div", { class: "canvas-wrap" }, [canvas]));
    chartCard.appendChild(el("p", { class: "chart-hint muted", text: "Hover for prices · scroll or drag a box to zoom · shift-drag to pan · double-click to reset" }));
    root.appendChild(chartCard);

    currentDetail = h;
    drawDetailChart();
    canvas.addEventListener("dblclick", () => detailChart?.resetZoom?.());
  } else {
    chartCard.appendChild(el("p", { class: "muted", text: "Price history unavailable for this symbol." }));
    root.appendChild(chartCard);
  }

  // Past calls for this stock
  const callsCard = el("div", { class: "card", style: "margin-top:14px" }, [el("h3", { class: "muted", text: "This stock's past calls (scored vs the index)" })]);
  const calls = h.recentCalls || [];
  if (!calls.length) {
    callsCard.appendChild(el("p", { class: "muted", text: "No past calls on record yet — they'll appear here as the daily job runs." }));
  } else {
    const table = el("table", { class: "calls" });
    table.appendChild(
      el("tr", {}, [el("th", { text: "Date" }), el("th", { text: "Call" }), el("th", { text: "Outcome" }), el("th", { text: "Stock vs index" })]),
    );
    calls.forEach((c) => {
      let vs = "—";
      if (typeof c.stockReturnPct === "number" && typeof c.benchmarkReturnPct === "number") {
        vs = `${pct(c.stockReturnPct)} vs ${pct(c.benchmarkReturnPct)}`;
      } else if (typeof c.stockReturnPct === "number") {
        vs = pct(c.stockReturnPct);
      }
      table.appendChild(
        el("tr", {}, [
          el("td", { text: c.date }),
          el("td", { text: `${c.stance} (${c.confidence})` }),
          el("td", {}, [el("span", { class: `tag ${c.outcome}`, text: c.outcome })]),
          el("td", { text: vs }),
        ]),
      );
    });
    callsCard.appendChild(table);
  }
  root.appendChild(callsCard);
}

// ---- routing ----------------------------------------------------------------

function renderOverview() {
  renderSummary(DATA);
  renderIndices(DATA);
  renderMovers(DATA);
  renderHealth(DATA);
  renderCharts(DATA);
  renderTrack(DATA);
  renderHoldings(DATA);
  renderIdeas(DATA);
}

function route() {
  if (!DATA) return;
  const detail = document.getElementById("detail");
  const overview = document.getElementById("overview");
  const m = (location.hash || "").match(/^#\/(.+)$/);
  if (m) {
    const sym = decodeURIComponent(m[1]);
    const h = (DATA.holdings || []).find((x) => x.symbol === sym);
    if (h) {
      renderDetail(h);
      detail.classList.remove("hidden");
      overview.classList.add("hidden");
      window.scrollTo(0, 0);
      return;
    }
  }
  detail.classList.add("hidden");
  detail.innerHTML = "";
  if (detailChart) {
    detailChart.destroy();
    detailChart = null;
  }
  currentDetail = null;
  overview.classList.remove("hidden");
  renderOverview();
}

// ---- theme ------------------------------------------------------------------

function updateThemeBtn() {
  const b = document.getElementById("themeToggle");
  if (!b) return;
  const light = document.documentElement.getAttribute("data-theme") === "light";
  b.textContent = light ? "🌙" : "☀️";
  b.title = light ? "Switch to dark" : "Switch to light";
}

function initTheme() {
  if (localStorage.getItem("theme") === "light") {
    document.documentElement.setAttribute("data-theme", "light");
  }
  updateThemeBtn();
}

function toggleTheme() {
  const light = document.documentElement.getAttribute("data-theme") === "light";
  if (light) {
    document.documentElement.removeAttribute("data-theme");
    localStorage.setItem("theme", "dark");
  } else {
    document.documentElement.setAttribute("data-theme", "light");
    localStorage.setItem("theme", "light");
  }
  updateThemeBtn();
  route(); // re-render charts with the new palette
}

// ---- keyboard ---------------------------------------------------------------

function onKey(e) {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const tag = (e.target && e.target.tagName) || "";
  const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
  const m = (location.hash || "").match(/^#\/(.+)$/);
  if (m) {
    const sym = decodeURIComponent(m[1]);
    const order = orderedSymbols();
    const i = order.indexOf(sym);
    if (e.key === "ArrowRight" && i >= 0 && i < order.length - 1) location.hash = "#/" + encodeURIComponent(order[i + 1]);
    else if (e.key === "ArrowLeft" && i > 0) location.hash = "#/" + encodeURIComponent(order[i - 1]);
    else if (e.key === "Escape") location.hash = "#";
    return;
  }
  if (!typing && e.key === "/") {
    const s = document.getElementById("search");
    if (s) {
      e.preventDefault();
      s.focus();
    }
  }
}

// ---- live prices ------------------------------------------------------------
// The snapshot's reads/tips are from the last scheduled run, but PRICES can be
// refreshed live in-browser (free) from Yahoo's batch "spark" endpoint. Yahoo
// doesn't send CORS headers, so we go through a proxy: a user-configured one
// (e.g. their own Cloudflare Worker) first, then public fallbacks, then direct.
// If everything fails we keep the snapshot values — never worse than before.

const LIVE_INTERVAL_MS = 60000; // 1 minute
const BUILTIN_PROXIES = [
  "https://corsproxy.io/?url=",
  "https://api.allorigins.win/raw?url=",
];

const nowTime = () => new Date().toLocaleTimeString();

// IST market hours: Mon–Fri 09:15–15:30 (epoch-shift trick → timezone-agnostic).
function marketIsOpen() {
  const ist = new Date(Date.now() + 330 * 60000);
  const day = ist.getUTCDay();
  if (day === 0 || day === 6) return false;
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return mins >= 9 * 60 + 15 && mins <= 15 * 60 + 30;
}

/** Yahoo tickers for everything on the page (holdings + indices). */
function liveSymbols() {
  const set = new Set();
  (DATA.holdings || []).forEach((h) => set.add(h.symbol + (h.exchange === "BSE" ? ".BO" : ".NS")));
  (DATA.indices || []).forEach((ix) => ix.symbol && set.add(ix.symbol));
  return [...set];
}

function parseSpark(j) {
  const res = j && j.spark && j.spark.result;
  if (!Array.isArray(res)) return null;
  const map = new Map();
  for (const s of res) {
    const m = s && s.response && s.response[0] && s.response[0].meta;
    const price = m && m.regularMarketPrice;
    const prev = m && (m.chartPreviousClose != null ? m.chartPreviousClose : m.previousClose);
    if (typeof price === "number") map.set(s.symbol, { price, prev: typeof prev === "number" ? prev : null });
  }
  return map;
}

async function fetchLive() {
  const tickers = liveSymbols();
  if (!tickers.length) return null;
  const spark = `https://query1.finance.yahoo.com/v7/finance/spark?symbols=${encodeURIComponent(tickers.join(","))}&range=1d&interval=1d`;
  const prefixes = [];
  const userProxy = localStorage.getItem("liveProxy");
  if (userProxy) prefixes.push(userProxy);
  prefixes.push(...BUILTIN_PROXIES, ""); // "" = direct (works only if CORS ever allowed)
  for (const p of prefixes) {
    try {
      const url = p ? p + encodeURIComponent(spark) : spark;
      const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
      if (!res.ok) continue;
      const map = parseSpark(await res.json());
      if (map && map.size) return map;
    } catch {
      /* try next proxy */
    }
  }
  return null;
}

function recomputeTotals() {
  const hs = (DATA.holdings || []).filter((h) => h.price != null);
  const invested = hs.reduce((s, h) => s + h.buyPrice * h.qty, 0);
  const value = hs.reduce((s, h) => s + h.price * h.qty, 0);
  const pnlAbs = value - invested;
  DATA.totals = {
    ...(DATA.totals || {}),
    invested: round2(invested),
    value: round2(value),
    pnlAbs: round2(pnlAbs),
    pnlPct: invested > 0 ? round2((pnlAbs / invested) * 100) : null,
    holdings: (DATA.holdings || []).length,
    priced: hs.length,
    unpriced: (DATA.holdings || []).length - hs.length,
  };
}

function applyLive(map) {
  (DATA.holdings || []).forEach((h) => {
    const q = map.get(h.symbol + (h.exchange === "BSE" ? ".BO" : ".NS"));
    if (q && q.price != null) {
      h.price = q.price;
      if (q.prev) h.dayChangePct = ((q.price - q.prev) / q.prev) * 100;
      h.value = round2(q.price * h.qty);
      h.plPct = ((q.price - h.buyPrice) / h.buyPrice) * 100;
      h.plAbs = (q.price - h.buyPrice) * h.qty;
    }
  });
  (DATA.indices || []).forEach((ix) => {
    const q = map.get(ix.symbol);
    if (q && q.price != null) {
      ix.price = q.price;
      if (q.prev) ix.changePercent = ((q.price - q.prev) / q.prev) * 100;
    }
  });
  recomputeTotals();
}

function fillPos(pos, h) {
  pos.innerHTML = "";
  if (h.price != null) {
    pos.appendChild(document.createTextNode(inr(h.price)));
    if (h.dayChangePct != null) {
      pos.appendChild(document.createTextNode("  "));
      pos.appendChild(el("span", { class: cls(h.dayChangePct), text: pct(h.dayChangePct) + " today" }));
    }
    if (h.plPct != null && h.plAbs != null) {
      pos.appendChild(document.createTextNode("   ·   P/L "));
      pos.appendChild(el("span", { class: cls(h.plPct), text: `${pct(h.plPct)} (${h.plAbs >= 0 ? "+" : ""}${inr(h.plAbs)})` }));
    }
    pos.appendChild(document.createTextNode(`   ·   ${h.qty} @ ${inr(h.buyPrice)}  ·  value ${inr0(h.value)}`));
  } else {
    pos.appendChild(document.createTextNode(`Price unavailable · ${h.qty} @ ${inr(h.buyPrice)}`));
  }
}

// Re-render only the price-driven views (don't rebuild charts → no flicker).
function renderLiveViews() {
  const m = (location.hash || "").match(/^#\/(.+)$/);
  if (m && currentDetail) {
    const h = (DATA.holdings || []).find((x) => x.symbol === currentDetail.symbol);
    const detailEl = document.getElementById("detail");
    const pos = detailEl && detailEl.querySelector(".d-pos");
    if (h && pos) {
      currentDetail = h;
      fillPos(pos, h);
    }
  } else {
    renderSummary(DATA);
    renderIndices(DATA);
    renderMovers(DATA);
    renderHealth(DATA);
    renderHoldings(DATA);
  }
}

function setLiveStatus(state, text) {
  const wrap = document.getElementById("liveStatus");
  if (!wrap) return;
  wrap.className = "live-status " + state;
  const t = wrap.querySelector(".live-text");
  if (t && text != null) t.textContent = text;
}

let liveBusy = false;
let liveTimer = null;

async function liveTick(manual) {
  if (liveBusy || !DATA) return;
  liveBusy = true;
  const btn = document.getElementById("refreshBtn");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "↻ …";
  }
  setLiveStatus("loading", "Refreshing prices…");
  try {
    const map = await fetchLive();
    if (map && map.size) {
      applyLive(map);
      renderLiveViews();
      const open = marketIsOpen();
      setLiveStatus(open ? "live" : "closed", `${open ? "Prices live" : "Market closed"} · updated ${nowTime()}`);
    } else {
      setLiveStatus("error", "Live prices unavailable — showing last snapshot (click “setup”)");
    }
  } catch {
    setLiveStatus("error", "Live prices unavailable — showing last snapshot");
  } finally {
    liveBusy = false;
    if (btn) {
      btn.disabled = false;
      btn.textContent = "↻ Refresh";
    }
  }
}

function startLive() {
  if (liveTimer) clearInterval(liveTimer);
  liveTick(false); // one fetch now so you see live prices immediately
  liveTimer = setInterval(() => {
    if (document.visibilityState === "visible" && marketIsOpen()) liveTick(false);
  }, LIVE_INTERVAL_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && marketIsOpen()) liveTick(false);
  });
}

// ---- meta + boot ------------------------------------------------------------

function renderMeta(data) {
  const meta = document.getElementById("meta");
  let when = data.generatedAt;
  try {
    when = new Date(data.generatedAt).toLocaleString();
  } catch {
    /* keep raw */
  }
  const rel = fmtRelative(data.generatedAt);
  meta.textContent = `Last updated ${when}${rel ? ` (${rel})` : ""} · model ${data.model || "—"}`;

  const banner = document.getElementById("banner");
  if (data.degraded) {
    banner.classList.remove("hidden");
    const reason = data.degradedReason || "";
    let why = "";
    if (/credit balance/i.test(reason)) why = "the Anthropic credit balance is too low";
    else if (/authentication|api key|x-api-key|resolve auth/i.test(reason))
      why = "no API key was set for this run (a placeholder snapshot generated outside GitHub Actions)";
    else if (/rate.?limit|overloaded|429|529/i.test(reason)) why = "the Anthropic API was rate-limited or overloaded";
    else if (reason) why = reason;
    banner.textContent =
      "⚠️ Claude reads unavailable" + (why ? " — " + why : "") +
      ". Prices, totals and charts are live; the buy/hold/sell reads fill in on the next successful run on GitHub.";
  } else {
    banner.classList.add("hidden");
  }
}

function wireControls() {
  const search = document.getElementById("search");
  if (search) search.addEventListener("input", () => { filterText = search.value; renderHoldings(DATA); });
  const sortSel = document.getElementById("sort");
  if (sortSel) sortSel.addEventListener("change", () => { sortKey = sortSel.value; renderHoldings(DATA); });
  const csvBtn = document.getElementById("exportCsv");
  if (csvBtn) csvBtn.addEventListener("click", exportCSV);
  const copyBtn = document.getElementById("copySummary");
  if (copyBtn) copyBtn.addEventListener("click", copySummary);
  const themeBtn = document.getElementById("themeToggle");
  if (themeBtn) themeBtn.addEventListener("click", toggleTheme);
  const refreshBtn = document.getElementById("refreshBtn");
  if (refreshBtn) refreshBtn.addEventListener("click", () => liveTick(true));
  const liveSetup = document.getElementById("liveSetup");
  if (liveSetup)
    liveSetup.addEventListener("click", (e) => {
      e.preventDefault();
      const cur = localStorage.getItem("liveProxy") || "";
      const v = window.prompt(
        "Optional: a CORS proxy / Cloudflare Worker prefix for reliable live prices.\nThe target URL is appended url-encoded, e.g.  https://my-worker.workers.dev/?url=\nLeave blank to use the public proxies.",
        cur,
      );
      if (v !== null) {
        if (v.trim()) localStorage.setItem("liveProxy", v.trim());
        else localStorage.removeItem("liveProxy");
        liveTick(true);
      }
    });
  document.addEventListener("keydown", onKey);
}

async function main() {
  initTheme();
  wireControls();
  try {
    const res = await fetch(`./briefing.json?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    DATA = await res.json();
    renderMeta(DATA);
    route();
    window.addEventListener("hashchange", route);
    startLive(); // refresh prices live (every minute + on demand)
  } catch (err) {
    const meta = document.getElementById("meta");
    meta.innerHTML = "";
    meta.appendChild(
      el("span", {
        class: "error",
        text: `Could not load briefing.json (${err.message}). The first scheduled run hasn't published data yet, or Pages isn't serving /docs.`,
      }),
    );
  }
}

main();

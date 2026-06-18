# Requirements — Personal Portfolio Intelligence Platform
**Draft v0.2 · 18 Jun 2026 · decisions from dad's review captured (see §9)**

> Goal: a private system that watches a large equity portfolio, keeps **years of history** for every holding, **flags unusual activity** (volume, delivery, price, news) with **alerts**, offers **honest buy/sell decision-support**, ingests **news**, and **learns from its own track record** over time.
>
> Honest framing up front: this is a **monitoring + decision-support** system, not a money-printing oracle. No model reliably predicts short-term prices; what a good system *can* do is surface the right information fast, catch anomalies a human would miss, enforce discipline, and keep an honest scorecard so we improve. We will measure everything **against the index** (beating the market is the only result that counts).

---

## 1. What the shared link is, and how it fits
The link points to **EODHD (EOD Historical Data)** — a commercial financial-data API: ~150k tickers across 70+ exchanges (incl. India NSE/BSE), end-of-day & intraday prices, **fundamentals**, **news**, with Python/Node libraries, an **MCP server**, and a **Claude Code plugin**. 

It's a strong choice as the **data backbone**. One gap to note: EODHD gives prices/fundamentals/news, but India's **delivery quantity / delivery %** is an NSE-specific metric best sourced from NSE's free **`sec_bhavdata_full` bhavcopy** (daily, with historical archives). So the data layer = **EODHD (paid) + NSE bhavcopy (free)**.

---

## 2. Glossary — the terms your dad mentioned (and the ones we'll use)
- **Volume** — number of shares traded in a day. We watch it vs its own recent average to spot spikes.
- **Delivery quantity / Delivery %** — of the shares traded, how many were actually *delivered* (held), not just day-traded. **High & rising delivery % = genuine accumulation/conviction**; a price move on low delivery is often speculative. This is one of your dad's core asks.
- **VWAP** — volume-weighted average price; where the "real" average trade happened.
- **Moving averages (e.g. 20/50/200-day)** — trend; price crossing these is a classic signal.
- **RSI / momentum** — whether a stock is over-bought or over-sold.
- **ATR / volatility** — how much it normally moves; defines what "unusual" means per stock.
- **52-week high/low, drawdown** — position vs range; how far off the peak.
- **Fundamentals** — P/E, EPS, revenue/profit growth, debt, dividend, market cap.
- **F&O Open Interest (OI)** — derivatives positioning; unusual OI can precede big moves.
- **FII/DII flows** — foreign/domestic institutional buying-selling; big drivers in India.
- **Beta** — how much a stock moves relative to the index.
- **Corporate actions** — splits, bonuses, dividends, results dates (must be handled or data looks "anomalous").

---

## 3. Functional requirements

### 3.1 Data collection & storage
- **Multi-year EOD history** (OHLCV, adjusted for splits/dividends) per holding — target 10+ years where available. *Source: EODHD.*
- **Daily delivery qty & delivery %** + historical backfill. *Source: NSE bhavcopy.*
- **Fundamentals** (quarterly results, ratios), **corporate actions**, **dividends**. *Source: EODHD.*
- **F&O Open Interest (OI)** *(confirmed priority)* and **FII/DII** flows. *Source: NSE.*
- Store in a proper **time-series database** so analytics/backtests are fast and history is permanent.
- Automated **daily refresh** + one-time historical backfill; data-quality checks (gaps, bad ticks, corporate-action adjustments).

### 3.2 Unusual-activity detection & triggers (the alerting core)
For each stock we learn its *normal* range and flag deviations. Concrete, explainable signals:
- **Volume spike** — today's volume ≫ its N-day average (e.g. > 2–3× / high z-score).
- **Delivery surprise** — delivery % unusually high/low vs its trend (accumulation/distribution).
- **Price gap / range break** — gap up/down, new 52-week high/low, big ATR-relative move.
- **Volatility regime change** — sudden expansion in daily range.
- **Fundamental events** — results, guidance, rating/target changes, dividend/split.
- **News spike** — surge in news volume or sharply negative/positive sentiment.
- **F&O / OI anomalies** *(confirmed priority)* and **FII/DII** unusual flows.
Each alert says **what** tripped, **how far** outside normal, and **links to the source** — no black boxes.

### 3.3 Buy / sell decision-support
- Combine **technical** (trend, momentum, delivery), **fundamental** (valuation, growth), **AI read** (sourced narrative), and **anomaly flags** into a clear **stance + confidence**, with the reasoning and the risks.
- Every call is **recorded and later scored vs the index** — so the "when to buy/sell" earns trust from a real track record, not claims.
- Position-aware: respects size, concentration, and risk (important for a large portfolio).

### 3.4 News ingestion
- Aggregate company + macro + sector news (EODHD news API + targeted web sources), de-duplicate, tag by ticker, and run **sentiment**. Feed it into both alerts and the reads. Always keep **source links**.

### 3.5 Model & the "learning from mistakes" loop
Realistic, staged:
1. **Scorecard + calibration (already working in our prototype):** every prediction is stored and later graded vs the index; confidence is calibrated against actual hit-rate. The system *sees its own record* and adjusts.
2. **Backtesting engine:** replay signals over years of history with **walk-forward validation** (no look-ahead) to measure what actually works before trusting it.
3. **ML models (Phase 3):** gradient-boosted trees / logistic models on engineered features (volume, delivery, momentum, fundamentals, news sentiment) predicting *probability of beating the index* over a horizon — trained honestly, retrained on a schedule, always benchmarked.
> Honesty: "learning from mistakes" is a measured feedback + retraining loop, not magic. We report Brier score / hit-rate openly and never hide losing calls.

### 3.6 Alerts & reporting
- **Notifications** (you choose channels): email, Telegram, WhatsApp, and/or push — same-day for anomalies, plus a daily/weekly digest.
- **Dashboard** (web): portfolio overview, per-stock deep-dive (price + delivery + volume charts, fundamentals, news, the read, the track record), and the alert feed.

---

## 4. Non-functional requirements
- **Data quality & reliability** first — bad data → bad alerts. Validation + backfill + monitoring.
- **Security/privacy** — it's a private holdings list; no secrets in the browser, encrypted storage, access-controlled. (Note: this is **analysis/alerting only — it does not place trades.**)
- **Cost-aware** — free sources where possible (NSE), paid only where it adds real value (EODHD).
- **Auditable** — every number and call traces back to a source and a timestamp.

## 5. High-level architecture
`EODHD + NSE bhavcopy → ingestion jobs → time-series DB → (analytics/anomaly engine + news/sentiment + signal/ML engine) → alert service (email/Telegram/WhatsApp) + web dashboard`, with a **scorecard/feedback store** wrapping the signal engine.

## 6. What we already have (reusable foundation)
Our current prototype already does, in miniature: portfolio tracking + P/L, AI reads **with source links**, forward "what to buy" tips **scored vs the index**, news via live search, a **calibration/feedback loop**, a **world-news brief**, live prices, search/watchlist/add, and a dashboard. The new platform **upgrades the data layer (EODHD + delivery), adds real anomaly alerts + notifications, multi-year history, backtesting, and proper ML** — but the architecture, honesty model, and scoring carry straight over.

## 7. Phased roadmap (suggested)
- **Phase 0 (now):** this requirements doc + data-source decisions.
- **Phase 1 — Data & Alerts (highest value, fastest):** EODHD + NSE delivery ingestion, multi-year backfill, the anomaly engine, and notifications. *This alone delivers most of what your dad asked for.*
- **Phase 2 — News & Decision-support:** news/sentiment, combined buy/sell stances with the scored track record, richer dashboard.
- **Phase 3 — ML & Learning:** backtesting engine, trained models, scheduled retraining, calibration reporting.

## 8. Indicative costs (to confirm)
- **EODHD subscription** — tiered (data scope decides the plan); **to confirm for India + the features we use**.
- **NSE bhavcopy** — free.
- **Hosting / DB / notifications** — modest cloud cost (can start near-free, scale as needed).
- **AI (reads/news/learning)** — usage-based; controllable.

## 9. Decisions (from dad's review — 18 Jun 2026)
1. **Scope of holdings — NSE/BSE only.** (Indian market; number of names = his full portfolio, to list.)
2. **"Unusual" priorities — track all, with F&O/OI movement an explicit priority** alongside volume, delivery %, price breakouts and news.
3. **Alert channels — to be decided** during the build (email / Telegram / WhatsApp on the table; mix of instant alerts + a digest).
4. **History depth — maximum available** *(to confirm)* — backfill as many years as the data sources allow.
5. **Buy/sell role — decision-support only. NO auto-trading.**
6. **Budget — keep it lean, ~₹2,000/month** *(to confirm)* for data + hosting (free NSE bhavcopy + an entry EODHD tier; scale only if needed).
7. **Privacy/access — owner-only.** Private and access-controlled; only he can see it.

*Still to confirm: exact history depth (#4) and the monthly budget figure (#6).*

## 10. Sources
- EODHD GitHub org — https://github.com/EodHistoricalData
- NSE full bhavcopy + delivery data (community mirror) — https://github.com/chartiny/nse-sec-bhavdata-full
- NSE EOD archives — https://www.nseindia.com/products/content/equities/equities/archieve_eq.htm
- On delivery % as a conviction signal — https://www.microstocks.in/blog/how-to-read-nse-bhavcopy-data

---
*Draft for discussion. Once your dad picks the Phase-1 scope and answers §9, this becomes a concrete build plan with timelines.*

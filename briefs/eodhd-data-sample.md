# EODHD — free data sample & what it contains (for SBI)
**17 Jun 2026 · evaluation for the platform**

## Key finding: Indian stocks need a registered key
- Requesting **SBIN.NSE** with EODHD's free `demo` token returns **"Forbidden"**. The demo token only covers a few US tickers (AAPL.US, TSLA.US…).
- To pull **SBI (SBIN.NSE)** we need an EODHD API key — a **free account issues one** (limited daily calls), or a paid plan for full access.
- The samples below use **AAPL.US (demo)** to show the **exact structure** you'd get for SBI — the fields are identical; only the symbol and values change.

## What EODHD provides (by data type)

### 1. End-of-day history — the multi-year series
Fields: `date, open, high, low, close, adjusted_close, volume`. (`adjusted_close` is split/dividend-adjusted — important for clean multi-year charts.) Example (AAPL):
```
2026-06-09  open 300.28  high 300.75  low 287.78  close 290.55  volume 70,108,800
2026-06-10  open 290.74  high 294.75  low 287.38  close 291.58  volume 52,793,300
```

### 2. Live / real-time quote
Fields: `code, timestamp, open, high, low, close, volume, previousClose, change, change_p`.

### 3. Fundamentals — rich and nested
Top-level sections returned: **General · Highlights** (MarketCap, P/E, PEG, EBITDA, WallStreetTargetPrice) **· Valuation** (Trailing/Forward P/E, P/S, P/B, EnterpriseValue) **· SharesStats · Technicals** (Beta, 52-week high/low, 50- & 200-day MA) **· SplitsDividends** (dividend rate/yield, payout, ex-date) **· AnalystRatings** (Rating, TargetPrice, Buy/Hold/Sell counts) **· Holders · ESGScores · Earnings** (History/Trend/Annual) **· Financials** (full Balance Sheet, Cash Flow, Income Statement).

### 4. News + built-in sentiment
Fields: `date, title, content, link, symbols, tags, sentiment`. Sentiment is scored (`polarity / neg / neu / pos`) — ready to feed the news-scraping requirement and the model.

## The one gap: delivery data (dad's core metric)
- EODHD's EOD record has **volume but NO delivery quantity / delivery %** (confirmed — no delivery field).
- **Delivery %** → source free from **NSE `sec_bhavdata_full` bhavcopy** (daily + historical archives).
- **F&O / OI** (flagged important) → free from **NSE F&O bhavcopy** (EODHD also has options data on higher tiers).

## Bottom line
EODHD covers **prices + fundamentals + news + sentiment** very well, India included (with a key). Pair it with **free NSE bhavcopy** for **delivery % + F&O/OI**, and the data layer covers everything on dad's list.

## Next step to get a *real* SBI sample
Create a **free EODHD account** (it issues an API key) and share the key with me — or approve a paid plan — and I'll immediately pull **SBIN.NSE** and show the same fields populated with SBI's actual numbers (and a matching NSE delivery-% sample).

# NSE stock-data downloader

`nse_stock_data.py` downloads **daily NSE data for any stock over a date range**
into a CSV — including **OHLC, prev close, last/close, VWAP, volume, turnover,
number of trades, and delivery quantity + delivery %**, plus a computed
day-change % and a 20-day average-volume column.

## Requirements
- **Python 3.8+ only.** No `pip install` needed (uses the standard library).
- Run it from a normal/home internet connection. (NSE blocks data-centre/cloud
  IPs, so it may not work from a server — a personal laptop is ideal.)

## Usage
```bash
# SYMBOL  FROM  TO  [OUTPUT.csv]
python nse_stock_data.py SBIN 2025-06-21 2026-06-20
python nse_stock_data.py RELIANCE 21-06-2025 yesterday
python nse_stock_data.py JSWINFRA 2025-06-21 today  jsw.csv

# no arguments -> it will ask you for symbol + dates
python nse_stock_data.py
```
- Dates accept `YYYY-MM-DD` or `DD-MM-YYYY`. `TO` also accepts `today` / `yesterday`.
- `SYMBOL` is the NSE trading symbol: `SBIN`, `RELIANCE`, `JSWINFRA`, `ITC`, `RECLTD`, `DIXON`, …
- Output file defaults to `SYMBOL_FROM_TO.csv` if you don't name one.

## Output columns
`Date, Day, Series, Prev Close, Open, High, Low, Last, Close, Change %, VWAP,
Volume (shares), Turnover (Rs Lakhs), No. of Trades, Deliverable Qty,
Delivery %, 20D Avg Volume, Volume vs 20D Avg`

## How it gets the data
1. **Fast path** — NSE's historical API (a few small calls for the whole range).
2. **Automatic fallback** — if the API is unavailable, it downloads NSE's daily
   bhavcopy archive for each trading day and extracts your stock.

It only returns trading days (weekends/holidays are skipped automatically).

## Tips
- For a rolling "last 52 weeks", use `... <SYMBOL> 2025-06-22 yesterday`.
- If you get no data, double-check the symbol spelling and that the range
  includes trading days; try again (NSE can be briefly rate-limited).

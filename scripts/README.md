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

---

# NSE F&O (Futures & Options) downloader

`nse_fo_data.py` downloads a **daily Futures & Options summary** for an F&O stock
(or index) over a date range into a CSV.

## Output columns
`Date, Day, Futures Close (near), Fut Price Chg %, Futures OI (total),
Fut OI Chg %, Buildup, Near Expiry, Call OI, Put OI, Total Options OI,
PCR (Put/Call), Call Volume, Put Volume`

That covers all four asks: **(1) futures OI, (2) options OI, (3) put data,
(4) call data** — plus PCR and the **Buildup** label (Long Buildup / Short
Buildup / Long Unwinding / Short Covering), derived from the day's OI change vs
price change, exactly like the broker screenshot.

## Usage
```bash
python nse_fo_data.py SBIN 2026-05-01 yesterday
python nse_fo_data.py RELIANCE 01-05-2026 today reliance_fo.csv
python nse_fo_data.py NIFTY 2026-05-01 yesterday      # indices work too
python nse_fo_data.py                                  # interactive prompts
```
- Same date rules as above (`YYYY-MM-DD` / `DD-MM-YYYY`, `today` / `yesterday`).
- Works for **F&O stocks and indices** (SBIN, RELIANCE, NIFTY, BANKNIFTY, …).
- Uses NSE's UDiFF F&O bhavcopy (available from ~July 2024 onward). Each daily
  file is ~1.4 MB, so long ranges download a fair bit — start with a month or two.

---

# NSE Option Chain (strike-wise Call & Put) downloader

`nse_option_chain.py` gives the **per-strike** Call and Put data (the option
chain) — what the F&O summary above sums up. One row per (Date, Expiry, Strike):

`Date, Expiry, Strike, Call OI, Call Chg OI, Call Volume, Call Close,
Put OI, Put Chg OI, Put Volume, Put Close`

## Usage
```bash
python nse_option_chain.py SBIN 2026-06-17 2026-06-17            # one day, all expiries
python nse_option_chain.py SBIN 2026-06-01 yesterday --near      # nearest expiry only
python nse_option_chain.py SBIN 2026-06-01 today --expiry 2026-06-30
```
- `--near` keeps only the nearest expiry each day; `--expiry YYYY-MM-DD` filters to one expiry.
- **Put any output filename BEFORE the `--near`/`--expiry` flags**, e.g.
  `... SBIN 2026-06-17 2026-06-17 sbin_chain.csv --near`.
- Heads-up on size: all-expiries × every strike × many days gets large quickly —
  use `--near` / `--expiry` or a short range to keep it manageable. In Excel you
  can then filter by Date/Expiry to see the chain for any single day.


#!/usr/bin/env python3
"""
nse_top_gainers.py
==================
Top GAINERS (or losers) on NSE for a given day, ranked by % price change,
with the stock's company name. Computed from NSE's official daily bhavcopy.

Standard library only (Python 3.8+). Run from a normal/home connection.

USAGE
-----
    python nse_top_gainers.py                      # latest trading day, top 25 gainers
    python nse_top_gainers.py 2026-07-10           # a specific date
    python nse_top_gainers.py --top 50             # top 50
    python nse_top_gainers.py --losers             # top losers instead
    python nse_top_gainers.py 10-07-2026 --top 30 --out gainers.csv

Options:
    --top N            how many to list (default 25)
    --losers           rank by biggest fall instead of biggest rise
    --min-turnover L   ignore illiquid stocks below this turnover in Rs LAKHS
                       (default 100 = Rs 1 crore; use 0 to include everything)
    --series S         NSE series (default EQ)

Dates: YYYY-MM-DD or DD-MM-YYYY. No date = most recent available trading day.
"""

import argparse
import csv
import datetime as dt
import io
import sys
import urllib.request
import urllib.error

BHAV = "https://archives.nseindia.com/products/content/sec_bhavdata_full_{ddmmyyyy}.csv"
EQ_LIST = "https://archives.nseindia.com/content/equities/EQUITY_L.csv"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/123.0 Safari/537.36")


def http_get(url, timeout=40):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Referer": "https://www.nseindia.com/"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "ignore")


def parse_date(s):
    s = s.strip().lower()
    if s in ("today", "latest"):
        return dt.date.today()
    if s == "yesterday":
        return dt.date.today() - dt.timedelta(days=1)
    for fmt in ("%Y-%m-%d", "%d-%m-%Y", "%d/%m/%Y", "%d-%b-%Y"):
        try:
            return dt.datetime.strptime(s, fmt).date()
        except ValueError:
            pass
    raise SystemExit("Could not parse date: %s (use YYYY-MM-DD or DD-MM-YYYY)" % s)


def load_names():
    names = {}
    try:
        for r in csv.DictReader(io.StringIO(http_get(EQ_LIST))):
            sym = (r.get("SYMBOL") or "").strip()
            nm = (r.get("NAME OF COMPANY") or "").strip()
            if sym:
                names[sym] = nm
    except Exception:
        pass
    return names


def load_bhav(date):
    return http_get(BHAV.format(ddmmyyyy=date.strftime("%d%m%Y")))


def main():
    ap = argparse.ArgumentParser(description="NSE top gainers/losers for a day, ranked by % price change.")
    ap.add_argument("date", nargs="?", help="Trading date (default: latest available)")
    ap.add_argument("--out", help="Output CSV file (default: nse_gainers_<date>.csv)")
    ap.add_argument("--top", type=int, default=25)
    ap.add_argument("--losers", action="store_true")
    ap.add_argument("--min-turnover", type=float, default=100.0, help="Min turnover in Rs Lakhs (default 100 = Rs 1cr)")
    ap.add_argument("--max-move", type=float, default=25.0,
                    help="Skip |%% move| above this -- filters split/bonus artifacts (default 25; 0 disables)")
    ap.add_argument("--series", default="EQ")
    a = ap.parse_args()

    # Resolve the date (or find the most recent available trading day).
    text = None
    used = None
    if a.date:
        used = parse_date(a.date)
        text = load_bhav(used)
    else:
        d = dt.date.today()
        for _ in range(8):
            if d.weekday() < 5:
                try:
                    t = load_bhav(d)
                    if (",%s," % a.series) in t or (", %s," % a.series) in t:
                        text, used = t, d
                        break
                except urllib.error.HTTPError:
                    pass
                except Exception:
                    pass
            d -= dt.timedelta(days=1)
    if not text:
        print("Could not fetch bhavcopy (no trading data found for the range).", file=sys.stderr)
        sys.exit(1)

    names = load_names()
    rows = []
    for line in text.splitlines():
        p = [c.strip() for c in line.split(",")]
        if len(p) < 15 or p[1] != a.series:
            continue
        try:
            prev, close, turn = float(p[3]), float(p[8]), float(p[11])
            vol, dp = int(float(p[10])), float(p[14])
        except ValueError:
            continue
        if prev <= 0 or turn < a.min_turnover:
            continue
        chg = (close - prev) / prev * 100
        if a.max_move > 0 and abs(chg) > a.max_move:
            continue  # almost certainly a split/bonus/face-value change, not a real move
        rows.append((chg, p[0], close, prev, vol, turn, dp))

    rows.sort(key=lambda x: x[0], reverse=not a.losers)
    top = rows[:a.top]
    label = "LOSERS" if a.losers else "GAINERS"
    print("NSE top %s for %s  (series %s, turnover >= Rs %.0f lakh)\n" % (label, used.isoformat(), a.series, a.min_turnover))
    print("%-4s %-13s %-40s %8s %10s" % ("#", "SYMBOL", "COMPANY", "%CHG", "CLOSE"))
    for i, (chg, sym, close, prev, vol, turn, dp) in enumerate(top, 1):
        print("%-4d %-13s %-40s %+7.2f %10.2f" % (i, sym, names.get(sym, sym)[:38], chg, close))

    out = a.out or "nse_%s_%s.csv" % (label.lower(), used.strftime("%Y%m%d"))
    with open(out, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Rank", "Symbol", "Company", "% Change", "Close", "Prev Close", "Volume", "Turnover (Rs Lakhs)", "Delivery %"])
        for i, (chg, sym, close, prev, vol, turn, dp) in enumerate(top, 1):
            w.writerow([i, sym, names.get(sym, sym), round(chg, 2), close, prev, vol, round(turn, 2), dp])
    print("\nWrote %d rows to %s" % (len(top), out), file=sys.stderr)


if __name__ == "__main__":
    main()

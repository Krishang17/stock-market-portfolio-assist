#!/usr/bin/env python3
"""
nse_stock_data.py
=================
Download daily NSE equity data for ANY stock over a date range, into a CSV --
including OHLC, previous close, last/close, VWAP, total volume, turnover,
number of trades, and DELIVERY quantity + DELIVERY % (plus computed day-change %
and a 20-day average-volume column).

No third-party packages required -- uses only the Python 3 standard library.

USAGE
-----
    python nse_stock_data.py <SYMBOL> <FROM> <TO> [OUTFILE.csv]

    python nse_stock_data.py SBIN 2025-06-21 2026-06-20
    python nse_stock_data.py RELIANCE 21-06-2025 yesterday
    python nse_stock_data.py                       # interactive (prompts you)

Dates accept YYYY-MM-DD or DD-MM-YYYY. <TO> also accepts 'today' / 'yesterday'.
<SYMBOL> is the NSE trading symbol (SBIN, RELIANCE, JSWINFRA, ITC, RECLTD, DIXON, ...).

It tries NSE's fast historical API first (a few small calls); if that's
unavailable it automatically falls back to the per-day bhavcopy archive.
"""

import argparse
import csv
import datetime as dt
import gzip
import json
import sys
import time
import urllib.request
import urllib.error
import http.cookiejar

BASE = "https://www.nseindia.com"
ARCH = "https://archives.nseindia.com/products/content/sec_bhavdata_full_{ddmmyyyy}.csv"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/123.0 Safari/537.36")

_opener = None


def _opener_get():
    global _opener
    if _opener is None:
        cj = http.cookiejar.CookieJar()
        _opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
        _opener.addheaders = [
            ("User-Agent", UA),
            ("Accept", "text/html,application/json,*/*"),
            ("Accept-Language", "en-US,en;q=0.9"),
            ("Connection", "keep-alive"),
        ]
    return _opener


def http_get(url, referer=None, timeout=30):
    req = urllib.request.Request(url)
    if referer:
        req.add_header("Referer", referer)
    with _opener_get().open(req, timeout=timeout) as r:
        data = r.read()
        if r.headers.get("Content-Encoding") == "gzip":
            data = gzip.decompress(data)
    return data


def prime(symbol="SBIN"):
    """Visit NSE pages first so the API hands us the right cookies."""
    try:
        http_get(BASE + "/")
        http_get(BASE + "/get-quotes/equity?symbol=" + symbol, referer=BASE + "/")
    except Exception:
        pass


# ---- numbers / dates --------------------------------------------------------

def _f(x):
    try:
        return float(str(x).replace(",", "").strip())
    except Exception:
        return None


def _i(x):
    try:
        return int(float(str(x).replace(",", "").strip()))
    except Exception:
        return None


def parse_date(s):
    s = s.strip().lower()
    today = dt.date.today()
    if s == "today":
        return today
    if s == "yesterday":
        return today - dt.timedelta(days=1)
    for fmt in ("%Y-%m-%d", "%d-%m-%Y", "%d/%m/%Y", "%d-%b-%Y"):
        try:
            return dt.datetime.strptime(s, fmt).date()
        except ValueError:
            pass
    raise SystemExit("Could not parse date: %s (use YYYY-MM-DD or DD-MM-YYYY)" % s)


# ---- method 1: NSE historical API (fast) ------------------------------------

def fetch_api(symbol, d_from, d_to, series="EQ"):
    rows = {}
    start = d_from
    while start <= d_to:
        end = min(start + dt.timedelta(days=89), d_to)  # NSE limits the window
        url = ("%s/api/historical/securityArchives?from=%s&to=%s&symbol=%s"
               "&dataType=priceVolumeDeliverable&series=%s"
               % (BASE, start.strftime("%d-%m-%Y"), end.strftime("%d-%m-%Y"), symbol, series))
        ref = "%s/get-quotes/equity?symbol=%s" % (BASE, symbol)
        ok = False
        for _ in range(3):
            try:
                j = json.loads(http_get(url, referer=ref).decode("utf-8", "ignore"))
                for it in j.get("data", []):
                    r = _norm_api(it)
                    if r:
                        rows[r["date"]] = r
                ok = True
                break
            except Exception:
                prime(symbol)
                time.sleep(1.5)
        if not ok:
            raise RuntimeError("NSE API unavailable")
        start = end + dt.timedelta(days=1)
        time.sleep(0.6)
    return rows


def _norm_api(it):
    raw = it.get("CH_TIMESTAMP") or it.get("mTIMESTAMP") or it.get("TIMESTAMP")
    if not raw:
        return None
    d = None
    for fmt in ("%Y-%m-%d", "%d-%b-%Y"):
        try:
            d = dt.datetime.strptime(raw[:10] if fmt == "%Y-%m-%d" else raw, fmt).date()
            break
        except Exception:
            pass
    if d is None:
        return None
    turn = _f(it.get("CH_TOT_TRADED_VAL"))
    return dict(
        date=d, series=it.get("CH_SERIES", "EQ"),
        prev=_f(it.get("CH_PREVIOUS_CLS_PRICE")), open=_f(it.get("CH_OPENING_PRICE")),
        high=_f(it.get("CH_TRADE_HIGH_PRICE")), low=_f(it.get("CH_TRADE_LOW_PRICE")),
        last=_f(it.get("CH_LAST_TRADED_PRICE")), close=_f(it.get("CH_CLOSING_PRICE")),
        vwap=_f(it.get("VWAP")), volume=_i(it.get("CH_TOT_TRADED_QTY")),
        turnover_lakhs=(turn / 1e5 if turn is not None else None),
        trades=_i(it.get("CH_TOTAL_TRADES")),
        deliv_qty=_i(it.get("COP_DELIV_QTY", it.get("DELIV_QTY"))),
        deliv_pct=_f(it.get("COP_DELIV_PERC", it.get("DELIV_PER"))),
    )


# ---- method 2: per-day bhavcopy archive (robust fallback) -------------------

def fetch_bhavcopy(symbol, d_from, d_to, series="EQ", sleep=0.3):
    rows = {}
    d = d_from
    total = (d_to - d_from).days + 1
    done = 0
    while d <= d_to:
        done += 1
        if d.weekday() < 5:  # skip weekends
            url = ARCH.format(ddmmyyyy=d.strftime("%d%m%Y"))
            for _ in range(3):
                try:
                    text = http_get(url, referer=BASE + "/").decode("utf-8", "ignore")
                    row = _find_bhav_row(text, symbol, series)
                    if row:
                        rows[row["date"]] = row
                    break
                except urllib.error.HTTPError as e:
                    if e.code == 404:
                        break  # market holiday / no file that day
                    time.sleep(1.0)
                except Exception:
                    time.sleep(1.0)
            time.sleep(sleep)
        if done % 20 == 0:
            print("  ...%d/%d days scanned, %d found" % (done, total, len(rows)), file=sys.stderr)
        d += dt.timedelta(days=1)
    return rows


def _find_bhav_row(text, symbol, series):
    for line in text.splitlines():
        p = [c.strip() for c in line.split(",")]
        # SYMBOL,SERIES,DATE1,PREV_CLOSE,OPEN,HIGH,LOW,LAST,CLOSE,AVG,TTL_QTY,
        # TURNOVER_LACS,NO_OF_TRADES,DELIV_QTY,DELIV_PER
        if len(p) >= 15 and p[0] == symbol and p[1] == series:
            try:
                d = dt.datetime.strptime(p[2], "%d-%b-%Y").date()
            except Exception:
                return None
            return dict(
                date=d, series=p[1], prev=_f(p[3]), open=_f(p[4]), high=_f(p[5]),
                low=_f(p[6]), last=_f(p[7]), close=_f(p[8]), vwap=_f(p[9]),
                volume=_i(p[10]), turnover_lakhs=_f(p[11]), trades=_i(p[12]),
                deliv_qty=_i(p[13]), deliv_pct=_f(p[14]),
            )
    return None


# ---- output -----------------------------------------------------------------

def write_csv(rows, outfile):
    data = [rows[d] for d in sorted(rows)]
    vols = [r["volume"] or 0 for r in data]
    with open(outfile, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow([
            "Date", "Day", "Series", "Prev Close", "Open", "High", "Low", "Last",
            "Close", "Change %", "VWAP", "Volume (shares)", "Turnover (Rs Lakhs)",
            "No. of Trades", "Deliverable Qty", "Delivery %",
            "20D Avg Volume", "Volume vs 20D Avg",
        ])
        for i, r in enumerate(data):
            win = vols[max(0, i - 19):i + 1]
            a20 = sum(win) / len(win) if win else 0
            chg = ((r["close"] - r["prev"]) / r["prev"] * 100) if (r["close"] and r["prev"]) else None
            w.writerow([
                r["date"].isoformat(), r["date"].strftime("%a"), r["series"],
                r["prev"], r["open"], r["high"], r["low"], r["last"], r["close"],
                round(chg, 2) if chg is not None else "", r["vwap"], r["volume"],
                round(r["turnover_lakhs"], 2) if r["turnover_lakhs"] is not None else "",
                r["trades"], r["deliv_qty"], r["deliv_pct"],
                round(a20) if a20 else "", round((r["volume"] or 0) / a20, 2) if a20 else "",
            ])
    return len(data)


def main():
    ap = argparse.ArgumentParser(description="Download NSE daily OHLC + volume + delivery data to CSV.")
    ap.add_argument("symbol", nargs="?", help="NSE symbol, e.g. SBIN")
    ap.add_argument("date_from", nargs="?", help="From date (YYYY-MM-DD or DD-MM-YYYY)")
    ap.add_argument("date_to", nargs="?", help="To date (or 'today' / 'yesterday')")
    ap.add_argument("outfile", nargs="?", help="Output CSV (default: <SYMBOL>_<from>_<to>.csv)")
    ap.add_argument("--series", default="EQ", help="Series (default EQ)")
    ap.add_argument("--method", choices=["auto", "api", "bhavcopy"], default="auto")
    a = ap.parse_args()

    symbol = (a.symbol or input("NSE symbol (e.g. SBIN): ")).strip().upper()
    d_from = parse_date(a.date_from or input("From date (YYYY-MM-DD): "))
    d_to = parse_date(a.date_to or input("To date (YYYY-MM-DD / today / yesterday): "))
    if d_to < d_from:
        d_from, d_to = d_to, d_from
    out = a.outfile or "%s_%s_%s.csv" % (symbol, d_from.strftime("%Y%m%d"), d_to.strftime("%Y%m%d"))

    print("Fetching %s (%s)  %s -> %s ..." % (symbol, a.series, d_from, d_to), file=sys.stderr)
    prime(symbol)

    rows = {}
    if a.method in ("auto", "api"):
        try:
            rows = fetch_api(symbol, d_from, d_to, a.series)
            good = sum(1 for r in rows.values() if r["close"] and r["volume"])
            if not rows or good < max(1, 0.5 * len(rows)):
                if a.method == "auto":
                    print("  API returned little/no usable data; using bhavcopy...", file=sys.stderr)
                    rows = {}
        except Exception as e:
            if a.method == "api":
                raise
            print("  API unavailable (%s); falling back to bhavcopy..." % e, file=sys.stderr)
            rows = {}
    if not rows and a.method in ("auto", "bhavcopy"):
        rows = fetch_bhavcopy(symbol, d_from, d_to, a.series)

    if not rows:
        print("No data found. Check the symbol/date range "
              "(NSE only has data for trading days).", file=sys.stderr)
        sys.exit(1)
    n = write_csv(rows, out)
    print("Wrote %d trading days to %s" % (n, out), file=sys.stderr)
    print(out)


if __name__ == "__main__":
    main()

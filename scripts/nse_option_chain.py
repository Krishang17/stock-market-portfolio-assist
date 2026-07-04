#!/usr/bin/env python3
"""
nse_option_chain.py
===================
Strike-wise CALL & PUT option data (the "option chain") for an NSE F&O symbol
over a date range -> CSV. One row per (Date, Expiry, Strike), with the Call side
and the Put side next to each other -- exactly like a broker's option chain, but
covering a whole date range.

Columns:
  Date, Expiry, Strike,
  Call OI, Call Chg OI, Call Volume, Call Close,
  Put OI,  Put Chg OI,  Put Volume,  Put Close

Standard library only (Python 3.8+). Run from a normal/home connection.

USAGE
-----
    python nse_option_chain.py <SYMBOL> <FROM> <TO> [OUTFILE.csv]
    python nse_option_chain.py SBIN 2026-06-17 2026-06-17              # one day, all expiries
    python nse_option_chain.py SBIN 2026-06-01 yesterday --near        # only nearest expiry
    python nse_option_chain.py SBIN 2026-06-01 today --expiry 2026-06-30
    python nse_option_chain.py                                          # interactive

Dates: YYYY-MM-DD or DD-MM-YYYY; TO also accepts 'today'/'yesterday'.
Tip: 'all expiries x every strike x many days' gets big fast -- use --near
or --expiry, or a short date range, to keep the file manageable.
Uses NSE's UDiFF F&O bhavcopy (available from ~July 2024 onward).
"""

import argparse
import csv
import datetime as dt
import io
import sys
import time
import zipfile
import urllib.request
import urllib.error

FO_URL = "https://nsearchives.nseindia.com/content/fo/BhavCopy_NSE_FO_0_0_0_{ymd}_F_0000.csv.zip"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/123.0 Safari/537.36")
OPT_TYPES = {"STO", "IDO", "OPTSTK", "OPTIDX"}


def http_get(url, timeout=40):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Referer": "https://www.nseindia.com/"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


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


def day_chain(symbol, zbytes, expiry_filter=None, near_only=False):
    """Return list of per-strike rows (call+put merged) for one day."""
    z = zipfile.ZipFile(io.BytesIO(zbytes))
    text = z.read(z.namelist()[0]).decode("utf-8", "ignore")
    recs = {}          # (expiry, strike) -> row dict
    expiries = set()
    for r in csv.DictReader(io.StringIO(text)):
        if r.get("TckrSymb", "").strip() != symbol:
            continue
        if r.get("FinInstrmTp", "").strip() not in OPT_TYPES:
            continue
        exp = r.get("XpryDt", "").strip()
        ot = r.get("OptnTp", "").strip()
        strike = _f(r.get("StrkPric"))
        if strike is None:
            continue
        expiries.add(exp)
        row = recs.setdefault((exp, strike), dict(
            exp=exp, strike=strike,
            call_oi="", call_coi="", call_vol="", call_cls="",
            put_oi="", put_coi="", put_vol="", put_cls="",
        ))
        oi, coi, vol, cls = _i(r.get("OpnIntrst")), _i(r.get("ChngInOpnIntrst")), _i(r.get("TtlTradgVol")), _f(r.get("ClsPric"))
        if ot == "CE":
            row.update(call_oi=oi, call_coi=coi, call_vol=vol, call_cls=cls)
        elif ot == "PE":
            row.update(put_oi=oi, put_coi=coi, put_vol=vol, put_cls=cls)
    if near_only and expiries:
        keep = min(expiries)
        recs = {k: v for k, v in recs.items() if v["exp"] == keep}
    if expiry_filter:
        recs = {k: v for k, v in recs.items() if v["exp"] == expiry_filter}
    return sorted(recs.values(), key=lambda x: (x["exp"], x["strike"]))


def main():
    ap = argparse.ArgumentParser(description="Download strike-wise NSE option-chain (call+put OI/volume) to CSV.")
    ap.add_argument("symbol", nargs="?")
    ap.add_argument("date_from", nargs="?")
    ap.add_argument("date_to", nargs="?")
    ap.add_argument("outfile", nargs="?")
    ap.add_argument("--expiry", help="Only this expiry (YYYY-MM-DD)")
    ap.add_argument("--near", action="store_true", help="Only the nearest expiry each day")
    ap.add_argument("--sleep", type=float, default=0.3)
    a = ap.parse_args()

    symbol = (a.symbol or input("NSE symbol (e.g. SBIN): ")).strip().upper()
    d_from = parse_date(a.date_from or input("From date (YYYY-MM-DD): "))
    d_to = parse_date(a.date_to or input("To date (YYYY-MM-DD / today / yesterday): "))
    if d_to < d_from:
        d_from, d_to = d_to, d_from
    exp_filter = a.expiry
    if exp_filter:
        exp_filter = parse_date(exp_filter).isoformat()
    out = a.outfile or "%s_OPTCHAIN_%s_%s.csv" % (symbol, d_from.strftime("%Y%m%d"), d_to.strftime("%Y%m%d"))

    print("Fetching option chain for %s  %s -> %s ..." % (symbol, d_from, d_to), file=sys.stderr)
    with open(out, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow([
            "Date", "Expiry", "Strike",
            "Call OI", "Call Chg OI", "Call Volume", "Call Close",
            "Put OI", "Put Chg OI", "Put Volume", "Put Close",
        ])
        d = d_from
        total = (d_to - d_from).days + 1
        done = 0
        written = 0
        while d <= d_to:
            done += 1
            if d.weekday() < 5:
                url = FO_URL.format(ymd=d.strftime("%Y%m%d"))
                rows = None
                for _ in range(3):
                    try:
                        rows = day_chain(symbol, http_get(url), exp_filter, a.near)
                        break
                    except urllib.error.HTTPError as e:
                        if e.code == 404:
                            rows = []
                            break
                        time.sleep(1.0)
                    except Exception:
                        time.sleep(1.0)
                for r in (rows or []):
                    w.writerow([
                        d.isoformat(), r["exp"], r["strike"],
                        r["call_oi"], r["call_coi"], r["call_vol"], r["call_cls"],
                        r["put_oi"], r["put_coi"], r["put_vol"], r["put_cls"],
                    ])
                    written += 1
                time.sleep(a.sleep)
            if done % 20 == 0:
                print("  ...%d/%d days, %d rows" % (done, total, written), file=sys.stderr)
            d += dt.timedelta(days=1)

    if written == 0:
        print("No option data found (check symbol is an F&O stock / date range / expiry).", file=sys.stderr)
        sys.exit(1)
    print("Wrote %d strike-rows to %s" % (written, out), file=sys.stderr)
    print(out)


if __name__ == "__main__":
    main()

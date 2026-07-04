#!/usr/bin/env python3
"""
nse_fo_data.py
==============
Daily F&O (Futures & Options) summary for an NSE symbol over a date range -> CSV.

For each trading day it reports:
  - FUTURES: near-month close, day price-change %, TOTAL futures Open Interest
    (all expiries), day OI-change %, and the BUILD-UP label
    (Long Buildup / Short Buildup / Long Unwinding / Short Covering).
  - OPTIONS: total Call OI, total Put OI, total Options OI, PCR (Put/Call ratio),
    and Call/Put traded volumes.

Standard library only -- no pip installs needed (Python 3.8+).

USAGE
-----
    python nse_fo_data.py <SYMBOL> <FROM> <TO> [OUTFILE.csv]
    python nse_fo_data.py SBIN 2026-05-01 yesterday
    python nse_fo_data.py RELIANCE 01-05-2026 today reliance_fo.csv
    python nse_fo_data.py                       # interactive prompts

Dates: YYYY-MM-DD or DD-MM-YYYY; TO also accepts 'today'/'yesterday'.
SYMBOL is the NSE symbol (SBIN, RELIANCE, JSWINFRA, ...) or an index (NIFTY, BANKNIFTY).
Note: uses NSE's UDiFF F&O bhavcopy (available from ~July 2024 onward).
Run it from a normal/home connection (NSE blocks data-centre IPs).
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

FUT_TYPES = {"STF", "IDF", "FUTSTK", "FUTIDX"}
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
        return 0


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


def day_summary(symbol, zbytes):
    """Aggregate one day's F&O bhavcopy for `symbol`."""
    z = zipfile.ZipFile(io.BytesIO(zbytes))
    text = z.read(z.namelist()[0]).decode("utf-8", "ignore")
    fut = []  # (expiry, oi, close)
    call_oi = put_oi = opt_oi = call_vol = put_vol = 0
    for r in csv.DictReader(io.StringIO(text)):
        if r.get("TckrSymb", "").strip() != symbol:
            continue
        tp = r.get("FinInstrmTp", "").strip()
        oi = _i(r.get("OpnIntrst"))
        if tp in FUT_TYPES:
            fut.append((r.get("XpryDt", "").strip(), oi, _f(r.get("ClsPric"))))
        elif tp in OPT_TYPES:
            opt_oi += oi
            ot = r.get("OptnTp", "").strip()
            vol = _i(r.get("TtlTradgVol"))
            if ot == "CE":
                call_oi += oi
                call_vol += vol
            elif ot == "PE":
                put_oi += oi
                put_vol += vol
    if not fut and opt_oi == 0:
        return None
    fut.sort(key=lambda x: x[0])  # nearest expiry first
    near = fut[0] if fut else ("", 0, None)
    return dict(
        near_expiry=near[0], fut_close=near[2],
        fut_oi_total=sum(x[1] for x in fut),
        call_oi=call_oi, put_oi=put_oi, opt_oi=opt_oi,
        pcr=(put_oi / call_oi if call_oi else None),
        call_vol=call_vol, put_vol=put_vol,
    )


def buildup(dprice, doi):
    if dprice is None or doi is None:
        return ""
    if doi > 0 and dprice > 0:
        return "Long Buildup"
    if doi > 0 and dprice < 0:
        return "Short Buildup"
    if doi < 0 and dprice < 0:
        return "Long Unwinding"
    if doi < 0 and dprice > 0:
        return "Short Covering"
    return "Neutral"


def main():
    ap = argparse.ArgumentParser(description="Download NSE daily F&O (futures+options OI, put/call, PCR, buildup) to CSV.")
    ap.add_argument("symbol", nargs="?")
    ap.add_argument("date_from", nargs="?")
    ap.add_argument("date_to", nargs="?")
    ap.add_argument("outfile", nargs="?")
    ap.add_argument("--sleep", type=float, default=0.3)
    a = ap.parse_args()

    symbol = (a.symbol or input("NSE symbol (e.g. SBIN): ")).strip().upper()
    d_from = parse_date(a.date_from or input("From date (YYYY-MM-DD): "))
    d_to = parse_date(a.date_to or input("To date (YYYY-MM-DD / today / yesterday): "))
    if d_to < d_from:
        d_from, d_to = d_to, d_from
    out = a.outfile or "%s_FO_%s_%s.csv" % (symbol, d_from.strftime("%Y%m%d"), d_to.strftime("%Y%m%d"))

    print("Fetching F&O for %s  %s -> %s ..." % (symbol, d_from, d_to), file=sys.stderr)
    days = {}
    d = d_from
    total = (d_to - d_from).days + 1
    done = 0
    while d <= d_to:
        done += 1
        if d.weekday() < 5:
            url = FO_URL.format(ymd=d.strftime("%Y%m%d"))
            for _ in range(3):
                try:
                    days[d] = day_summary(symbol, http_get(url))
                    break
                except urllib.error.HTTPError as e:
                    if e.code == 404:
                        break  # holiday / no file
                    time.sleep(1.0)
                except Exception:
                    time.sleep(1.0)
            time.sleep(a.sleep)
        if done % 20 == 0:
            print("  ...%d/%d days, %d with data" % (done, total, sum(1 for v in days.values() if v)), file=sys.stderr)
        d += dt.timedelta(days=1)

    ordered = [(dd, days[dd]) for dd in sorted(days) if days[dd]]
    if not ordered:
        print("No F&O data found (check symbol / that it's an F&O stock / date range).", file=sys.stderr)
        sys.exit(1)

    with open(out, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow([
            "Date", "Day", "Futures Close (near)", "Fut Price Chg %",
            "Futures OI (total)", "Fut OI Chg %", "Buildup", "Near Expiry",
            "Call OI", "Put OI", "Total Options OI", "PCR (Put/Call)",
            "Call Volume", "Put Volume",
        ])
        prev = None
        for dd, s in ordered:
            dprice = doi = None
            if prev:
                if prev["fut_close"] and s["fut_close"]:
                    dprice = (s["fut_close"] - prev["fut_close"]) / prev["fut_close"] * 100
                if prev["fut_oi_total"]:
                    doi = (s["fut_oi_total"] - prev["fut_oi_total"]) / prev["fut_oi_total"] * 100
            w.writerow([
                dd.isoformat(), dd.strftime("%a"), s["fut_close"],
                round(dprice, 2) if dprice is not None else "",
                s["fut_oi_total"], round(doi, 2) if doi is not None else "",
                buildup(dprice, doi), s["near_expiry"],
                s["call_oi"], s["put_oi"], s["opt_oi"],
                round(s["pcr"], 3) if s["pcr"] is not None else "",
                s["call_vol"], s["put_vol"],
            ])
            prev = s
    print("Wrote %d trading days to %s" % (len(ordered), out), file=sys.stderr)
    print(out)


if __name__ == "__main__":
    main()

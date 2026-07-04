#!/usr/bin/env python3
"""
nse_fo_daily.py
===============
One row PER DAY combining, for an NSE F&O symbol:

  FUTURES : near-month close, day price-change %, total futures Open Interest,
            day OI-change %, and the Buildup label.
  TOP CALL: the call strike with the biggest OI %-change that day (among strikes
            that actually traded), with its OI, OI %-change and volume.
  TOP PUT : the put strike with the biggest OI %-change that day (among strikes
            that actually traded), with its OI, OI %-change and volume.

Options are taken from the NEAREST expiry by default (use --expiry to fix one).

Standard library only (Python 3.8+). Run from a normal/home connection.

USAGE
-----
    python nse_fo_daily.py <SYMBOL> <FROM> <TO> [OUTFILE.csv]
    python nse_fo_daily.py SBIN 2026-06-01 yesterday
    python nse_fo_daily.py RELIANCE 01-05-2026 today  reliance_fo_daily.csv  --rank combined
    python nse_fo_daily.py                             # interactive prompts

Selecting the "top" strike (--rank):
    combined  (default) highest OI %-change among the more actively-traded
              strikes (volume >= that day's median) -- i.e. high OI% change AND
              high volume, which avoids thin far-out-of-the-money noise.
    oichg     highest OI %-change among all strikes that traded
    volume    the strike with the highest volume
Put any OUTFILE name BEFORE the --rank/--expiry flags.

Dates: YYYY-MM-DD or DD-MM-YYYY; TO also accepts 'today'/'yesterday'.
Uses NSE's UDiFF F&O bhavcopy (available from ~July 2024 onward).
"""

import argparse
import csv
import datetime as dt
import io
import statistics
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


def pick_strike(strikes, rank):
    """strikes: list of dicts with strike, oi, chg, vol. Return the chosen one."""
    # OI %-change vs the previous day's OI (prior = today's OI - change).
    cands = []
    for s in strikes:
        vol = s["vol"] or 0
        if vol <= 0:
            continue
        prior = (s["oi"] or 0) - (s["chg"] or 0)
        if prior <= 0:
            continue  # brand-new strike -> % is undefined/noisy; skip
        s = dict(s, oichg=(s["chg"] / prior * 100.0))
        cands.append(s)
    if not cands:
        return None
    if rank == "volume":
        return max(cands, key=lambda s: s["vol"])
    if rank == "combined":
        med = statistics.median([s["vol"] for s in cands])
        liquid = [s for s in cands if s["vol"] >= med] or cands
        return max(liquid, key=lambda s: s["oichg"])
    return max(cands, key=lambda s: s["oichg"])  # 'oichg' default (biggest buildup)


def day_analyze(symbol, zbytes, expiry_filter, rank):
    z = zipfile.ZipFile(io.BytesIO(zbytes))
    text = z.read(z.namelist()[0]).decode("utf-8", "ignore")
    fut = []                # (expiry, oi, close)
    calls, puts = {}, {}    # expiry -> list of strike dicts
    for r in csv.DictReader(io.StringIO(text)):
        if r.get("TckrSymb", "").strip() != symbol:
            continue
        tp = r.get("FinInstrmTp", "").strip()
        if tp in FUT_TYPES:
            fut.append((r.get("XpryDt", "").strip(), _i(r.get("OpnIntrst")) or 0, _f(r.get("ClsPric"))))
        elif tp in OPT_TYPES:
            exp = r.get("XpryDt", "").strip()
            rec = dict(strike=_f(r.get("StrkPric")), oi=_i(r.get("OpnIntrst")),
                       chg=_i(r.get("ChngInOpnIntrst")), vol=_i(r.get("TtlTradgVol")))
            (calls if r.get("OptnTp", "").strip() == "CE" else puts).setdefault(exp, []).append(rec)
    if not fut and not calls and not puts:
        return None
    fut.sort(key=lambda x: x[0])
    near_fut = fut[0] if fut else ("", 0, None)
    opt_expiries = sorted(set(list(calls) + list(puts)))
    exp = expiry_filter or (opt_expiries[0] if opt_expiries else "")
    top_call = pick_strike(calls.get(exp, []), rank)
    top_put = pick_strike(puts.get(exp, []), rank)
    return dict(
        fut_oi_total=sum(x[1] for x in fut), fut_close=near_fut[2],
        opt_expiry=exp, top_call=top_call, top_put=top_put,
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
    ap = argparse.ArgumentParser(description="Daily F&O row: futures + top call strike + top put strike -> CSV.")
    ap.add_argument("symbol", nargs="?")
    ap.add_argument("date_from", nargs="?")
    ap.add_argument("date_to", nargs="?")
    ap.add_argument("outfile", nargs="?")
    ap.add_argument("--rank", choices=["combined", "oichg", "volume"], default="combined")
    ap.add_argument("--expiry", help="Fix the option expiry (YYYY-MM-DD); default = nearest each day")
    ap.add_argument("--sleep", type=float, default=0.3)
    a = ap.parse_args()

    symbol = (a.symbol or input("NSE symbol (e.g. SBIN): ")).strip().upper()
    d_from = parse_date(a.date_from or input("From date (YYYY-MM-DD): "))
    d_to = parse_date(a.date_to or input("To date (YYYY-MM-DD / today / yesterday): "))
    if d_to < d_from:
        d_from, d_to = d_to, d_from
    exp_filter = parse_date(a.expiry).isoformat() if a.expiry else None
    out = a.outfile or "%s_FO_DAILY_%s_%s.csv" % (symbol, d_from.strftime("%Y%m%d"), d_to.strftime("%Y%m%d"))

    print("Fetching daily F&O for %s  %s -> %s  (rank=%s) ..." % (symbol, d_from, d_to, a.rank), file=sys.stderr)
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
                    days[d] = day_analyze(symbol, http_get(url), exp_filter, a.rank)
                    break
                except urllib.error.HTTPError as e:
                    if e.code == 404:
                        break
                    time.sleep(1.0)
                except Exception:
                    time.sleep(1.0)
            time.sleep(a.sleep)
        if done % 20 == 0:
            print("  ...%d/%d days" % (done, total), file=sys.stderr)
        d += dt.timedelta(days=1)

    ordered = [(dd, days[dd]) for dd in sorted(days) if days.get(dd)]
    if not ordered:
        print("No F&O data found (check symbol is an F&O stock / date range).", file=sys.stderr)
        sys.exit(1)

    def strike_cells(s):
        if not s:
            return ["", "", "", ""]
        return [s["strike"], s["oi"], round(s["oichg"], 2), s["vol"]]

    with open(out, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow([
            "Date", "Day", "Futures Close", "Fut Price Chg %", "Futures OI",
            "Fut OI Chg %", "Buildup", "Opt Expiry",
            "Top Call Strike", "Call OI", "Call OI Chg %", "Call Volume",
            "Top Put Strike", "Put OI", "Put OI Chg %", "Put Volume",
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
                buildup(dprice, doi), s["opt_expiry"],
            ] + strike_cells(s["top_call"]) + strike_cells(s["top_put"]))
            prev = s
    print("Wrote %d trading days to %s" % (len(ordered), out), file=sys.stderr)
    print(out)


if __name__ == "__main__":
    main()

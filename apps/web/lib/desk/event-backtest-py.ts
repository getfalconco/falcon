/**
 * Falcon's event-backtest helper (Python), uploaded into the test's sandbox by
 * the `event_backtest` tool (lib/desk/event-backtest-run.ts) next to a short
 * generated script that declares the rules (eventScript below). The model
 * writes no backtest code for an event test: the rules are parameters, the
 * code is this file, and the same rules always give the same numbers (stable
 * sort orders, explicit tie-breaks, random comparison picks derived from the
 * rules' hash). Tested in lib/desk/event-backtest.test.ts.
 *
 * The generated script exposes run(costs_bps, lag_days, seed, random_picks)
 * like any Desk test script, so audit_run's harness (lib/desk/audit-harness.ts)
 * re-runs it with doubled costs, a one-day delay and random picks unchanged.
 * Its last line is a checksum of the rest, so the audit can tell Falcon's
 * script from an edited one (isCanonicalEventScript).
 */

import { createHash } from "node:crypto";
import type { EventRules } from "./event-spec";

/** Bump when the helper's rules or output change. */
export const EVENT_HELPER_VERSION = 1;
/** The module name the generated script imports. */
export const EVENT_HELPER_MODULE = "falcon_event_backtest";
/** Where the sandbox keeps the helper and the generated scripts. */
export const EVENT_DIR = "/tmp/falcon_event";

export const EVENT_HELPER_PY = String.raw`# falcon_event_backtest.py: Falcon's event-backtest helper. Falcon's own, unit-tested code
# (source: apps/web/lib/desk/event-backtest-py.ts). Do not edit: the audit trusts this file.
#
# One event test from a declared rule spec, fully deterministic: stable sort orders, explicit
# tie-breaks, no unseeded randomness (random comparison picks are derived from the spec hash).
#
#   data = load_data(events_csv, prices_csv, rules)
#   result = run(data, rules, costs_bps=None, lag_days=1, seed=None, random_picks=False)
#
# Timing (no look-ahead): an event's d0 is its event_date, the first session whose close comes
# after the filing (8-K accepted before 4:00 pm ET on a trading day: that day; later: the next
# trading day). A filter on a d0 return is known at d0's close, one on d1 or d0_d1 at d1's close
# (the signal day). The entry is lag_days trading days after the signal day, at that day's open
# (next_open) or close (next_close). A row whose filing time falls after the signal day's close
# is skipped ("timing"). The position is held hold_days trading days and sold at the close of
# the last one (with a next_open entry the entry day counts as day 1).
import bisect, datetime, glob, hashlib, json, math, os, shutil, sys

HELPER_VERSION = __VERSION__
CAVEAT_FLAGS = ("cik_mismatch", "price_source_disagree")
EVENT_KINDS = ("earnings", "preliminary", "operational_update", "other")
MEASURES = ("stock_return_d0", "abnormal_return_d0", "stock_return_d1", "abnormal_return_d1", "stock_return_d0_d1", "abnormal_return_d0_d1")
SKIP_REASONS = ("duplicate", "timing", "no_price_data", "after_end", "no_entry_price", "already_held", "max_positions", "no_cash")
DEFAULTS = {
    "version": 1,
    "event_kinds": ["earnings"],
    "measure": "stock_return_d0",
    "direction": "up",
    "threshold": None,
    "since": None,
    "until": None,
    "exclude_flags": [],
    "tickers": None,
    "sector_etf": None,
    "entry": "next_open",
    "hold_days": None,
    "max_positions": 20,
    "costs_bps": 5.0,
    "benchmark": "SPY",
}


def canonical(obj):
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False)


def normalize_rules(spec):
    """The rule spec with defaults filled in and every field checked (raises ValueError)."""
    s = dict(spec or {})
    unknown = sorted(k for k in s if k not in DEFAULTS and k not in ("hash",))
    if unknown:
        raise ValueError("Unknown rule fields: " + ", ".join(unknown))
    r = {}
    for k in DEFAULTS:
        v = s.get(k, DEFAULTS[k])
        r[k] = list(v) if isinstance(v, (list, tuple)) else v
    r["version"] = 1
    kinds = r["event_kinds"] or ["earnings"]
    if any(k not in EVENT_KINDS for k in kinds):
        raise ValueError("event_kinds must be from " + ", ".join(EVENT_KINDS))
    r["event_kinds"] = [k for k in EVENT_KINDS if k in kinds]
    if r["measure"] not in MEASURES:
        raise ValueError("measure must be one of " + ", ".join(MEASURES))
    if r["direction"] not in ("up", "down", "both"):
        raise ValueError("direction must be up, down or both")
    if r["threshold"] is None or not (float(r["threshold"]) >= 0):
        raise ValueError("threshold is required (a decimal, 0.1 = 10%)")
    r["threshold"] = round(float(r["threshold"]), 6)
    if not r["since"]:
        raise ValueError("since is required (YYYY-MM-DD)")
    r["since"] = str(r["since"])[:10]
    r["until"] = str(r["until"])[:10] if r["until"] else None
    r["exclude_flags"] = sorted(set(str(f) for f in (r["exclude_flags"] or [])))
    r["tickers"] = sorted(set(str(t).upper().replace(".", "-") for t in r["tickers"])) if r["tickers"] else None
    r["sector_etf"] = str(r["sector_etf"]).upper() if r["sector_etf"] else None
    if r["entry"] not in ("next_open", "next_close"):
        raise ValueError("entry must be next_open or next_close")
    if r["hold_days"] is None or int(r["hold_days"]) != float(r["hold_days"]) or int(r["hold_days"]) < 1:
        raise ValueError("hold_days must be a whole number of trading days, 1 or more")
    r["hold_days"] = int(r["hold_days"])
    if int(r["max_positions"]) != float(r["max_positions"]) or int(r["max_positions"]) < 1:
        raise ValueError("max_positions must be a whole number, 1 or more")
    r["max_positions"] = int(r["max_positions"])
    r["costs_bps"] = float(r["costs_bps"])
    if not (r["costs_bps"] >= 0):
        raise ValueError("costs_bps must be 0 or more")
    r["benchmark"] = str(r["benchmark"] or "SPY").upper().replace(".", "-")
    return r


def spec_hash(rules):
    return hashlib.sha256(canonical(normalize_rules(rules)).encode("utf-8")).hexdigest()[:16]


def find_input(name):
    """A file uploaded into the sandbox (/files/input/<id>/name, $INPUT_DIR), or next to the script."""
    cands = []
    if os.environ.get("INPUT_DIR"):
        cands.append(os.path.join(os.environ["INPUT_DIR"], name))
    cands += sorted(glob.glob("/files/input/*/" + name))
    cands += [os.path.join(os.getcwd(), name), os.path.join(os.path.dirname(os.path.abspath(__file__)), name), name]
    for c in cands:
        if os.path.isfile(c):
            return c
    raise FileNotFoundError("Input file not found in the sandbox: " + name)


def _nth_sunday(y, m, n):
    d = datetime.date(y, m, 1)
    return d + datetime.timedelta(days=(6 - d.weekday()) % 7 + 7 * (n - 1))


def ny_parts(utc_iso):
    """'2024-02-21T21:05:00Z' -> ('2024-02-21', minutes after midnight in New York). US DST rules since 2007."""
    s = str(utc_iso).strip().replace("Z", "+00:00")
    t = datetime.datetime.fromisoformat(s)
    if t.tzinfo is not None:
        t = t.astimezone(datetime.timezone.utc).replace(tzinfo=None)
    y = t.year
    dst_on = datetime.datetime.combine(_nth_sunday(y, 3, 2), datetime.time(7, 0))
    dst_off = datetime.datetime.combine(_nth_sunday(y, 11, 1), datetime.time(6, 0))
    local = t - datetime.timedelta(hours=4 if dst_on <= t < dst_off else 5)
    return local.date().isoformat(), local.hour * 60 + local.minute


def _num(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _passes(v, r):
    thr = r["threshold"]
    if r["direction"] == "up":
        return v > thr
    if r["direction"] == "down":
        return v < -thr
    return abs(v) > thr


def load_data(events_path, prices_path, rules):
    """Reads both files once and applies the event filter (everything that does not depend on run()'s arguments)."""
    import numpy as np
    import pandas as pd

    r = normalize_rules(rules)
    ev = pd.read_csv(events_path, dtype=str, keep_default_na=False, na_filter=False)
    for c in ("ticker", "event_date", r["measure"]):
        if c not in ev.columns:
            raise ValueError("The events file has no " + c + " column; load it again with load_events.")
    px = pd.read_csv(prices_path, dtype={"date": str, "ticker": str}, keep_default_na=False, na_values=[""])
    if "close" not in px.columns:
        raise ValueError("The prices file has no close column.")
    if r["entry"] == "next_open" and "open" not in px.columns:
        raise ValueError("The prices file has no open column; call load_prices with fields [\"open\", \"close\"].")
    bench = r["benchmark"]
    b = px[(px["ticker"] == bench) & px["close"].notna() & (px["close"] > 0)]
    if not len(b):
        raise ValueError("The benchmark " + bench + " is not in the prices file.")
    cal = sorted(set(b["date"].tolist()))
    pos = {d: i for i, d in enumerate(cal)}
    s_idx = bisect.bisect_left(cal, r["since"])
    e_idx = (bisect.bisect_right(cal, r["until"]) - 1) if r["until"] else len(cal) - 1
    if s_idx >= len(cal) or s_idx >= e_idx:
        raise ValueError("The prices file has no trading days between " + r["since"] + " and " + (r["until"] or "its end") + ".")

    px = px[px["date"].isin(pos)]
    tickers = sorted(set(px["ticker"].tolist()))
    col = {t: j for j, t in enumerate(tickers)}
    di = px["date"].map(pos).to_numpy()
    tj = px["ticker"].map(col).to_numpy()

    def matrix(name):
        m = np.full((len(cal), len(tickers)), np.nan)
        if name in px.columns:
            v = px[name].to_numpy(dtype=float)
            v = np.where(np.isfinite(v) & (v > 0), v, np.nan)
            m[di, tj] = v
        return m

    close = matrix("close")
    opn = matrix("open") if "open" in px.columns else None
    close_ff = pd.DataFrame(close).ffill().to_numpy()

    rows = ev.to_dict("records")
    counts = {"events_in_file": len(rows), "left_out_flagged": 0, "missing_measure": 0, "qualifying": 0}
    picked = []
    for k, row in enumerate(rows):
        ticker = str(row.get("ticker", "")).strip().upper().replace(".", "-")
        day = str(row.get("event_date", ""))[:10]
        if not ticker or not day:
            continue
        kind = str(row.get("event_kind") or "earnings")
        if kind not in r["event_kinds"]:
            continue
        if day < r["since"] or (r["until"] and day > r["until"]):
            continue
        if r["tickers"] and ticker not in r["tickers"]:
            continue
        if r["sector_etf"] and str(row.get("sector_etf") or "").upper() != r["sector_etf"]:
            continue
        flags = [f for f in str(row.get("flags") or "").split("|") if f]
        if any(f in CAVEAT_FLAGS for f in flags) or any(f in r["exclude_flags"] for f in flags):
            counts["left_out_flagged"] += 1
            continue
        v = _num(row.get(r["measure"]))
        if v is None:
            counts["missing_measure"] += 1
            continue
        if not _passes(v, r):
            continue
        picked.append({"k": k, "ticker": ticker, "event_date": day, "value": v, "filed_at": str(row.get("filed_at") or ""), "accession": str(row.get("accession") or "")})
    # Stable order: event day, filing time, ticker, accession, then file order.
    picked.sort(key=lambda e: (e["event_date"], e["filed_at"], e["ticker"], e["accession"], e["k"]))
    counts["qualifying"] = len(picked)
    d1 = r["measure"] in ("stock_return_d1", "abnormal_return_d1", "stock_return_d0_d1", "abnormal_return_d0_d1")
    seen = set()
    events = []
    no_data = []
    for order, e in enumerate(picked):
        e["order"] = order
        e["skip"] = None
        key = (e["ticker"], e["event_date"])
        if key in seen:
            e["skip"] = "duplicate"
        seen.add(key)
        d0 = bisect.bisect_left(cal, e["event_date"])
        e["signal_idx"] = d0 + (1 if d1 else 0)
        if e["skip"] is None and e["filed_at"]:
            try:
                fd, fm = ny_parts(e["filed_at"])
                j = bisect.bisect_left(cal, fd) if fm < 16 * 60 else bisect.bisect_right(cal, fd)
                if j >= len(cal) or cal[j] > e["event_date"]:
                    e["skip"] = "timing"
            except ValueError:
                pass
        if e["skip"] is None and e["ticker"] not in col:
            e["skip"] = "no_price_data"
            if e["ticker"] not in no_data:
                no_data.append(e["ticker"])
        e["col"] = col.get(e["ticker"])
        events.append(e)
    return {
        "rules": r,
        "hash": spec_hash(r),
        "calendar": cal,
        "start_idx": s_idx,
        "end_idx": e_idx,
        "tickers": tickers,
        "col": col,
        "bench_col": col[bench],
        "open": opn,
        "close": close,
        "close_ff": close_ff,
        "events": events,
        "counts": counts,
        "no_price_tickers": sorted(no_data),
        "_valid": {},
        "_pools": {},
    }


def _valid_idx(data, j):
    import numpy as np

    v = data["_valid"].get(j)
    if v is None:
        v = np.flatnonzero(np.isfinite(data["close"][:, j]))
        data["_valid"][j] = v
    return v


def _pool(data, i, at_open):
    """Columns with a valid entry price on day i (the random comparison's choices), in ticker order."""
    import numpy as np

    key = (i, at_open)
    p = data["_pools"].get(key)
    if p is None:
        m = data["open"] if at_open else data["close"]
        p = [int(j) for j in np.flatnonzero(np.isfinite(m[i])) if int(j) != data["bench_col"]]
        data["_pools"][key] = p
    return p


def _pick(h, seed, order, n):
    x = hashlib.sha256(("%s|%s|%d" % (h, seed, order)).encode("utf-8")).hexdigest()
    return int(x[:15], 16) % n


def _r(x, nd=10):
    return None if x is None or not math.isfinite(x) else round(x, nd)


def _stats(eq, dates):
    out = {"cagr": None, "vol": None, "sharpe": None, "max_dd": None, "total_return": None}
    if len(eq) < 2 or not (eq[0] > 0):
        return out
    rets = [eq[i] / eq[i - 1] - 1 for i in range(1, len(eq)) if eq[i - 1] > 0]
    days = (datetime.date.fromisoformat(dates[-1]) - datetime.date.fromisoformat(dates[0])).days
    out["total_return"] = eq[-1] / eq[0] - 1
    if days > 0 and eq[-1] > 0:
        out["cagr"] = (eq[-1] / eq[0]) ** (365.25 / days) - 1
    if len(rets) >= 2:
        m = sum(rets) / len(rets)
        sd = math.sqrt(sum((x - m) ** 2 for x in rets) / (len(rets) - 1))
        out["vol"] = sd * math.sqrt(252)
        out["sharpe"] = (m / sd * math.sqrt(252)) if sd > 0 else None
    peak = -1.0
    dd = 0.0
    for e in eq:
        peak = max(peak, e)
        if peak > 0:
            dd = min(dd, e / peak - 1)
    out["max_dd"] = dd
    return out


def run(data, rules=None, costs_bps=None, lag_days=1, seed=None, random_picks=False):
    """One test. The defaults give the reported result; the audit re-runs it with costs x2, lag_days + 1 and random picks."""
    import numpy as np

    r = data["rules"]
    c = (r["costs_bps"] if costs_bps is None else float(costs_bps)) / 10000.0
    lag = 1 if lag_days is None else int(round(float(lag_days)))
    if lag < 1:
        raise ValueError("lag_days must be 1 or more (an entry on the signal day would use its own close)")
    cal = data["calendar"]
    s_idx, e_idx = data["start_idx"], data["end_idx"]
    K = r["max_positions"]
    hold = r["hold_days"]
    at_open = r["entry"] == "next_open"
    entry_m = data["open"] if at_open else data["close"]
    close = data["close"]
    close_ff = data["close_ff"]
    tickers = data["tickers"]
    h = data["hash"]
    seed_key = "none" if seed is None else str(int(seed))

    skipped = {k: 0 for k in SKIP_REASONS}
    by_day = {}
    for e in data["events"]:
        if e["skip"]:
            skipped[e["skip"]] += 1
            continue
        i = e["signal_idx"] + lag
        if i > e_idx or i >= len(cal):
            skipped["after_end"] += 1
            continue
        j = e["col"]
        if random_picks:
            pool = _pool(data, i, at_open)
            if not pool:
                skipped["no_entry_price"] += 1
                continue
            j = pool[_pick(h, seed_key, e["order"], len(pool))]
        px = entry_m[i, j]
        if not (px > 0):
            skipped["no_entry_price"] += 1
            continue
        by_day.setdefault(i, []).append((e, j, float(px)))
    for i in by_day:
        # Busy days: the largest move first, then ticker, event day and file order.
        by_day[i].sort(key=lambda x: (-abs(x[0]["value"]), tickers[x[1]], x[0]["event_date"], x[0]["order"]))

    cash = 1.0
    positions = []
    held = set()
    trades = []
    dates = []
    equity = []
    bench = []
    days_held = 0
    traded = 0.0
    eq_prev = 1.0
    b0 = close[s_idx, data["bench_col"]]

    def value_at(i):
        v = cash
        for p in positions:
            x = close_ff[i, p["col"]]
            v += p["shares"] * (x if x > 0 else p["price"])
        return v

    def enter(i, e, j, px, eq_ref):
        nonlocal cash, traded
        t = tickers[j]
        if j in held:
            skipped["already_held"] += 1
            return
        if len(positions) >= K:
            skipped["max_positions"] += 1
            return
        notional = min(eq_ref / K, cash / (1 + c))
        if not (notional > 1e-12):
            skipped["no_cash"] += 1
            return
        shares = notional / px
        cost = notional * (1 + c)
        cash -= cost
        traded += notional
        held.add(j)
        exit_idx = i + hold - 1 if at_open else i + hold
        positions.append({"col": j, "ticker": t, "shares": shares, "price": px, "cost": cost, "entry_idx": i, "exit_idx": exit_idx})
        trades.append({"date": cal[i], "ticker": t, "side": "buy", "qty": _r(shares), "weight": _r(notional / eq_ref if eq_ref > 0 else None, 6), "price": _r(px, 6), "pnl": None, "signal_date": cal[e["signal_idx"]]})

    for i in range(s_idx, e_idx + 1):
        todays = by_day.get(i, [])
        if at_open:
            for e, j, px in todays:
                enter(i, e, j, px, eq_prev)
        keep = []
        for p in positions:
            if p["exit_idx"] != i:
                keep.append(p)
                continue
            j = p["col"]
            px = close[i, j]
            if not (px > 0):
                later = _valid_idx(data, j)
                at = int(np.searchsorted(later, i, side="right"))
                k = int(later[at]) if at < len(later) else None
                if k is not None:
                    # No price on the exit day (a halt or a gap): sell at the next close.
                    p["exit_idx"] = k
                    keep.append(p)
                    continue
                # The stock stopped trading: sell at its last close.
                px = close_ff[i, j] if close_ff[i, j] > 0 else p["price"]
            px = float(px)
            proceeds = p["shares"] * px * (1 - c)
            cash += proceeds
            traded += p["shares"] * px
            held.discard(j)
            trades.append({"date": cal[i], "ticker": p["ticker"], "side": "sell", "qty": _r(p["shares"]), "weight": None, "price": _r(px, 6), "pnl": _r(proceeds / p["cost"] - 1, 8), "signal_date": None})
        positions = keep
        if not at_open and todays:
            ref = value_at(i)
            for e, j, px in todays:
                enter(i, e, j, px, ref)
        eq = value_at(i)
        if positions:
            days_held += 1
        dates.append(cal[i])
        equity.append(eq)
        bx = close[i, data["bench_col"]]
        bench.append(bx / b0 if (bx > 0 and b0 > 0) else None)
        eq_prev = eq

    eq0 = equity[0]
    curve = [e / eq0 for e in equity]
    peak = -1.0
    dd = []
    for e in curve:
        peak = max(peak, e)
        dd.append(e / peak - 1)
    st = _stats(curve, dates)
    bvals = [x for x in bench if x is not None]
    bst = _stats(bvals, [d for d, x in zip(dates, bench) if x is not None])
    sells = [t for t in trades if t["side"] == "sell"]
    years = max(1e-9, (datetime.date.fromisoformat(dates[-1]) - datetime.date.fromisoformat(dates[0])).days / 365.25)
    mean_eq = sum(curve) / len(curve)
    buys = len(trades) - len(sells)
    sk = {k: v for k, v in skipped.items() if v}
    counts = dict(data["counts"])
    counts.update({"entered": buys, "closed": len(sells), "open_at_end": buys - len(sells), "skipped": dict(sorted(sk.items()))})
    warnings = [
        "Tickers are today's filers in Falcon's events table (about 1,400 US companies): companies that were delisted or acquired before today are missing, so the test carries survivorship bias.",
    ]
    if sk.get("max_positions"):
        warnings.append("%d qualifying events were skipped because %d positions were already open." % (sk["max_positions"], K))
    if sk.get("no_price_data"):
        warnings.append("%d qualifying events had no prices for their ticker (delisted, renamed or not in the price file)." % sk["no_price_data"])
    if counts["open_at_end"]:
        warnings.append("%d positions were still open at the end and are not counted as closed trades." % counts["open_at_end"])
    if random_picks:
        warnings.append("Random comparison version: the same schedule and rules with random stocks (seed %s)." % seed_key)
    result = {
        "name": "Event test",
        "period": {"start": dates[0], "end": dates[-1]},
        "universe": "Companies in Falcon's events table with prices (%d tickers)" % max(0, len(tickers) - 1),
        "benchmark": r["benchmark"],
        "closed_trades": len(sells),
        "assumptions": {
            "costs_bps": r["costs_bps"] if costs_bps is None else float(costs_bps),
            "rebalance": "Event-driven: one position per qualifying event, held %d trading days" % hold,
            "signal_lag": "Enter %d trading day%s after the signal day's close, at the %s" % (lag, "" if lag == 1 else "s", "open" if at_open else "close"),
            "notes": [
                "Falcon's event-backtest helper v%d, rules hash %s." % (HELPER_VERSION, h),
                "%d events in the file, %d qualifying, %d entered, %d closed." % (counts["events_in_file"], counts["qualifying"], buys, len(sells)),
            ],
        },
        "metrics": {
            "cagr": _r(st["cagr"]),
            "vol": _r(st["vol"]),
            "sharpe": _r(st["sharpe"]),
            "max_dd": _r(st["max_dd"]),
            "total_return": _r(st["total_return"]),
            "trades": len(sells),
            "win_rate": _r(sum(1 for t in sells if (t["pnl"] or 0) > 0) / len(sells)) if sells else None,
            "turnover": _r(traded / 2 / mean_eq / years) if mean_eq > 0 else None,
            "exposure": _r(days_held / len(dates)),
            "benchmark": {"cagr": _r(bst["cagr"]), "sharpe": _r(bst["sharpe"]), "max_dd": _r(bst["max_dd"]), "total_return": _r(bst["total_return"])},
        },
        "series": {"dates": dates, "equity": [_r(x) for x in curve], "benchmark_equity": [_r(x) for x in bench], "drawdown": [_r(x) for x in dd]},
        "trades": trades,
        "trade_count": len(trades),
        "warnings": warnings,
        "spec": {"kind": "event_backtest", "helper_version": HELPER_VERSION, "hash": h, "rules": r, "counts": counts},
    }
    return result


def main(run_fn, script_path, name=None):
    """Writes falcon_result.json next to the script and copies it to $OUTPUT_DIR."""
    res = run_fn()
    if name:
        res["name"] = name
    here = os.path.abspath(__file__)
    code = open(script_path, encoding="utf-8").read()
    res["code"] = code + "\n\n# ---- falcon_event_backtest.py (Falcon's helper, imported above) ----\n" + open(here, encoding="utf-8").read()
    out = os.path.join(os.path.dirname(os.path.abspath(script_path)), "falcon_result.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(res, f, allow_nan=False, separators=(",", ":"))
    od = os.environ.get("OUTPUT_DIR")
    if od and os.path.abspath(od) != os.path.dirname(out):
        shutil.copy(out, os.path.join(od, "falcon_result.json"))
    m = res["metrics"]
    s = res["spec"]["counts"]
    f = lambda v: "n/a" if v is None else "%.4f" % v
    print("rules", res["spec"]["hash"], "| qualifying", s["qualifying"], "| entered", s["entered"], "| closed", s["closed"], "| skipped", json.dumps(s["skipped"], sort_keys=True))
    print("cagr", f(m["cagr"]), "| max_dd", f(m["max_dd"]), "| sharpe", f(m["sharpe"]), "| exposure", f(m["exposure"]), "| benchmark cagr", f(m["benchmark"]["cagr"]))
    print("wrote", out)
    return res
`.replace("__VERSION__", String(EVENT_HELPER_VERSION));

const SCRIPT_HEAD = "# Falcon event backtest: generated by Falcon from the declared rules (event_backtest). Do not edit.";
const CHECK_PREFIX = "# falcon-canonical sha256=";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
/** One line of a comment: no line breaks or control characters. */
const oneLine = (s: string) => s.replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 300);

/** The script that runs one event test with the helper: the rules as data, run() for the audit, a checksum last. */
export function eventScript(o: { rules: EventRules; name: string; plain: string[]; eventsFile: string; pricesFile: string }): string {
  const files = [o.eventsFile, o.pricesFile].map((f) => {
    if (!/^[\w.-]{1,80}$/.test(f)) throw new Error(`bad file name ${f.slice(0, 40)}`);
    return f;
  });
  const body = [
    SCRIPT_HEAD,
    "# The rules tested, in plain words:",
    ...o.plain.map((l) => `#   ${oneLine(l)}`),
    "import json, os, sys",
    "",
    "sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))",
    `import ${EVENT_HELPER_MODULE} as feb`,
    "",
    `RULES = json.loads(r"""${JSON.stringify(o.rules)}""")`,
    `NAME = ${JSON.stringify(oneLine(o.name))}`,
    `DATA = feb.load_data(feb.find_input(${JSON.stringify(files[0])}), feb.find_input(${JSON.stringify(files[1])}), RULES)`,
    "",
    "",
    `def run(costs_bps=${Number(o.rules.costs_bps)}, lag_days=1, seed=None, random_picks=False):`,
    "    return feb.run(DATA, RULES, costs_bps=costs_bps, lag_days=lag_days, seed=seed, random_picks=random_picks)",
    "",
    "",
    'if __name__ == "__main__":',
    "    feb.main(run, __file__, NAME)",
    "",
  ].join("\n");
  return `${body}${CHECK_PREFIX}${sha(body)}\n`;
}

/** Whether `code` is a script eventScript wrote, unedited (its checksum line matches the rest). */
export function isCanonicalEventScript(code: string): boolean {
  const text = code.replace(/\r\n/g, "\n");
  if (!text.startsWith(SCRIPT_HEAD)) return false;
  const at = text.lastIndexOf(CHECK_PREFIX);
  if (at < 0) return false;
  const want = text.slice(at + CHECK_PREFIX.length).trim();
  return /^[0-9a-f]{64}$/.test(want) && sha(text.slice(0, at)) === want;
}

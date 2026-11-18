/**
 * The fixed Python harness of the Desk audit (lib/desk/audit-run.ts uploads it
 * into the test's sandbox and runs it there). It imports the test script,
 * which must expose
 *
 *   run(costs_bps=..., lag_days=..., seed=None, random_picks=False) -> result dict
 *
 * (lib/desk/system.ts asks for it), and calls it with costs x2, the signal lag
 * +1 day, N random-pick placebo versions (seeds 1..N, fixed, so a re-audit
 * gives the same versions) and the defaults again (reproducibility). The
 * script is imported once, so the prices and every signal computed at its top
 * level are loaded once and shared by the worker processes (fork).
 *
 * The sandbox has ONE CPU (measured: os.cpu_count() == 1), so the versions run
 * one after another and a slow run() does not fit one request. Each finished
 * version is saved at once to a state file in the sandbox (keyed by the
 * script's bytes, the harness version and N); a later call with the same
 * script carries on with the versions still pending and never loses finished
 * ones. A version is only started when the time left fits it (median time of
 * the finished ones), so the harness stops early instead of killing it.
 * falcon_audit.json says which jobs are still pending ("complete": false), and
 * lib/desk/audit-run.ts then continues the audit in the next request.
 *
 * Workers run in a scratch directory with OUTPUT_DIR pointed there, so a
 * script that writes files cannot overwrite the real result.
 *
 * It writes falcon_audit.json to $OUTPUT_DIR (parsed by parseHarnessOutput in
 * lib/desk/audit.ts) and, with --copy-result, copies the test's
 * falcon_result.json there too. Statistics match lib/desk/audit.ts: the gain
 * over SPY is the mean daily difference x 252, in percent.
 *
 *   python3 falcon_audit.py --script backtest.py --budget 28 --placebos 20 [--copy-result]
 */

export const AUDIT_FILE = "falcon_audit.json";

/** Bump when the jobs or their statistics change (old state files are then ignored). */
export const HARNESS_VERSION = 2;

export const HARNESS_PY = String.raw`# Falcon audit harness: re-runs the test script's run() with changed settings.
import argparse, contextlib, glob, hashlib, importlib.util, inspect, io, json, math, os, shutil, sys, tempfile, time
import multiprocessing as mp

HARNESS_VERSION = __VERSION__
MOD = None
SCRATCH = None


def num(v):
    try:
        f = float(v)
        return f if math.isfinite(f) else None
    except Exception:
        return None


def stats(res):
    s = (res or {}).get("series") or {}
    dates = list(s.get("dates") or [])
    eq = [num(x) for x in (s.get("equity") or [])]
    be = [num(x) for x in (s.get("benchmark_equity") or [])]
    n = min(len(dates), len(eq))
    act = []
    for i in range(1, n):
        e0, e1 = eq[i - 1], eq[i]
        b0 = be[i - 1] if i - 1 < len(be) else None
        b1 = be[i] if i < len(be) else None
        if not e0 or e0 <= 0 or e1 is None or not b0 or b0 <= 0 or b1 is None:
            continue
        act.append((e1 / e0 - 1) - (b1 / b0 - 1))
    cagr = None
    tot = None
    if n > 1 and eq[0] and eq[n - 1] and eq[0] > 0 and eq[n - 1] > 0:
        tot = eq[n - 1] / eq[0] - 1
        try:
            import datetime as dt
            d0 = dt.date.fromisoformat(str(dates[0])[:10])
            d1 = dt.date.fromisoformat(str(dates[n - 1])[:10])
            yrs = (d1 - d0).days / 365.25
            if yrs > 0:
                cagr = (eq[n - 1] / eq[0]) ** (1 / yrs) - 1
        except Exception:
            pass
    trades = res.get("trades") if isinstance(res, dict) else None
    sells = sum(1 for t in (trades or []) if str((t or {}).get("side", "")).lower() in ("sell", "exit"))
    return {
        "cagr": cagr,
        "active_pct": (sum(act) / len(act) * 252 * 100) if len(act) >= 20 else None,
        "total_return": tot,
        "trades": sells,
    }


def job(item):
    key, name, kw = item
    started = time.time()
    try:
        os.chdir(SCRATCH)
        os.environ["OUTPUT_DIR"] = SCRATCH
        sink = io.StringIO()
        with contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
            res = MOD.run(**kw)
        return [key, name, kw, stats(res), None, round(time.time() - started, 3)]
    except Exception as e:
        return [key, name, kw, None, (type(e).__name__ + ": " + str(e))[:300], round(time.time() - started, 3)]


def find_script(path):
    cands = [path, os.path.join(os.getcwd(), path)]
    base = os.path.basename(path)
    for d in [os.getcwd(), "/tmp", os.path.expanduser("~"), "/workspace", "/mnt/data", "/mnt/user-data", "/files"]:
        cands.append(os.path.join(d, base))
    for c in cands:
        if c and os.path.isfile(c):
            return os.path.abspath(c)
    found = []
    for d in [os.getcwd(), "/tmp", os.path.expanduser("~")]:
        for f in glob.glob(os.path.join(d, "*.py")) + glob.glob(os.path.join(d, "*", "*.py")):
            try:
                if "falcon_audit" not in f and "def run(" in open(f, encoding="utf-8", errors="ignore").read():
                    found.append(f)
            except Exception:
                pass
    found.sort(key=lambda f: os.path.getmtime(f), reverse=True)
    return os.path.abspath(found[0]) if found else None


def find_result(script):
    dirs = [os.path.dirname(script) if script else None, os.getcwd(), os.environ.get("OUTPUT_DIR"), "/tmp", os.path.expanduser("~")]
    hits = [os.path.join(d, "falcon_result.json") for d in dirs if d and os.path.isfile(os.path.join(d, "falcon_result.json"))]
    hits.sort(key=lambda f: os.path.getmtime(f), reverse=True)
    return hits[0] if hits else None


def state_file(script, placebos):
    h = hashlib.sha256()
    h.update(open(script, "rb").read())
    h.update(("|v%d|%d" % (HARNESS_VERSION, placebos)).encode())
    return os.path.join(tempfile.gettempdir(), "falcon_audit_state_" + h.hexdigest()[:20] + ".json")


def load_state(path):
    try:
        st = json.load(open(path))
        if st.get("version") == HARNESS_VERSION and isinstance(st.get("done"), dict):
            return st
    except Exception:
        pass
    return {"version": HARNESS_VERSION, "done": {}, "hops": 0}


def save_state(path, st):
    # Atomic: a call cut off mid-write never leaves a broken file (finished versions are never lost).
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(st, f, allow_nan=False, default=lambda v: None)
    os.replace(tmp, path)


def median(xs):
    xs = sorted(xs)
    return xs[len(xs) // 2] if xs else None


def main():
    global MOD, SCRATCH
    ap = argparse.ArgumentParser()
    ap.add_argument("--script", default="")
    ap.add_argument("--budget", type=float, default=25.0)
    ap.add_argument("--placebos", type=int, default=20)
    ap.add_argument("--copy-result", action="store_true")
    a = ap.parse_args()
    t0 = time.time()
    deadline = t0 + max(3.0, a.budget)
    out_dir = os.environ.get("OUTPUT_DIR") or os.getcwd()
    out = {"version": HARNESS_VERSION, "error": None, "defaults": {}, "params": [], "variants": {}, "placebo": [], "placebo_wanted": a.placebos, "errors": [], "elapsed_s": None, "complete": None, "pending": [], "hops": None, "ran": 0, "job_s": None}
    script = find_script(a.script)
    result_path = find_result(script)
    if a.copy_result and result_path and os.path.abspath(result_path) != os.path.abspath(os.path.join(out_dir, "falcon_result.json")):
        try:
            shutil.copy(result_path, os.path.join(out_dir, "falcon_result.json"))
        except Exception as e:
            out["errors"].append("copy: " + str(e)[:200])
    keep = None
    if result_path:
        try:
            keep = open(result_path, "rb").read()
            # The reported result, measured the same way as the re-runs (the route may only see a cut copy).
            out["variants"]["reported"] = stats(json.loads(keep))
        except Exception:
            keep = None

    def finish():
        out["elapsed_s"] = round(time.time() - t0, 2)
        if keep is not None and result_path:
            try:
                if open(result_path, "rb").read() != keep:
                    open(result_path, "wb").write(keep)
            except Exception:
                pass
        with open(os.path.join(out_dir, "falcon_audit.json"), "w") as f:
            json.dump(out, f, allow_nan=False, default=lambda v: None)
        v = out["variants"]
        print("audit:", "error=" + str(out["error"]) if out["error"] else "", "costs_x2" if "costs_x2" in v else "", "lag_plus1" if "lag_plus1" in v else "", "base" if "base" in v else "", "placebos=%d/%d" % (len(out["placebo"]), a.placebos), "ran=%d" % out["ran"], "pending=%d" % len(out["pending"]), "job=%ss" % out["job_s"], "%.1fs" % out["elapsed_s"])

    if not script:
        out["error"] = "The test script was not found in the sandbox."
        return finish()
    out["script"] = script
    spath = state_file(script, max(0, a.placebos))
    state = load_state(spath)
    state["hops"] = int(state.get("hops") or 0) + 1
    out["hops"] = state["hops"]

    def collect():
        done = state["done"]
        times = [r[5] for r in done.values() if r[4] is None and num(r[5]) is not None]
        out["job_s"] = round(median(times), 3) if times else None
        errs = [r[1] + ": " + r[4] for r in done.values() if r[4]]
        for e in errs:
            if len(out["errors"]) < 5:
                out["errors"].append(e)
        placebo = []
        for key, name, kw, st, err, secs in done.values():
            if err:
                continue
            if name == "placebo":
                if st and st.get("active_pct") is not None:
                    placebo.append({"seed": kw.get("seed"), "active_pct": st["active_pct"], "cagr": st.get("cagr")})
            else:
                st = dict(st or {})
                st.update({k: v for k, v in kw.items()})
                st["seconds"] = secs
                out["variants"][name] = st
        placebo.sort(key=lambda p: p["seed"] or 0)
        out["placebo"] = placebo

    jobs = state.get("jobs")
    if jobs and not [j for j in jobs if j[0] not in state["done"]] and not (a.copy_result and not result_path):
        # Everything already ran in an earlier call: answer from the saved state without importing the script again.
        out["params"] = state.get("params") or []
        out["defaults"] = state.get("defaults") or {}
        out["complete"] = True
        collect()
        save_state(spath, state)
        return finish()
    try:
        sys.path.insert(0, os.path.dirname(script))
        spec = importlib.util.spec_from_file_location("falcon_strategy", script)
        MOD = importlib.util.module_from_spec(spec)
        sink = io.StringIO()
        with contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
            spec.loader.exec_module(MOD)
    except Exception as e:
        out["error"] = ("The script could not be imported: " + type(e).__name__ + ": " + str(e))[:400]
        return finish()
    out["import_s"] = round(time.time() - t0, 2)
    fn = getattr(MOD, "run", None)
    if not callable(fn):
        out["error"] = "The script has no run(costs_bps, lag_days, seed, random_picks) function, so it could not be re-run with other settings."
        return finish()
    try:
        params = inspect.signature(fn).parameters
    except Exception:
        params = {}
    out["params"] = list(params)

    def default(name, fallback):
        p = params.get(name)
        if p is None or p.default is inspect.Parameter.empty or num(p.default) is None:
            return fallback
        return num(p.default)

    c0 = default("costs_bps", 5.0)
    l0 = default("lag_days", 1.0)
    out["defaults"] = {"costs_bps": c0, "lag_days": l0}
    if a.copy_result and not result_path:
        # The route needs the result and the script's file is gone: run the defaults here and hand that over.
        try:
            sink = io.StringIO()
            with contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
                res = fn()
            res = dict(res or {})
            res.setdefault("code", open(script, encoding="utf-8", errors="ignore").read())
            with open(os.path.join(out_dir, "falcon_result.json"), "w") as f:
                json.dump(res, f, allow_nan=False, default=lambda v: None)
            out["variants"]["reported"] = stats(res)
        except Exception as e:
            out["errors"].append(("result: " + type(e).__name__ + ": " + str(e))[:300])
    # Order: the two re-runs that cap the label first, then the random versions (fixed seeds 1..N), then the defaults again.
    jobs = []
    if "costs_bps" in params:
        jobs.append(["costs_x2", "costs_x2", {"costs_bps": c0 * 2}])
    if "lag_days" in params:
        jobs.append(["lag_plus1", "lag_plus1", {"lag_days": int(round(l0)) + 1}])
    if "random_picks" in params and "seed" in params:
        jobs += [["placebo:%d" % (i + 1), "placebo", {"seed": i + 1, "random_picks": True}] for i in range(max(0, a.placebos))]
    jobs.append(["base", "base", {}])
    state["jobs"] = jobs
    state["params"] = out["params"]
    state["defaults"] = out["defaults"]
    save_state(spath, state)
    queue = [j for j in jobs if j[0] not in state["done"]]
    SCRATCH = tempfile.mkdtemp(prefix="falcon_audit_")
    workers = max(1, min(os.cpu_count() or 1, 4))
    out["workers"] = workers
    pool = None
    if queue:
        try:
            pool = mp.get_context("fork").Pool(workers)
        except Exception as e:
            out["errors"].append("pool: " + str(e)[:200])
    times = [r[5] for r in state["done"].values() if r[4] is None and num(r[5]) is not None]

    def record(r):
        state["done"][r[0]] = r
        out["ran"] += 1
        if r[4] is None:
            times.append(r[5])
        save_state(spath, state)

    if pool is not None:
        inflight = []
        while queue or inflight:
            left = deadline - time.time()
            if left <= 0:
                break
            est = median(times)
            # Start a version only when it fits the time left (it would be cut off and lost otherwise).
            while queue and len(inflight) < workers and (est is None or est * 1.05 < left):
                j = queue.pop(0)
                inflight.append(pool.apply_async(job, (j,)))
            if not inflight:
                break
            still = []
            for ar in inflight:
                if ar.ready():
                    try:
                        record(ar.get())
                    except Exception as e:
                        out["errors"].append(str(e)[:200])
                else:
                    still.append(ar)
            inflight = still
            if inflight:
                time.sleep(0.02)
        pool.terminate()
    elif queue:
        for j in list(queue):
            est = median(times)
            left = deadline - time.time()
            if left <= 0 or (est is not None and est * 1.05 >= left):
                break
            queue.remove(j)
            record(job(j))
    save_state(spath, state)
    out["pending"] = [j[0] for j in jobs if j[0] not in state["done"]]
    out["complete"] = not out["pending"]
    collect()
    return finish()


if __name__ == "__main__":
    main()
`.replace("__VERSION__", String(HARNESS_VERSION));

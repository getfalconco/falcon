import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bivariateNormalCdf, bs2002Price, crrPrice, impliedVolAmerican } from "../src/options/american.ts";
import { brent, bsmGreeks, bsmPrice, checkQuote, europeanBounds, impliedVolEuropean, normCdf, type OptionInput } from "../src/options/math.ts";
import { dividendYieldOn, discountToContinuous, parseFredCsv, parseYahooDividends, rateOn } from "../src/options/rates.ts";

const close = (a: number, b: number, tol: number, msg = "") => assert.ok(Math.abs(a - b) <= tol, `${msg} ${a} vs ${b} (tol ${tol})`);

describe("normal distributions", () => {
  it("normCdf matches reference values to 1e-12", () => {
    close(normCdf(0), 0.5, 1e-15);
    close(normCdf(1.96), 0.9750021048517795, 1e-12);
    close(normCdf(-3), 0.0013498980316301, 1e-13);
    close(normCdf(-8), 6.22096057427178e-16, 1e-20);
    close(normCdf(1) + normCdf(-1), 1, 1e-15);
  });

  it("bivariate normal: M(0,0,rho) = 1/4 + asin(rho)/(2 pi), independence, and limits", () => {
    for (const rho of [-0.99, -0.95, -0.5, -0.2, 0, 0.2, 0.5, 0.8, 0.95, 0.99]) {
      close(bivariateNormalCdf(0, 0, rho), 0.25 + Math.asin(rho) / (2 * Math.PI), 1e-12, `rho ${rho}`);
    }
    close(bivariateNormalCdf(0.7, -0.4, 0), normCdf(0.7) * normCdf(-0.4), 1e-14);
    close(bivariateNormalCdf(1.2, 8, 0.6), normCdf(1.2), 1e-12);
    close(bivariateNormalCdf(-8, 1, 0.3), 0, 1e-12);
  });
});

describe("Black-Scholes-Merton (Hull examples)", () => {
  it("Hull 15.6: S 42, K 40, r 10%, sigma 20%, 6 months: call 4.76, put 0.81", () => {
    const o = { S: 42, K: 40, T: 0.5, r: 0.1, q: 0, sigma: 0.2 };
    close(bsmPrice({ ...o, right: "C" }), 4.76, 0.005);
    close(bsmPrice({ ...o, right: "P" }), 0.81, 0.005);
  });

  it("Hull 17.x: index option with dividend yield, S 930, K 900, r 8%, q 3%, sigma 20%, 2 months: call 51.83", () => {
    close(bsmPrice({ S: 930, K: 900, T: 2 / 12, r: 0.08, q: 0.03, sigma: 0.2, right: "C" }), 51.83, 0.005);
  });

  it("Hull Greeks example (S 49, K 50, r 5%, sigma 20%, 20 weeks): delta 0.522, gamma 0.066, theta -4.31/yr, vega 12.1, rho 8.91", () => {
    const g = bsmGreeks({ S: 49, K: 50, T: 20 / 52, r: 0.05, q: 0, sigma: 0.2, right: "C" });
    close(g.price, 2.4, 0.005);
    close(g.delta, 0.522, 0.0005);
    close(g.gamma, 0.066, 0.0005);
    close(g.theta, -4.31, 0.01);
    close(g.vega, 12.1, 0.01);
    close(g.rho, 8.91, 0.01);
  });

  it("put-call parity with dividends and Greeks by finite differences", () => {
    const o = { S: 105, K: 100, T: 0.75, r: 0.04, q: 0.02, sigma: 0.3 };
    const c = bsmPrice({ ...o, right: "C" });
    const p = bsmPrice({ ...o, right: "P" });
    close(c - p, o.S * Math.exp(-o.q * o.T) - o.K * Math.exp(-o.r * o.T), 1e-10);
    for (const right of ["C", "P"] as const) {
      const g = bsmGreeks({ ...o, right });
      const h = 1e-3;
      const f = (patch: Partial<OptionInput>) => bsmPrice({ ...o, right, ...patch });
      close(g.delta, (f({ S: o.S + h }) - f({ S: o.S - h })) / (2 * h), 1e-6, `delta ${right}`);
      close(g.gamma, (f({ S: o.S + h }) - 2 * f({}) + f({ S: o.S - h })) / (h * h), 1e-4, `gamma ${right}`);
      close(g.vega, (f({ sigma: o.sigma + h }) - f({ sigma: o.sigma - h })) / (2 * h), 1e-4, `vega ${right}`);
      close(g.theta, -(f({ T: o.T + h }) - f({ T: o.T - h })) / (2 * h), 1e-4, `theta ${right}`);
    }
  });

  it("expired or zero-vol options are worth the discounted forward intrinsic", () => {
    assert.equal(bsmPrice({ S: 110, K: 100, T: 0, r: 0.05, q: 0, sigma: 0.3, right: "C" }), 10);
    assert.equal(bsmPrice({ S: 90, K: 100, T: 0, r: 0.05, q: 0, sigma: 0.3, right: "C" }), 0);
  });
});

describe("Brent and implied volatility", () => {
  it("brent finds roots and refuses unbracketed intervals", () => {
    close(brent((x) => x * x - 2, 0, 2)!, Math.SQRT2, 1e-9);
    close(brent((x) => Math.cos(x) - x, 0, 1)!, 0.7390851332151607, 1e-9);
    assert.equal(brent((x) => x * x + 1, -1, 1), null);
  });

  it("European IV round-trips across moneyness, maturity and volatility", () => {
    for (const K of [60, 80, 95, 100, 105, 120, 150]) {
      for (const T of [7 / 365, 0.1, 0.5, 2]) {
        for (const sigma of [0.08, 0.25, 0.6, 1.5]) {
          for (const right of ["C", "P"] as const) {
            const o = { S: 100, K, T, r: 0.045, q: 0.015, right };
            const price = bsmPrice({ ...o, sigma });
            const [lo] = europeanBounds(o.S, K, T, o.r, o.q, right);
            if (price - lo < 1e-6) continue; // no time value left to invert
            const iv = impliedVolEuropean(price, o);
            assert.ok(iv !== null, `no IV for ${JSON.stringify({ ...o, sigma })}`);
            close(iv, sigma, 1e-5, JSON.stringify({ ...o, sigma }));
          }
        }
      }
    }
  });

  it("IV is null outside no-arbitrage bounds", () => {
    const o = { S: 100, K: 90, T: 0.5, r: 0.05, q: 0, right: "C" as const };
    const [lo, hi] = europeanBounds(o.S, o.K, o.T, o.r, o.q, "C");
    assert.equal(impliedVolEuropean(lo - 0.01, o), null);
    assert.equal(impliedVolEuropean(hi + 0.01, o), null);
    assert.equal(impliedVolEuropean(0, o), null);
    assert.equal(impliedVolEuropean(5, { ...o, T: 0 }), null);
    // An American price at or below intrinsic has no time value to invert.
    assert.equal(impliedVolAmerican(9.99, { ...o, r: 0.05 }), null);
  });

  it("quote screen: zero or missing bid, crossed, wide", () => {
    assert.equal(checkQuote(1, 1.2).ok, true);
    assert.equal(checkQuote(null, 0.5).reason, "zero_bid");
    assert.equal(checkQuote(0, 0.5).reason, "zero_bid");
    assert.equal(checkQuote(1.2, 1).reason, "crossed");
    assert.equal(checkQuote(1, 3).reason, "wide");
    assert.equal(checkQuote(1, 3, 1.5).ok, true);
    assert.equal(checkQuote(null, null).reason, "no_quote");
    close(checkQuote(1, 1.2).mid!, 1.1, 1e-12);
  });
});

describe("American options", () => {
  it("CRR reproduces Hull's American put (S 50, K 50, r 10%, sigma 40%, 5 months): 4.283 at 500 steps", () => {
    close(crrPrice({ S: 50, K: 50, T: 5 / 12, r: 0.1, q: 0, sigma: 0.4, right: "P" }, 500), 4.283, 0.001);
  });

  it("CRR European tree converges to BSM", () => {
    const o: OptionInput = { S: 100, K: 105, T: 0.5, r: 0.04, q: 0.01, sigma: 0.3, right: "P" };
    close(crrPrice(o, 1000, false), bsmPrice(o), 0.01);
  });

  it("BS2002 call on a non-dividend stock equals BSM exactly", () => {
    for (const K of [80, 100, 130]) {
      const o: OptionInput = { S: 100, K, T: 0.7, r: 0.05, q: 0, sigma: 0.35, right: "C" };
      assert.equal(bs2002Price(o), bsmPrice(o));
    }
  });

  it("BS2002 is within 1% (or 2 cents) of a 2000-step tree, and American >= European >= intrinsic", () => {
    const cases: OptionInput[] = [
      { S: 42, K: 40, T: 0.75, r: 0.04, q: 0.08, sigma: 0.35, right: "C" }, // Haug's example (b = -0.04)
      { S: 50, K: 50, T: 5 / 12, r: 0.1, q: 0, sigma: 0.4, right: "P" }, // Hull's put
      { S: 100, K: 100, T: 1, r: 0.05, q: 0.03, sigma: 0.3, right: "P" },
      { S: 100, K: 80, T: 0.5, r: 0.05, q: 0, sigma: 0.25, right: "P" },
      { S: 100, K: 120, T: 0.25, r: 0.04, q: 0.02, sigma: 0.5, right: "C" },
      { S: 100, K: 100, T: 2, r: 0.05, q: 0.06, sigma: 0.2, right: "C" },
      { S: 100, K: 110, T: 0.1, r: 0.045, q: 0.01, sigma: 0.35, right: "P" },
      { S: 150, K: 140, T: 30 / 365, r: 0.042, q: 0.0055, sigma: 0.65, right: "P" },
    ];
    for (const o of cases) {
      const a = bs2002Price(o);
      const tree = crrPrice(o, 2000);
      const eu = bsmPrice(o);
      const intrinsic = o.right === "C" ? Math.max(o.S - o.K, 0) : Math.max(o.K - o.S, 0);
      assert.ok(Math.abs(a - tree) <= Math.max(0.02, 0.01 * tree), `${JSON.stringify(o)} bs2002 ${a} tree ${tree}`);
      assert.ok(a >= eu - 1e-12 && a >= intrinsic, `${JSON.stringify(o)} below bounds`);
      assert.ok(tree >= eu - 0.01, "tree below European");
    }
  });

  it("deep in-the-money put with high rates is exercised at once (price = intrinsic)", () => {
    close(bs2002Price({ S: 50, K: 100, T: 1, r: 0.1, q: 0, sigma: 0.2, right: "P" }), 50, 1e-9);
  });

  it("American IV round-trips and is never above the European IV of the same price", () => {
    for (const K of [80, 95, 100, 110]) {
      for (const sigma of [0.2, 0.45, 0.9]) {
        for (const right of ["C", "P"] as const) {
          const o = { S: 100, K, T: 0.4, r: 0.045, q: 0.02, right };
          const price = bs2002Price({ ...o, sigma });
          const iv = impliedVolAmerican(price, o);
          assert.ok(iv !== null);
          close(iv, sigma, 1e-6, JSON.stringify({ ...o, sigma }));
          const ivEu = impliedVolEuropean(price, o);
          if (ivEu !== null) assert.ok(iv <= ivEu + 1e-9, "American IV above European IV");
        }
      }
    }
  });

  it("BS2002 survives tiny volatilities (no NaN)", () => {
    for (const sigma of [1e-4, 1e-3, 0.01]) {
      for (const right of ["C", "P"] as const) assert.ok(Number.isFinite(bs2002Price({ S: 100, K: 105, T: 0.25, r: 0.04, q: 0.02, sigma, right })));
    }
  });
});

describe("rates and dividends", () => {
  it("parses FRED CSV, skipping holidays", () => {
    const pts = parseFredCsv("observation_date,DTB3\n2026-11-10,4.12\n2026-11-11,\n2026-11-12,4.14\n2026-11-13,.\n");
    assert.deepEqual(pts, [
      { date: "2026-11-10", pct: 4.12 },
      { date: "2026-11-12", pct: 4.14 },
    ]);
    close(rateOn(pts, "2026-11-11")!, discountToContinuous(4.12), 1e-15);
    close(rateOn(pts, "2026-11-14")!, discountToContinuous(4.14), 1e-15);
    assert.equal(rateOn(pts, "2026-11-01"), null);
    assert.equal(rateOn(pts, "2026-12-31"), null);
  });

  it("discount yield to continuous: 4% discount on a 91-day bill is about 4.08% continuous", () => {
    const r = discountToContinuous(4);
    const price = 1 - 0.04 * (91 / 360);
    close(Math.exp(-r * (91 / 365)), price, 1e-15);
    close(r, 0.04076, 0.0001);
  });

  it("trailing 12-month dividend yield from a Yahoo chart", () => {
    const day = (d: string) => Date.parse(`${d}T14:30:00Z`) / 1000;
    const json = {
      chart: {
        result: [
          {
            timestamp: [day("2026-11-12"), day("2026-11-13")],
            indicators: { quote: [{ close: [158, 152.32] }] },
            events: {
              dividends: {
                a: { amount: 0.19, date: day("2025-11-17") },
                b: { amount: 0.19, date: day("2026-02-17") },
                c: { amount: 0.23, date: day("2026-05-18") },
                d: { amount: 0.23, date: day("2026-08-17") },
                e: { amount: 0.23, date: day("2026-11-16") },
              },
            },
          },
        ],
      },
    };
    const h = parseYahooDividends(json);
    assert.equal(h.dividends.length, 5);
    // Ex-dates in (2025-11-13, 2026-11-13]: 0.19 + 0.19 + 0.23 + 0.23 = 0.84.
    close(dividendYieldOn(h, "2026-11-13")!, Math.log(1 + 0.84 / 152.32), 1e-12);
    close(dividendYieldOn(h, "2026-11-13", 100)!, Math.log(1.0084), 1e-12);
    assert.equal(dividendYieldOn(h, "2020-01-01"), null);
  });
});

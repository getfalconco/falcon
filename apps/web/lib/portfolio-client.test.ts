// Run: cd packages/engine && node --import tsx --test ../../apps/web/lib/portfolio-client.test.ts
// The SnapTrade popup wait in importBrokerHoldings, with a stand-in window and fetch; nothing leaves the machine.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { importBrokerHoldings } from "./portfolio-client";

type Listener = (event: MessageEvent) => void;

/** A stand-in `window` that counts its message listeners, and a fetch that answers the two broker routes. */
function stage(holdings: { status: number; body: unknown }) {
  const listeners = new Set<Listener>();
  const win = {
    location: { origin: "http://localhost:3000" },
    addEventListener: (type: string, l: Listener) => type === "message" && listeners.add(l),
    removeEventListener: (type: string, l: Listener) => type === "message" && listeners.delete(l),
  };
  const calls: string[] = [];
  (globalThis as { window?: unknown }).window = win;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push(url);
    if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
    if (url.endsWith("/start")) return new Response(JSON.stringify({ url: "https://snaptrade.example/connect" }), { status: 200 });
    return new Response(JSON.stringify(holdings.body), { status: holdings.status });
  }) as typeof fetch;
  const popup = { closed: false, location: { href: "" } } as unknown as Window & { closed: boolean };
  const send = (data: unknown) => {
    for (const l of [...listeners]) l({ source: popup, data } as unknown as MessageEvent);
  };
  return { listeners, calls, popup, send };
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  delete (globalThis as { window?: unknown }).window;
});

const tick = () => new Promise((r) => setTimeout(r, 0));

test("the done page's message ends the wait, then onReading fires and the holdings are read", async () => {
  const s = stage({ status: 200, body: { holdings: [{ ticker: "AAPL", name: "Apple" }] } });
  const steps: string[] = [];
  const done = importBrokerHoldings(s.popup, {}, { onReading: () => steps.push("reading") });
  await tick();
  assert.equal(s.popup.location.href, "https://snaptrade.example/connect");
  assert.equal(s.listeners.size, 1);
  s.send({ type: "falcon:broker", ok: true, ticket: "t1" });
  assert.deepEqual(await done, { holdings: [{ ticker: "AAPL", name: "Apple" }], import: undefined });
  assert.deepEqual(steps, ["reading"]);
  assert.equal(s.listeners.size, 0, "no listener left behind");
});

test("cancelling while the window is open removes the listener, reads nothing and rejects with an AbortError", async () => {
  const s = stage({ status: 200, body: { holdings: [] } });
  const ac = new AbortController();
  const steps: string[] = [];
  const done = importBrokerHoldings(s.popup, {}, { signal: ac.signal, onReading: () => steps.push("reading") });
  await tick();
  assert.equal(s.listeners.size, 1);
  ac.abort();
  await assert.rejects(done, (err: unknown) => err instanceof DOMException && err.name === "AbortError");
  assert.equal(s.listeners.size, 0, "the popup listener is gone");
  assert.deepEqual(steps, []);
  assert.deepEqual(s.calls, ["/api/portfolio/broker/start"], "the holdings route is never called");
});

test("the window closing before it finished is null, as before", async () => {
  const s = stage({ status: 409, body: { error: "not finished" } });
  const done = importBrokerHoldings(s.popup, {});
  await tick();
  s.popup.closed = true;
  assert.equal(await done, null);
  assert.equal(s.listeners.size, 0);
});

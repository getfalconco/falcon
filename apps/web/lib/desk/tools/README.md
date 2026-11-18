# Desk data tools

Tools the Desk AI (Claude Opus 5.5, `/api/desk/chat`) calls on its own. Server-only; in-memory caches only (works in a Netlify function).

| Tool | What it returns | Source |
|---|---|---|
| `quote` | last price, change, previous close, day range, volume, 52-week range, market cap, market state, time (ET), after-hours / pre-market | Yahoo v7 quote (crumb), v8 chart as fallback |
| `history` | start/end, price and total return, high/low with dates, max drawdown, volatility, avg volume, up to 120 closes | Yahoo v8 chart (daily; weekly for 10y/max) |
| `fundamentals` | revenue TTM / 4 quarters / 4 years, margins, diluted EPS, shares, cash, debt, market cap, P/E, P/S, EV/EBITDA, each with its period | SEC XBRL company facts + Yahoo price |
| `earnings` | last 8 quarters (date, before/after market, EPS estimate/actual/surprise), next date and consensus | Yahoo earnings archive + quoteSummary |
| `filings` | filing list (form filter, 8-K items spelled out) or EDGAR full-text search | SEC submissions, efts.sec.gov |
| `filing_text` | bounded excerpt of one filing around a query, section headings, the filing's exhibits | SEC archive |
| `insiders` | open-market Form 4 buys/sells per insider, 10b5-1 and routine (CMP) trades set aside, cluster flags | SEC Form 4 XML (engine F7 rules) |

```ts
import { DESK_TOOLS, deskToolLabel, runDeskTool } from "@/lib/desk/tools";
```

- `DESK_TOOLS`: `Anthropic.Beta.BetaTool[]`, fixed order (it is part of the cached prompt prefix).
- `runDeskTool(name, input, { signal, timeoutMs })` never throws. It returns `{ ok, content, label, ms }`; `content` is JSON of at most about 4k tokens, `{ "error": "..." }` when `ok` is false.
- `deskToolLabel(name, input, "running" | "done")`: "Looking up AAPL quote" / "Looked up AAPL quote".

## Wiring into the chat route (not applied yet)

1. **Request.** Add `tools: DESK_TOOLS` to `client.beta.messages.stream(...)`. Keep `tool_choice` on auto: Opus 5.5 returns 400 for a forced `any` or `tool` choice. Tool inputs are tiny, so `eager_input_streaming` is not needed. Tools render before `system`, so the system block's `cache_control` covers them too.
2. **Loop, up to 6 rounds.** Stream each round and forward `text_delta` text as today, then `await stream.finalMessage()`:
   - On `stop_reason === "tool_use"`, collect every `tool_use` block. Several in one turn is normal; run them in parallel with `Promise.all(blocks.map((b) => runDeskTool(b.name, b.input, { signal, timeoutMs })))`.
   - Append the assistant turn with `msg.content` **unchanged**. Thinking blocks must go back as they came (preserved thinking).
   - Then append **one** user message holding all the `tool_result` blocks: `{ type: "tool_result", tool_use_id, content: r.content, is_error: !r.ok }`. Splitting them over several messages teaches the model to stop calling tools in parallel.
   - Stop on `end_turn`. On `refusal` or `max_tokens`, never run that turn's tools.
   - On the 6th round, or when time is short, send `tool_choice: { type: "none" }` so the model has to answer with what it has. Don't remove `tools`: that would break the cache.
3. **Deadline.** The route's 50 s `DEADLINE_MS` covers the whole loop. Per round, set `timeoutMs = min(9_000, remaining - 15_000)`, leaving about 15 s to stream the final answer. If that is under about 3 s, don't run the tools: return `{ error: "out of time" }` results with `is_error: true` and make the next round `tool_choice: none`. Pass `request.signal` (combined with the deadline) as `signal`.
4. **System prompt (lib/desk/system.ts).** Replace "You do not have live market data or the filings themselves..." with guidance to use the tools for any current figure or filing content, state the source and as-of time or period of each number, quote filings only from `filing_text` excerpts, and say so when a tool returns an error instead of guessing. Keep the hard limits as they are.
5. **Logging.** Log one line per call (`name`, `ok`, `ms`) next to the route's existing log. Inputs are tickers and URLs, never member data.

### Tool activity in the UI

The reply is a plain-text stream, with `\u001e` already reserved for errors. Tool activity can share that stream through a second control character, e.g. `\u001d`, followed by one JSON line:

```
\u001d{"id":"toolu_01..","state":"running","label":"Looking up AAPL quote"}\n
\u001d{"id":"toolu_01..","state":"done","label":"Looked up AAPL quote","ok":true,"ms":412}\n
```

- The route writes `running` (`deskToolLabel(name, input, "running")`) just before `runDeskTool`, and `done` with `r.label` and `ok` once it returns.
- The client (lab/sessions.ts) strips these lines from the text. It shows "Looking up AAPL quote…" as a muted line with a spinner while running, then a quiet "Looked up AAPL quote" (or the error state) above the answer.
- Old clients that don't know `\u001d` would print the lines, so ship the client parser first or together with the route change.

## Limits

- Yahoo endpoints are unofficial: fields can change or the crumb can fail, and its terms forbid automated commercial use. It is a stand-in until a licensed feed. The quote may be delayed up to 15 min. The earnings archive stops in mid 2025, and the summary covers only the last 4 quarters, so one quarter in between can be missing (the result says so).
- XBRL: concepts vary by filer (the most recent of several candidate tags is used). Q4 and cash-flow quarters are derived from year-to-date figures and marked `derived`. Foreign filers (20-F/40-F, IFRS) usually have annual figures only, and multiples are skipped when the filing currency differs from the price currency. Banks and insurers have no gross margin. EV leaves out leases and minority interest.
- EDGAR: acceptance times are not reported (only filing dates). The engine has the clock rules if they are needed. Full-text search defaults to the last 3 years.
- Insiders: reads the newest 40 Form 4s in the window. Routine checks come from each insider's own filing list (one SEC request per insider). Business days are weekdays (holidays not skipped). Amendments (4/A) are not read.

## Checks

```bash
cd apps/web && node_modules/.bin/tsc --noEmit -p .
cd apps/web && node_modules/.bin/next lint --dir lib/desk/tools
cd packages/engine && node --import tsx --test ../../apps/web/lib/desk/tools/tools.test.ts   # mocked fetch
cd packages/engine && node --import tsx ../../apps/web/lib/desk/tools/live.ts AAPL NVDA     # live, dev only
```

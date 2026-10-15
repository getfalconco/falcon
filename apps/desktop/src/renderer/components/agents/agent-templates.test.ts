import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Agent } from "../../../shared/agent-types";
import * as area from "../../lib/i18n/messages/areas/agents";
import { bannedWordHits, textProblems } from "../../../shared/copy-rules";
import type { AgentDraft } from "../../../shared/agent-types";
import { deliverySentence, endsSentence, firstStatusLine, nextCheckPhrase, suggestedName, understanding, watchedTickers } from "./agent-format";
import { EXAMPLE_TICKERS, buildStarterTemplates, starterBrief, starterTitle } from "./agent-templates";

const NONE = { held: [], watchlist: [], reporting: [], tracked: [] };

describe("starters from what the reader holds", () => {
  it("offers what the engine can watch: results, filings, insider purchases, linked companies, filing changes", () => {
    assert.deepEqual(
      buildStarterTemplates(NONE).map((t) => t.id),
      ["earnings", "filings", "insider", "linked", "changes"],
    );
  });

  it("puts a holding not used above in the filing changes starter, as a title only, and its words read as the trigger", () => {
    const list = buildStarterTemplates({ held: ["NVDA", "AMD", "MSFT", "SMCI"], watchlist: [], reporting: [], tracked: [] });
    const changes = list.find((t) => t.id === "changes")!;
    assert.deepEqual(changes, { id: "changes", ticker: "SMCI", example: false });
    assert.equal(starterTitle(changes, "en-US"), "Filing changes at SMCI");
    const { text, select } = starterBrief(changes, "en-US");
    assert.equal(text, "Tell me when SMCI's next 10-K or 10-Q has a new risk factor, a material weakness, an auditor change, or a newly named customer.");
    assert.equal(text.slice(select![0], select![1]), "SMCI");
    assert.equal(starterTitle(buildStarterTemplates(NONE).find((t) => t.id === "changes")!, "en-US"), "Filing changes, e.g. SMCI");
  });

  it("puts a holding's suppliers and customers in the linked starter, as a title only", () => {
    const list = buildStarterTemplates({ held: ["AMKR"], watchlist: ["TSM"], reporting: [], tracked: [] });
    const linked = list.find((t) => t.id === "linked")!;
    assert.deepEqual(linked, { id: "linked", ticker: "AMKR", example: false });
    assert.equal(starterTitle(linked, "en-US"), "Suppliers and customers of AMKR");
    const { text, select } = starterBrief(linked, "en-US");
    assert.equal(text, "Tell me when any of AMKR's critical suppliers or customers files an 8-K or reports results.");
    assert.equal(text.slice(select![0], select![1]), "AMKR");
  });

  it("builds on held names: results of the held name that reports soonest", () => {
    const list = buildStarterTemplates({
      held: ["msft", "AMD", "NVDA"],
      watchlist: ["TSLA"],
      reporting: [
        { ticker: "TSLA", date: "2026-10-20", watchlist: true },
        { ticker: "NVDA", date: "2026-11-19", held: true },
        { ticker: "AMD", date: "2026-11-04", held: true },
      ],
      tracked: [],
    });
    assert.deepEqual(list[0], { id: "earnings", ticker: "AMD", example: false, date: "2026-11-04" });
    assert.ok(list.every((t) => !t.example));
    assert.equal(new Set(list.map((t) => t.ticker)).size, 3, "a different holding for each when there are enough");
    assert.ok(list.slice(1).every((t) => ["MSFT", "NVDA"].includes(t.ticker)), "filings and insider purchases come from holdings first");
  });

  it("falls back to a followed name when no holding reports soon", () => {
    const list = buildStarterTemplates({ held: [], watchlist: ["TSLA"], reporting: [{ ticker: "TSLA", date: "2026-10-20" }], tracked: [] });
    assert.deepEqual(list[0], { id: "earnings", ticker: "TSLA", example: false, date: "2026-10-20" });
    assert.equal(list[1]!.ticker, "TSLA");
  });

  it("uses the reader's own name even with no report on the calendar", () => {
    const list = buildStarterTemplates({ held: ["AAPL"], watchlist: [], reporting: [], tracked: [] });
    assert.deepEqual(list[0], { id: "earnings", ticker: "AAPL", example: false });
  });

  it("without holdings or a watchlist: the tracked names that report soonest, marked as examples", () => {
    const list = buildStarterTemplates({
      ...NONE,
      tracked: [
        { ticker: "AVGO", date: "2026-12-11" },
        { ticker: "ORCL", date: "2026-10-16" },
        { ticker: "JPM", date: "2026-10-17" },
      ],
    });
    assert.deepEqual(
      list.map((t) => [t.id, t.ticker, t.example]),
      [
        ["earnings", "ORCL", true],
        ["filings", "JPM", true],
        ["insider", "AVGO", true],
        ["linked", EXAMPLE_TICKERS.linked, true],
        ["changes", EXAMPLE_TICKERS.changes, true],
      ],
    );
  });

  it("and with nothing at all, fixed examples", () => {
    assert.deepEqual(
      buildStarterTemplates(NONE).map((t) => [t.ticker, t.example]),
      [
        [EXAMPLE_TICKERS.earnings, true],
        [EXAMPLE_TICKERS.filings, true],
        [EXAMPLE_TICKERS.insider, true],
        [EXAMPLE_TICKERS.linked, true],
        [EXAMPLE_TICKERS.changes, true],
      ],
    );
  });

  it("says e.g. on an example chip and the name on the reader's own; the brief carries the ticker, selected", () => {
    const [own] = buildStarterTemplates({ held: ["AMD"], watchlist: [], reporting: [], tracked: [] });
    const [example] = buildStarterTemplates(NONE);
    assert.equal(starterTitle(own!, "en-US"), "Earnings of AMD");
    assert.equal(starterTitle(example!, "en-US"), "Earnings watch, e.g. NVDA");
    const { text, select } = starterBrief(own!, "en-US");
    assert.ok(text.startsWith("When AMD reports"));
    assert.deepEqual(text.slice(select![0], select![1]), "AMD");
  });
});

const AGENT: Agent = {
  id: "agent-abc123",
  name: "NVDA earnings",
  brief: "Tell me when NVDA reports.",
  ticker: "NVDA",
  triggers: [{ kind: "earnings", ticker: "NVDA", moment: "release" }],
  metrics: [],
  channels: ["digest"],
  status: "active",
  oneShot: true,
  ends: { kind: "earnings", ticker: "NVDA" },
  createdAt: "2026-10-15T14:00:00.000Z",
  updatedAt: "2026-10-15T14:00:00.000Z",
  unread: 0,
};

describe("the first status line after create", () => {
  // 2026-10-15 10:00 in New York.
  const now = Date.parse("2026-10-15T14:00:05.000Z");

  it("says the first check is running until the engine has checked", () => {
    assert.equal(firstStatusLine(AGENT, now, "en-US"), "Watching NVDA. First check running.");
  });

  it("then says what it found and when it looks again, from the engine's own times", () => {
    const checked: Agent = { ...AGENT, lastCheckedAt: "2026-10-15T14:00:02.000Z", nextCheckAt: "2026-10-16T12:00:00.000Z" };
    assert.equal(firstStatusLine(checked, now, "en-US"), "Watching NVDA. First check now: nothing yet. Next check: tomorrow 08:00 ET.");
  });

  it("is gone once the agent has reported, or when it is not running", () => {
    assert.equal(firstStatusLine({ ...AGENT, lastFiredAt: "2026-10-16T12:00:00.000Z" }, now, "en-US"), null);
    assert.equal(firstStatusLine({ ...AGENT, status: "paused" }, now, "en-US"), null);
  });

  it("says a near check in minutes, a far one by weekday or date", () => {
    assert.equal(nextCheckPhrase("2026-10-15T14:15:05.000Z", now, "en-US"), "in 15 minutes");
    assert.equal(nextCheckPhrase("2026-10-15T18:30:00.000Z", now, "en-US"), "today 14:30 ET");
    assert.match(nextCheckPhrase("2026-10-18T12:00:00.000Z", now, "en-US")!, /^Sunday 08:00 ET$/);
  });

  it("says what a company-less agent watches instead of a ticker", () => {
    const topic: Agent = {
      ...AGENT,
      ticker: undefined,
      triggers: [{ kind: "schedule", cadence: "weekdays", time: "08:00", keywords: ["semiconductor", "supplier"] }],
      lastCheckedAt: "2026-10-15T14:00:02.000Z",
      nextCheckAt: "2026-10-16T12:00:00.000Z",
    };
    assert.equal(
      firstStatusLine(topic, now, "en-US"),
      "Watching news mentioning semiconductor or supplier. First check now: nothing yet. Next check: tomorrow 08:00 ET.",
    );
    const market: Agent = { ...topic, triggers: [{ kind: "schedule", cadence: "daily", time: "08:00" }] };
    assert.ok(firstStatusLine(market, now, "en-US")!.startsWith("Watching the market."));
    const cpi: Agent = { ...topic, triggers: [{ kind: "macro", event: "CPI" }] };
    assert.ok(firstStatusLine(cpi, now, "en-US")!.startsWith("Watching CPI."));
  });

  it("names every ticker watched, once", () => {
    assert.deepEqual(watchedTickers({ ticker: "nvda", triggers: [...AGENT.triggers, { kind: "filing", ticker: "TSM", forms: ["8-K"] }] }), ["NVDA", "TSM"]);
  });
});

describe("delivery and the end, as the confirm card says them", () => {
  it("in the app always, plus the daily digest by default", () => {
    assert.equal(deliverySentence(["digest"], "en-US"), "In the app, plus a daily digest at 08:00");
    assert.equal(deliverySentence([], "en-US"), "In the app only");
    assert.equal(deliverySentence(["digest", "desktop"], "en-US"), "In the app, plus a daily digest at 08:00 and a notification for each report");
  });

  it("an end for each kind, and plain words for an agent stored before ends existed", () => {
    assert.equal(endsSentence({ kind: "earnings", ticker: "NVDA" }, "en-US"), "After NVDA reports");
    assert.equal(endsSentence({ kind: "filing", ticker: "AAPL", form: "10-K" }, "en-US"), "After the next AAPL 10-K");
    assert.match(endsSentence({ kind: "date", date: "2027-01-13" }, "en-US"), /^After Jan 13, 2027$/);
    assert.equal(endsSentence(undefined, "en-US"), "Not set: runs until you remove it");
  });
});

const BASE: Pick<AgentDraft, "metrics" | "channels" | "oneShot" | "notes"> = { metrics: [], channels: ["digest"], oneShot: false, notes: [] };

describe("Did we understand you? The reading, in plain sentences", () => {
  it("a scheduled topic digest about no one company", () => {
    const r = understanding(
      { ...BASE, triggers: [{ kind: "schedule", cadence: "weekdays", time: "08:00", keywords: ["semiconductor", "supplier"] }], ends: { kind: "date", date: "2027-01-13" }, endsProposed: true },
      "en-US",
    );
    assert.deepEqual(r.lines, [
      "It watches news mentioning semiconductor or supplier.",
      "It writes to you every weekday at 08:00.",
      "Each report says what happened, with the numbers that matter.",
      "You get it in the app, plus a daily digest at 08:00.",
      "It ends after Jan 13, 2027. That end is a suggestion; you can change it under Adjust details.",
    ]);
    assert.equal(r.note, null);
  });

  it("a one-report results watch with named numbers", () => {
    const r = understanding(
      {
        ...BASE,
        ticker: "NVDA",
        triggers: [{ kind: "earnings", ticker: "NVDA", moment: "release" }],
        metrics: [{ id: "m1", label: "Gross margin" }, { id: "m2", label: "Data center revenue" }],
        oneShot: true,
        ends: { kind: "earnings", ticker: "NVDA" },
        notes: ["Assumed the release, not the call."],
      },
      "en-US",
    );
    assert.deepEqual(r.lines, [
      "It watches NVDA earnings.",
      "It writes to you when NVDA publishes quarterly results.",
      "Each report covers gross margin and data center revenue.",
      "You get it in the app, plus a daily digest at 08:00.",
      "It sends one report, then ends.",
    ]);
    assert.equal(r.note, "One thing to check: Assumed the release, not the call.");
  });

  it("market news and a macro release, in the app only, says it looks at what it actually runs on", () => {
    const market = understanding({ ...BASE, channels: [], triggers: [{ kind: "news", keywords: [] }], ends: { kind: "date", date: "2027-01-13" } }, "en-US");
    assert.equal(market.lines[0], "It watches market news.");
    assert.equal(market.lines[1], "It writes to you when there is news.");
    assert.equal(market.lines[3], "You get it in the app only.");
    const cpi = understanding({ ...BASE, triggers: [{ kind: "macro", event: "CPI" }], ends: { kind: "date", date: "2027-01-13" } }, "en-US");
    assert.deepEqual(cpi.lines.slice(0, 2), ["It watches CPI.", "It writes to you when CPI comes out."]);
    const digest = understanding({ ...BASE, triggers: [{ kind: "schedule", cadence: "daily", time: "07:30" }], ends: { kind: "date", date: "2027-01-13" } }, "en-US");
    assert.equal(digest.lines[0], "It looks at the market as a whole.");
  });

  it("reads in every language, with no dashes", () => {
    for (const lang of ["tr-TR", "de-DE", "fr-FR", "es-ES", "it-IT", "pt-BR", "ja-JP", "zh-CN", "ko-KR"] as const) {
      const r = understanding({ ...BASE, triggers: [{ kind: "news", keywords: ["chip"] }], ends: { kind: "date", date: "2027-01-13" }, endsProposed: true }, lang);
      assert.equal(r.lines.length, 5, lang);
      for (const l of r.lines) assert.ok(!/[\u2013\u2014]/.test(l) && !l.includes("{"), `${lang}: ${l}`);
    }
  });
});

describe("the Earnings tab's Create agent", () => {
  it("prefills a name from the instruction when none comes with it", () => {
    assert.equal(suggestedName("When NVDA reports, tell me how it went.", "en-US"), "NVDA earnings");
    assert.equal(suggestedName("tell me about chip suppliers", "en-US"), "");
  });
});

describe("brand words in the new create flow", () => {
  const NEW_KEYS = Object.keys(area.en).filter((k) =>
    /^agents\.(wizard\.(stepOf|placeholder|blocked|startersOwn|nameLabel|namePlaceholder|instructionLabel|examples)|clarify|confirm|understand|endsKind|ends\.|deliveryLine|deliveryPart|dailyDigest|form\.digestHint|when\.|first\.|starter\.|noun\.(keywordNews|marketNews)|line\.(next\.ended|activity\.ended|delivery\.digest|news\.watchingMarket))/.test(k),
  );
  const TABLES = [area.en, area.tr, area.de, area.fr, area.es, area.it, area.ptBR, area.ja, area.zhCN, area.ko] as const;

  it("covers the new lines", () => {
    assert.ok(NEW_KEYS.length >= 60, `found ${NEW_KEYS.length}`);
  });

  it("never says AI, edge, buy, will or signal, and has no dashes, in English", () => {
    for (const key of NEW_KEYS) {
      const text = (area.en as Record<string, string>)[key]!;
      assert.deepEqual(bannedWordHits(text, ["AI", "edge", "buy", "buying", "will", "signal", "signals"]), [], `${key}: ${text}`);
      assert.deepEqual(textProblems(text, { riskWords: true }), [], `${key}: ${text}`);
    }
  });

  it("never says AI and has no dashes in any language; the placeholder starts with an example marker", () => {
    for (const table of TABLES) {
      for (const key of NEW_KEYS) {
        const text = (table as Record<string, string>)[key]!;
        assert.ok(text?.trim(), key);
        assert.ok(!/\bAI\b/.test(text), `${key}: ${text}`);
        assert.ok(!/[–—]/.test(text), `${key}: ${text}`);
      }
    }
    assert.ok((area.en as Record<string, string>)["agents.wizard.placeholder"]!.startsWith("e.g. "));
  });

  it("says why Next waits, in every language", () => {
    for (const table of TABLES) assert.ok((table as Record<string, string>)["agents.wizard.blocked.describe"]?.trim());
    assert.equal((area.en as Record<string, string>)["agents.wizard.blocked.describe"], "Write what you want it to do first");
    assert.equal((area.en as Record<string, string>)["agents.wizard.blocked.name"], "Give the agent a name first");
  });
});

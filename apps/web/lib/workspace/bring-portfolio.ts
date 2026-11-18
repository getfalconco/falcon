/**
 * "Bring your portfolio": the panel the setup card's "Get started" opens in
 * front of the frosted backdrop (app/app/_components/tabs/BringPortfolio.tsx).
 * Pure: the steps, what each says and offers, and the result of an import.
 * The steps follow the real flows in OwnCard.tsx and lib/portfolio-client.ts:
 *
 *   choose    the three ways in (broker, screenshot, paper account)
 *   paper     the paper account form (starting balance, name; lib/paper-account.ts)
 *   opening   the SnapTrade window is open (openBrokerWindow): the link is
 *             being fetched or the member is finishing there
 *   blocked   the browser blocked that window
 *   reading   the window came back or closed and the holdings are being read
 *             (importBrokerHoldings' onReading), or a screenshot is being read
 *   done      holdings came back (or the demo was added) and went into the portfolio
 *   cancelled the SnapTrade window closed before finishing
 *   error     a thrown message, or nothing came back
 *   preview   the preview has no account, so nothing is called
 */

export type ImportSource = "broker" | "screenshot";

export type PortfolioStage =
  | { step: "choose" }
  | { step: "paper" }
  | { step: "opening" }
  | { step: "blocked" }
  | { step: "reading"; source: ImportSource }
  | { step: "done"; title: string; text: string; tickers: string[]; paper?: true }
  | { step: "cancelled" }
  | { step: "error"; source: ImportSource; text: string }
  | { step: "preview"; source: ImportSource };

/** Buttons under a step; the first is the primary one. */
export type StageAction = "cancel" | "reopen" | "retry" | "back" | "done";

export type StageView = {
  title: string;
  body: string;
  tone: "busy" | "ok" | "problem" | "info";
  actions: StageAction[];
  /** Closes the panel by itself after this long, when set. */
  autoCloseMs?: number;
};

export const DONE_AUTO_CLOSE_MS = 1200;

export const ACTION_LABEL: Record<StageAction, string> = {
  cancel: "Cancel",
  reopen: "Open it again",
  retry: "Try again",
  back: "Back",
  done: "Done",
};

/** What a step other than "choose" shows in place of the rows. */
export function stageView(stage: Exclude<PortfolioStage, { step: "choose" }>): StageView {
  switch (stage.step) {
    case "paper":
      // The form draws itself (BringPortfolio.tsx PaperForm); this is only its title for anything that asks.
      return { title: "Create a paper account", body: "", tone: "info", actions: ["back"] };
    case "opening":
      return {
        title: "Connecting your broker",
        body: "A secure SnapTrade window opened. Finish there to link your account.",
        tone: "busy",
        actions: ["cancel"],
      };
    case "blocked":
      return {
        title: "The broker window was blocked",
        body: "Your browser blocked the SnapTrade window. Allow pop-ups for this site to connect your broker.",
        tone: "problem",
        actions: ["reopen", "back"],
      };
    case "reading":
      return {
        title: stage.source === "broker" ? "Reading your holdings…" : "Reading your screenshot…",
        body: "Your positions and account balances go into your portfolio.",
        tone: "busy",
        actions: ["cancel"],
      };
    case "done":
      return { title: stage.title, body: stage.text, tone: "ok", actions: ["done"], autoCloseMs: DONE_AUTO_CLOSE_MS };
    case "cancelled":
      return {
        title: "Connection cancelled",
        body: "The SnapTrade window closed before the connection finished.",
        tone: "problem",
        actions: ["retry", "back"],
      };
    case "error":
      return {
        title: stage.source === "broker" ? "We couldn't connect your broker" : "We couldn't read your screenshot",
        body: stage.text,
        tone: "problem",
        actions: ["retry", "back"],
      };
    case "preview":
      return {
        title: stage.source === "broker" ? "Connect your broker" : "Drop a screenshot",
        body:
          stage.source === "broker"
            ? "Sign in to connect a broker. The preview has no account."
            : "Sign in to upload a screenshot. The preview has no account.",
        tone: "info",
        actions: ["back"],
      };
  }
}

const EMPTY: Record<ImportSource, string> = {
  broker: "No holdings came back from your broker. Try again or upload a screenshot.",
  screenshot: "We couldn't find any tickers in that screenshot.",
};

const count = (n: number) => (n === 1 ? "1 ticker" : `${n} tickers`);

/**
 * What an import's holdings lead to: the done step (its text is the card's imported message), or the error when none
 * came back. `summary` is the import's own line ("Added 12 positions and 2 account balances.", importSummary in
 * lib/portfolio-holdings.ts) when the route sent the full import.
 */
export function importStage(source: ImportSource, holdings: readonly { ticker: string }[] | undefined, summary?: string): PortfolioStage {
  if (!holdings?.length) return { step: "error", source, text: EMPTY[source] };
  return {
    step: "done",
    title: "Holdings added",
    text: summary ?? `Added ${count(holdings.length)} from your ${source} to your portfolio.`,
    tickers: Array.from(new Set(holdings.map((h) => h.ticker))),
  };
}

/** The done step after "Look around first": the paper portfolio's tickers it put in the portfolio (internally "demo"). */
export function demoStage(added: readonly string[]): PortfolioStage {
  return {
    step: "done",
    title: "Paper portfolio added",
    text: added.length
      ? `Added ${added.length === 1 ? "1 paper ticker" : `${added.length} paper tickers`} to your portfolio.`
      : "The paper portfolio's tickers are already in your portfolio.",
    tickers: [...added],
  };
}

/** The tickers shown on the done step: the first `max`, and how many more. */
export function shownTickers(tickers: readonly string[], max = 12): { shown: string[]; more: number } {
  return { shown: tickers.slice(0, max), more: Math.max(0, tickers.length - max) };
}

/** Pure: the image among dropped files, if any (the screenshot reader's types). */
export function droppedImage<T extends { type: string; name: string }>(files: readonly T[]): T | null {
  return files.find((f) => f.type.startsWith("image/") || /\.(png|jpe?g|webp|hei[cf])$/i.test(f.name)) ?? null;
}

/** The done step after the paper form: "Paper account created · $100,000", closing by itself like an import. */
export function paperStage(balance: number): PortfolioStage {
  return {
    step: "done",
    title: `Paper account created · $${Math.round(balance).toLocaleString("en-US")}`,
    text: "Cash only, no positions yet. It shows on your Dashboard with a Paper badge.",
    tickers: [],
    paper: true,
  };
}

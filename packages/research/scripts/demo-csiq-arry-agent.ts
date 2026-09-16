import {
  fallbackAgentSuggestionFromTrackRequest,
  isShallowAgentSuggestion,
  splitFollowUpAgentSuggestion,
} from "../src/dailySignal/signalFollowUpAgentSuggestion.js";

const msg =
  "make an agent that tracks upcoming earnings reports for CSIQ and ARRY, particularly focusing on their order backlog and book-to-bill ratios, to see how deeply they are affected by this slowdown";

const shallowJson = {
  agentSuggestion: {
    show: true,
    ticker: "CSIQ",
    tickers: ["CSIQ"],
    metrics: [],
    goal: "",
    promptQuestion:
      "Would you like to set up an automated agent to track CSIQ and ARRY earnings dates?",
  },
};

const richJson = {
  agentSuggestion: {
    show: true,
    tickers: ["CSIQ", "ARRY"],
    ticker: "CSIQ",
    metrics: ["order backlog", "book-to-bill ratio"],
    goal: "gauge how deeply CSIQ and ARRY are affected by the slowdown",
    promptQuestion:
      "Set up an agent to track CSIQ and ARRY's order backlog and book-to-bill ratios each earnings report, flagging how the slowdown is affecting them?",
  },
};

const shallow = splitFollowUpAgentSuggestion(
  `Analysis text.\n\n---MERIDIAN_AGENT_SUGGESTION---\n${JSON.stringify(shallowJson)}`,
);
const rich = splitFollowUpAgentSuggestion(
  `Analysis text.\n\n---MERIDIAN_AGENT_SUGGESTION---\n${JSON.stringify(richJson)}`,
);
const fallback = fallbackAgentSuggestionFromTrackRequest(msg, ["ARRY", "CSIQ"], "");

console.log("=== BEFORE (shallow — would trigger retry + fallback) ===");
console.log("Banner:", shallow.agentSuggestion?.promptQuestion);
console.log("isShallow:", isShallowAgentSuggestion(shallow.agentSuggestion!, msg, ["CSIQ", "ARRY"]));

console.log("\n=== AFTER (rich — correct) ===");
console.log("Banner:", rich.agentSuggestion?.promptQuestion);
console.log("tickers:", rich.agentSuggestion?.tickers);
console.log("metrics:", rich.agentSuggestion?.metrics);
console.log("goal:", rich.agentSuggestion?.goal);
console.log("isShallow:", isShallowAgentSuggestion(rich.agentSuggestion!, msg, ["CSIQ", "ARRY"]));

console.log("\n=== FALLBACK (if model still fails) ===");
console.log("Banner:", fallback?.promptQuestion);
console.log("tickers:", fallback?.tickers);
console.log("metrics:", fallback?.metrics);

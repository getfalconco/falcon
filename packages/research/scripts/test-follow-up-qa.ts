/**
 * Manual QA: run with OPENAI_API_KEY set.
 *   cd packages/research && npx tsx scripts/test-follow-up-qa.ts
 */
import {
  generateSignalFollowUp,
  SIGNAL_FOLLOW_UP_TEST_FIXTURE,
} from "../src/dailySignal/signalFollowUp.js";

const QUESTIONS = [
  "Do you think SpaceX is going to be a pump and dump?",
  "Will SpaceX and Rocket Lab be correlated?",
  "So what should I do?",
] as const;

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY not set — skipping live QA.");
    process.exit(1);
  }

  const { signal, analysisText } = SIGNAL_FOLLOW_UP_TEST_FIXTURE;
  const history: Array<{ role: "user" | "assistant"; content: string }> = [];

  for (const question of QUESTIONS) {
    console.log("\n" + "=".repeat(72));
    console.log(`Q: ${question}`);
    console.log("=".repeat(72));

    const answer = await generateSignalFollowUp({
      signal,
      analysisText,
      history,
      userMessage: question,
    });

    console.log("\nA:\n");
    console.log(answer.reply);
    if (answer.agentSuggestion) {
      console.log("\n[agentSuggestion]", answer.agentSuggestion);
    }

    history.push({ role: "user", content: question });
    history.push({ role: "assistant", content: answer.reply });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

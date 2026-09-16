import { registerIpcHandler } from "../ipc-register";
import { getInsightExplanation } from "./insight-explanation-service";
import { getPairExplanation } from "./pair-explanation-service";
import { askInsightChat } from "./insight-chat-service";
import type {
  InsightExplanationRequest,
  InsightExplanationResult,
} from "../../shared/insight-explanation";
import type {
  PairExplanationRequest,
  PairExplanationResult,
} from "../../shared/pair-explanation";
import type { InsightChatRequest, InsightChatResult } from "../../shared/insight-chat";

/**
 * Insight IPC. The key and the caches stay in main, as every provider call
 * does; the renderer only ever sees the finished paragraph.
 */
export function registerInsightHandlers(): void {
  registerIpcHandler(
    "insight:explanation",
    async (_event, request: InsightExplanationRequest): Promise<InsightExplanationResult> => {
      try {
        const { explanation, source } = await getInsightExplanation(request);
        return { ok: true, explanation, source };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[insight] explanation failed:", error);
        return { ok: false, error: message };
      }
    },
  );

  registerIpcHandler(
    "insight:pair-explanation",
    async (_event, request: PairExplanationRequest): Promise<PairExplanationResult> => {
      try {
        const { explanation, source } = await getPairExplanation(request);
        return { ok: true, explanation, source };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[insight] pair explanation failed:", error);
        return { ok: false, error: message };
      }
    },
  );

  registerIpcHandler(
    "insight:chat",
    async (_event, request: InsightChatRequest): Promise<InsightChatResult> => {
      try {
        return { ok: true, reply: await askInsightChat(request) };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[insight] chat failed:", error);
        return { ok: false, error: message };
      }
    },
  );
}

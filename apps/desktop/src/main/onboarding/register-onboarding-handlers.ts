import { registerIpcHandler } from "../ipc-register";
import { submitOnboardingSurvey } from "./onboarding-service";
import type { OnboardingSurveyAnswers } from "../../shared/onboarding-survey";

export function registerOnboardingHandlers(): void {
  registerIpcHandler(
    "onboarding:submit-survey",
    async (_event, payload: { answers: OnboardingSurveyAnswers; accessToken: string }) =>
      submitOnboardingSurvey(payload),
  );
}

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { app } from "electron";
import type { OnboardingSurveyAnswers } from "../../shared/onboarding-survey";

type LocalOnboardingFile = {
  byUserId: Record<string, OnboardingSurveyAnswers & { updatedAt: string }>;
};

function userDataPath(filename: string): string {
  return path.join(app.getPath("userData"), filename);
}

async function readJsonFile<T>(filename: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(userDataPath(filename), "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function writeJsonFile<T>(filename: string, data: T): Promise<void> {
  const filePath = userDataPath(filename);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
}

export async function upsertLocalOnboardingResponse(
  userId: string,
  answers: OnboardingSurveyAnswers,
): Promise<void> {
  const file = await readJsonFile<LocalOnboardingFile>("onboarding-responses.json", {
    byUserId: {},
  });
  file.byUserId[userId] = { ...answers, updatedAt: new Date().toISOString() };
  await writeJsonFile("onboarding-responses.json", file);
}

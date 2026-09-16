export function confidenceLabel(score: number): string {
  if (score >= 80) return "high";
  if (score >= 60) return "medium";
  return "low";
}

export function requiresCitation(score: number): boolean {
  return score > 80;
}

export function isInferredWithoutSource(score: number, hasSource: boolean): boolean {
  return score <= 60 && !hasSource;
}

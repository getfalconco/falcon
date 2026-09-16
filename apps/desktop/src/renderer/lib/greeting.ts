export function getTimeBasedGreeting(): string {
  const hour = new Date().getHours();
  if (hour >= 5 && hour <= 11) return "Good morning";
  if (hour >= 12 && hour <= 17) return "Good afternoon";
  return "Good evening";
}

export function getDashboardGreeting(): string {
  const hour = new Date().getHours();
  if (hour >= 5 && hour <= 11) return "Morning";
  if (hour >= 12 && hour <= 17) return "Afternoon";
  return "Evening";
}

export function firstNameFromDisplayName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "there";
  return trimmed.split(/\s+/)[0] ?? trimmed;
}

export function displayNameFromUser(
  metadata: Record<string, unknown> | undefined,
  email: string,
): string {
  const fullName = metadata?.full_name;
  if (typeof fullName === "string" && fullName.trim()) {
    return fullName.trim();
  }
  const localPart = email.split("@")[0]?.trim();
  return localPart || "there";
}

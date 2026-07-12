export function isLikelyModelId(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized.startsWith("gpt-") || normalized.startsWith("o1") || normalized.startsWith("o3");
}

export function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, milliseconds) / 1_000;
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];

  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (minutes > 0) {
    parts.push(`${minutes}m`);
  }
  parts.push(`${seconds.toFixed(1)}s`);

  return parts.join(" ");
}

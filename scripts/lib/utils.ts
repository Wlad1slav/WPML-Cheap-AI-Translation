export function isLikelyModelId(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized.startsWith("gpt-") || normalized.startsWith("o1") || normalized.startsWith("o3");
}
/** Existing chart hues, assigned once across the full account set before any filtering. */
export const USAGE_COLORS = ['#D97706', '#6366f1', '#10b981', '#4285f4', '#e11d48', '#8b5cf6'] as const
export function usageColors(identities: readonly string[]): Map<string, string> {
  return new Map([...new Set(identities)].sort().map((key, index) => [key, USAGE_COLORS[index % USAGE_COLORS.length]!]))
}

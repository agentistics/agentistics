/** Separated categorical hues, assigned once across the full account set before any filtering. */
export const USAGE_COLORS = ['#D97706', '#2563eb', '#16a34a', '#9333ea', '#db2777', '#0891b2'] as const
export function usageColors(identities: readonly string[]): Map<string, string> {
  return new Map([...new Set(identities)].sort().map((key, index) => [key, USAGE_COLORS[index % USAGE_COLORS.length]!]))
}

/** No observed chart line: do not imply a coloured series exists. */
export const USAGE_NO_READING_COLOR = '#94a3b8'

/** Attach host startup health without dropping or rewriting any usage rows. */
export function harnessesTool(
  rows: unknown,
  body: { harnesses?: Record<string, { spawnable: boolean; unavailableReason?: string }> },
): unknown {
  if (!Array.isArray(rows)) return rows;
  return rows.map(row => ({ ...row, ...body.harnesses?.[row.harness] }));
}

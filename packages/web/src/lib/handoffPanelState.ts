/** Closing a warning is temporary; only settings disable it permanently. */
export function handoffReminderDue(now: number, dismissAt: number, remindTokens: number | null, contextTokens: number | null): boolean {
  return now - dismissAt >= 10 * 60_000 || (remindTokens !== null && contextTokens !== null && contextTokens >= remindTokens)
}

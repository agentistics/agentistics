/** Explicit, one-message task registration; absence never authorizes a board write. */
export interface ComposerTaskOptions {
  priority: 'urgent' | 'high' | 'medium' | 'low'
  dueDate?: string
}

export function validComposerTask(value: unknown): value is ComposerTaskOptions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  if (!['urgent', 'high', 'medium', 'low'].includes(String(v.priority))) return false
  if (v.dueDate === undefined) return true
  if (typeof v.dueDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v.dueDate)) return false
  const ms = Date.parse(v.dueDate + 'T12:00:00Z')
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === v.dueDate
}

/** Versioned patches of the dashboard build. Live process fields remain owned by their live feed. */
export interface DataPatch {
  base: string
  revision: string
  set: Record<string, unknown>
  remove: string[]
  sessions?: { upsert: Record<string, unknown>[]; remove: string[]; order: string[] }
}
const blocked = new Set(['__proto__', 'constructor', 'prototype'])
export function dataSessionKey(row: Record<string, unknown>): string {
  return JSON.stringify([row.harness, row.memberId, row.user, row.session_id])
}
export function planDataPatch(previous: Record<string, unknown>, next: Record<string, unknown>, base: string, revision: string): DataPatch {
  const set: Record<string, unknown> = {}
  const remove: string[] = []
  for (const [k, v] of Object.entries(next)) {
    if (k !== 'sessions' && !blocked.has(k) && JSON.stringify(previous[k]) !== JSON.stringify(v)) set[k] = v
  }
  for (const k of Object.keys(previous)) if (!(k in next) && !blocked.has(k)) remove.push(k)
  const oldRows = (previous.sessions ?? []) as Record<string, unknown>[]
  const newRows = (next.sessions ?? []) as Record<string, unknown>[]
  const old = new Map(oldRows.map(r => [dataSessionKey(r), r]))
  const current = new Map(newRows.map(r => [dataSessionKey(r), r]))
  const upsert = newRows.filter(r => JSON.stringify(old.get(dataSessionKey(r))) !== JSON.stringify(r))
  const removed = [...old.keys()].filter(k => !current.has(k))
  const order = newRows.map(dataSessionKey)
  const changed = upsert.length || removed.length || JSON.stringify(oldRows.map(dataSessionKey)) !== JSON.stringify(order)
  return { base, revision, set, remove, ...(changed ? { sessions: { upsert, remove: removed, order } } : {}) }
}
export function applyDataPatch<T extends object>(previous: T, revision: string | null, patch: DataPatch): T | null {
  if (!revision || patch.base !== revision || !patch.revision || !patch.set || !Array.isArray(patch.remove)) return null
  const result: Record<string, unknown> = { ...previous } as Record<string, unknown>
  for (const [key, value] of Object.entries(patch.set)) if (!blocked.has(key)) result[key] = value
  for (const key of patch.remove) if (!blocked.has(key)) delete result[key]
  if (patch.sessions) {
    const rows = new Map(((result.sessions ?? []) as Record<string, unknown>[]).map(r => [dataSessionKey(r), r]))
    for (const key of patch.sessions.remove) rows.delete(key)
    for (const row of patch.sessions.upsert) rows.set(dataSessionKey(row), row)
    if (patch.sessions.order.some(key => !rows.has(key))) return null
    result.sessions = patch.sessions.order.map(key => rows.get(key)!)
  }
  return result as T
}

/**
 * CAPTURED COPY of the v2.210.1 deliveries.json load/serialize path (`delivery/store.ts` at tag v2.210.1:
 * `validRecord`, `parseDeliveryDocStrict`, `serializeDeliveryDoc` and the rename-based write).
 *
 * It is a FIXTURE, frozen on purpose: it stands in for the OLDER BINARY a user may still have running next to
 * a newer one. The downgrade tests run a document written by the new code through it and assert what an old
 * writer keeps and what it drops. Do NOT update it when `store.ts` changes — that is the point of the copy.
 * (Spec 2026-11-13-entrega-garantida §2.7.)
 */
import { rename, writeFile } from 'node:fs/promises'

const PHASES = ['fila', 'executando', 'qa', 'ajuste', 'revisao_lider', 'pr_merge', 'ci', 'publicado', 'bloqueado']
const SAFE_ID = /^[A-Za-z0-9_.:-]{1,120}$/
const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

export interface OldDeliveryDoc {
  version: 1
  deliveries: Record<string, Record<string, unknown>>
  preserved?: Record<string, unknown>
  requestReminders?: Record<string, unknown>
}

/** v2.210.1 `validRecord` (`isPhase` = membership in the v2.210.1 phase list). */
function validRecord(v: unknown): v is Record<string, unknown> {
  if (!isRec(v)) return false
  return typeof v.subtaskId === 'string' && SAFE_ID.test(v.subtaskId) && typeof v.taskId === 'string'
    && PHASES.includes(v.phase as string)
    && Number.isInteger(v.revision) && (v.revision as number) >= 1
    && (v.phase !== 'bloqueado' || (PHASES.includes(v.origin as string) && isRec(v.block)))
    && isRec(v.gates) && Array.isArray(v.humanGates) && isRec(v.approvals) && Array.isArray(v.skips) && Array.isArray(v.history)
}

export function parseV2210(text: string): OldDeliveryDoc {
  const raw: unknown = JSON.parse(text)
  if (!isRec(raw)) throw new Error('the document is not an object')
  const out: OldDeliveryDoc = { version: 1, deliveries: {} }
  if (isRec(raw.requestReminders)) out.requestReminders = raw.requestReminders
  const d = isRec(raw.deliveries) ? raw.deliveries : {}
  const kept: Record<string, unknown> = isRec(raw.preserved) ? { ...raw.preserved } : {}
  for (const [id, r] of Object.entries(d)) {
    if (SAFE_ID.test(id) && validRecord(r) && r.subtaskId === id) out.deliveries[id] = r
    else kept[id] = r
  }
  if (Object.keys(kept).length) out.preserved = kept
  return out
}

export function serializeV2210(doc: OldDeliveryDoc): string {
  const deliveries: Record<string, unknown> = { ...doc.deliveries }
  const preserved: Record<string, unknown> = {}
  for (const [id, r] of Object.entries(doc.preserved ?? {})) { if (id in deliveries) preserved[id] = r; else deliveries[id] = r }
  return JSON.stringify({ version: 1, deliveries, ...(doc.requestReminders ? { requestReminders: doc.requestReminders } : {}), ...(Object.keys(preserved).length ? { preserved } : {}) }, null, 2) + '\n'
}

/** What the old binary does on any write: load, optionally mutate, serialize, atomic rename. */
export async function oldWriterRoundTrip(path: string, text: string, mutate?: (doc: OldDeliveryDoc) => void): Promise<string> {
  const doc = parseV2210(text)
  mutate?.(doc)
  const out = serializeV2210(doc)
  const tmp = `${path}.old.tmp`
  await writeFile(tmp, out, { mode: 0o600 })
  await rename(tmp, path)
  return out
}

/**
 * delivery/store.ts — the delivery records (one per subtask), `<dataDir>/deliveries.json`.
 *
 * Several processes write it (the server, a `agentop flow gate` in a CLI, an engine timer), so every
 * write is read-modify-write UNDER the cross-process `withFileLock` and lands by an atomic rename — a
 * reader never sees half a file. A record that does not parse back into the shape is dropped on read
 * (and the whole file is never "repaired" in place): a half-read delivery would let a phase be skipped.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { withFileLock } from '../sessions/file-lock'
import { isPhase, type DeliveryRecord } from './machine'

export interface DeliveryDoc { version: 1; deliveries: Record<string, DeliveryRecord> }

const SAFE_ID = /^[A-Za-z0-9_.:-]{1,120}$/
const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** PURE: a record is kept only when its load-bearing fields read back exactly. */
export function validRecord(v: unknown): v is DeliveryRecord {
  if (!isRec(v)) return false
  return typeof v.subtaskId === 'string' && SAFE_ID.test(v.subtaskId) && typeof v.taskId === 'string'
    && isPhase(v.phase) && Number.isInteger(v.revision) && (v.revision as number) >= 1
    && (v.phase !== 'bloqueado' || (isPhase(v.origin) && isRec(v.block)))
    && isRec(v.gates) && Array.isArray(v.humanGates) && isRec(v.approvals) && Array.isArray(v.skips) && Array.isArray(v.history)
}

/** PURE: parse the file's text; unreadable → empty doc, invalid records dropped. */
export function parseDeliveryDoc(text: string): DeliveryDoc {
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return { version: 1, deliveries: {} } }
  const out: DeliveryDoc = { version: 1, deliveries: {} }
  const d = isRec(raw) && isRec(raw.deliveries) ? raw.deliveries : {}
  for (const [id, r] of Object.entries(d)) if (SAFE_ID.test(id) && validRecord(r) && r.subtaskId === id) out.deliveries[id] = r
  return out
}

export interface DeliveryStore {
  readonly path: string
  read(): Promise<DeliveryDoc>
  get(subtaskId: string): Promise<DeliveryRecord | null>
  /** Read-modify-write under the lock. `fn` returns the value to hand back; mutations to `doc` are persisted. */
  update<T>(fn: (doc: DeliveryDoc) => T | Promise<T>): Promise<T>
}

export function defaultDeliveriesPath(): string {
  if (process.env.AGENTISTICS_DELIVERIES_FILE) return process.env.AGENTISTICS_DELIVERIES_FILE
  // Lazy: config.ts reads the environment once at import, and tests point it elsewhere first.
  const dir = process.env.AGENTISTICS_DIR ?? join(process.env.HOME ?? '', '.agentistics')
  return join(dir, 'deliveries.json')
}

export function createDeliveryStore(path = defaultDeliveriesPath()): DeliveryStore {
  const read = async (): Promise<DeliveryDoc> => {
    try { return parseDeliveryDoc(await readFile(path, 'utf8')) } catch { return { version: 1, deliveries: {} } }
  }
  return {
    path,
    read,
    async get(id) { return (await read()).deliveries[id] ?? null },
    async update(fn) {
      await mkdir(dirname(path), { recursive: true })
      return withFileLock(path, async () => {
        const doc = await read()
        const value = await fn(doc)
        const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
        await writeFile(tmp, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600 })
        await rename(tmp, path)
        return value
      })
    },
  }
}

/**
 * delivery/store.ts — the delivery records (one per subtask), `<dataDir>/deliveries.json`.
 *
 * Several processes write it (the server, a `agentop flow gate` in a CLI, an engine timer), so every
 * write is read-modify-write UNDER the cross-process `withFileLock` and lands by an atomic rename — a
 * reader never sees half a file.
 *
 * The file is NEVER "repaired" by overwriting it. Two ways a read can come back short, and a write must not turn
 * either into data loss:
 *   - the file is unreadable (a bad hand edit, EACCES, EMFILE, a torn copy): `readState` says `unreadable`, a write
 *     keeps a BACKUP of the bytes and REFUSES (`DeliveryStoreUnreadable`) — it never writes an empty document over it;
 *   - a record does not parse into this build's shape (a phase added by a newer build, after a downgrade): it is not
 *     offered to the callers (a half-read delivery would let a phase be skipped) but it is kept VERBATIM in
 *     `preserved` and written back with the rest.
 */
import { copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { withFileLock } from '../sessions/file-lock'
import { defaultGuardLockPaths, withGuardLocks } from './guard-locks'
import { isPhase, type DeliveryRecord } from './machine'

export interface DeliveryDoc {
  version: 1
  deliveries: Record<string, DeliveryRecord>
  /** Records this build cannot read, kept verbatim and written back. Never handed to a caller. */
  preserved?: Record<string, unknown>
  /** Delivered tombstones and retry clocks only. Requests stay in the engine's canonical pedidos document. */
  requestReminders?: Record<string, { at?: string; attemptedAt?: string; pendingAt?: string; leaderSessionId?: string }>
}

const SAFE_ID = /^[A-Za-z0-9_.:-]{1,120}$/
const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** A write was refused because the file on disk could not be read; the bytes were kept as `backup`. */
export class DeliveryStoreUnreadable extends Error {
  readonly code = 'store_ilegivel'
  constructor(readonly path: string, readonly backup: string | null, readonly why: string) {
    super(`deliveries.json is unreadable (${why}); writes are refused so nothing is lost${backup ? ` — a copy was kept at ${backup}` : ''}`)
  }
}

/** PURE: a record is kept only when its load-bearing fields read back exactly. */
export function validRecord(v: unknown): v is DeliveryRecord {
  if (!isRec(v)) return false
  return typeof v.subtaskId === 'string' && SAFE_ID.test(v.subtaskId) && typeof v.taskId === 'string'
    && isPhase(v.phase) && Number.isInteger(v.revision) && (v.revision as number) >= 1
    && (v.phase !== 'bloqueado' || (isPhase(v.origin) && isRec(v.block)))
    && isRec(v.gates) && Array.isArray(v.humanGates) && isRec(v.approvals) && Array.isArray(v.skips) && Array.isArray(v.history)
}

/** PURE: parse the file's text. Throws on text that is not a JSON object; unreadable records are PRESERVED, not dropped. */
export function parseDeliveryDocStrict(text: string): DeliveryDoc {
  const raw: unknown = JSON.parse(text)
  if (!isRec(raw)) throw new Error('the document is not an object')
  const out: DeliveryDoc = { version: 1, deliveries: {} }
  if (isRec(raw.requestReminders)) out.requestReminders = raw.requestReminders as NonNullable<DeliveryDoc['requestReminders']>
  const d = isRec(raw.deliveries) ? raw.deliveries : {}
  const kept: Record<string, unknown> = isRec(raw.preserved) ? { ...raw.preserved } : {}
  for (const [id, r] of Object.entries(d)) {
    if (SAFE_ID.test(id) && validRecord(r) && r.subtaskId === id) out.deliveries[id] = r
    else kept[id] = r
  }
  if (Object.keys(kept).length) out.preserved = kept
  return out
}

/** PURE (compat): parse leniently — unreadable text → empty doc. Reads only; a write never goes through this. */
export function parseDeliveryDoc(text: string): DeliveryDoc {
  try { return parseDeliveryDocStrict(text) } catch { return { version: 1, deliveries: {} } }
}

/** PURE: what is written — the readable records, then the preserved ones under their own ids when free. */
export function serializeDeliveryDoc(doc: DeliveryDoc): string {
  const deliveries: Record<string, unknown> = { ...doc.deliveries }
  const preserved: Record<string, unknown> = {}
  for (const [id, r] of Object.entries(doc.preserved ?? {})) { if (id in deliveries) preserved[id] = r; else deliveries[id] = r }
  return JSON.stringify({ version: 1, deliveries, ...(doc.requestReminders ? { requestReminders: doc.requestReminders } : {}), ...(Object.keys(preserved).length ? { preserved } : {}) }, null, 2) + '\n'
}

export interface DeliveryStore {
  readonly path: string
  read(): Promise<DeliveryDoc>
  /** Safety decisions must distinguish an absent book from an unreadable one. */
  readStrict(): Promise<DeliveryDoc>
  get(subtaskId: string): Promise<DeliveryRecord | null>
  /** Read-modify-write under the lock. `fn` returns the value to hand back; mutations to `doc` are persisted. Throws `DeliveryStoreUnreadable` when the file cannot be read. */
  update<T>(fn: (doc: DeliveryDoc) => T | Promise<T>, options?: { evidence?: boolean; guardsPath?: string }): Promise<T>
}

export function defaultDeliveriesPath(): string {
  if (process.env.AGENTISTICS_DELIVERIES_FILE) return process.env.AGENTISTICS_DELIVERIES_FILE
  // Lazy: config.ts reads the environment once at import, and tests point it elsewhere first.
  const dir = process.env.AGENTISTICS_DIR ?? join(process.env.HOME ?? '', '.agentistics')
  return join(dir, 'deliveries.json')
}

export function createDeliveryStore(path = defaultDeliveriesPath()): DeliveryStore {
  /** `missing` (no file yet) is an empty book; `unreadable` is NOT an empty book. */
  const readState = async (strict = false): Promise<{ kind: 'ok'; doc: DeliveryDoc } | { kind: 'missing' } | { kind: 'unreadable'; why: string }> => {
    let text: string
    try { text = await readFile(path, 'utf8') } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'missing' } : { kind: 'unreadable', why: e instanceof Error ? e.message.split('\n')[0]! : String(e) }
    }
    if (!text.trim()) return { kind: 'unreadable', why: 'the file is empty' }
    try {
      if (strict) {
        const raw = JSON.parse(text)
        if (!isRec(raw) || raw.version !== 1 || !isRec(raw.deliveries)) throw new Error('not a version 1 delivery book')
      }
      return { kind: 'ok', doc: parseDeliveryDocStrict(text) }
    } catch (e) { return { kind: 'unreadable', why: e instanceof Error ? e.message.split('\n')[0]! : String(e) } }
  }
  const read = async (): Promise<DeliveryDoc> => {
    const s = await readState()
    return s.kind === 'ok' ? s.doc : { version: 1, deliveries: {} }
  }
  return {
    path,
    read,
    async readStrict() {
      const s = await readState(true)
      if (s.kind === 'unreadable') throw new DeliveryStoreUnreadable(path, null, s.why)
      return s.kind === 'ok' ? s.doc : { version: 1, deliveries: {} }
    },
    async get(id) { return (await read()).deliveries[id] ?? null },
    async update(fn, options) {
      await mkdir(dirname(path), { recursive: true })
      const write = async () => {
        const s = await readState(!!options?.evidence)
        if (s.kind === 'unreadable') {
          // Keep the bytes (once per distinct file state) and refuse: an empty document must never replace them.
          const backup = `${path}.unreadable.bak`
          let kept: string | null = backup
          try { await stat(backup) } catch { try { await copyFile(path, backup) } catch { kept = null } }
          throw new DeliveryStoreUnreadable(path, kept, s.why)
        }
        const doc = s.kind === 'ok' ? s.doc : { version: 1 as const, deliveries: {} }
        const value = await fn(doc)
        const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
        await writeFile(tmp, serializeDeliveryDoc(doc), { mode: 0o600 })
        await rename(tmp, path)
        return value
      }
      // Evidence mutations may never proceed without a contended lock.
      return options?.evidence
        ? withGuardLocks(options.guardsPath ? ['deliveries', 'guards'] : ['deliveries'], write, { paths: { ...defaultGuardLockPaths(), deliveries: path, ...(options.guardsPath ? { guards: options.guardsPath } : {}) } })
        : withFileLock(path, write)
    },
  }
}

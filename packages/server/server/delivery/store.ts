/**
 * delivery/store.ts — the delivery records (one per subtask), `<dataDir>/deliveries.json`.
 *
 * Several processes write it (the server, a `agentop flow gate` in a CLI, an engine timer), so every
 * write is read-modify-write UNDER the cross-process ordered guard locks and lands by an atomic rename — a
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
import { copyFile, mkdir, readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { GuardBusy, GuardLockOrderError, withGuardLocks } from './guard-locks'
import { inGuardTransaction, peekRuleA, serializeGuardWrite } from './guard-transaction'
import { deliveryRaises, deliveryTamper, phaseRank, GuardRefused, type GuardContext } from './guard'
import { guardedWrite, guardPathsOf, ruleAState, type GuardWiring } from './guard-host'
import { withFileLock } from '../sessions/file-lock'
import { isPhase, isPureAdoption, type DeliveryRecord } from './machine'
import { durableWrite } from '../durable-file'
import { createGuardsStore, type GuardsDoc, type GuardsStore } from './guards-store'
import { deliveryReadRule, deliveryHasJournal } from './activation'
import type { TamperView } from './guard'
import { semanticallyChanged, stampActivity, type ActivityStamp } from './custody'

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
const protectedFloor = (r: TamperView | undefined): boolean => !!r && (!!r.evidence?.length || !!r.evidenceHistory?.length
  || phaseRank(r.phase) >= 1 || (r.history ?? []).some(h => isRec(h) && (phaseRank(String(h.from)) >= 1 || phaseRank(String(h.to)) >= 1)))

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
  /**
   * `guard` (S2a, optional): who is asking. A write that RAISES a record's phase rank (revisao_lider and beyond) without one is
   * refused by the store when the guarantee is on (`GuardRefused`, before a byte lands).
   */
  update<T>(fn: (doc: DeliveryDoc) => T | Promise<T>, options?: { evidence?: boolean; guardsPath?: string; guard?: GuardContext; stamp?: ActivityStamp | readonly ActivityStamp[] }): Promise<T>
}

export function defaultDeliveriesPath(): string {
  if (process.env.AGENTISTICS_DELIVERIES_FILE) return process.env.AGENTISTICS_DELIVERIES_FILE
  // Lazy: config.ts reads the environment once at import, and tests point it elsewhere first.
  const dir = process.env.AGENTISTICS_DIR ?? join(process.env.HOME ?? '', '.agentistics')
  return join(dir, 'deliveries.json')
}

async function materializeDelivery(path: string, serialized: string): Promise<void> {
  await durableWrite(path, serialized, 0o600)
}

/** Caller holds deliveries → guards. A rule move must resolve this commit before moving the rule. */
export async function rollForwardDelivery(path: string, floorStore: GuardsStore, guardDoc: GuardsDoc): Promise<GuardsDoc> {
  if (guardDoc.pendingDelivery !== undefined) {
    await materializeDelivery(path, guardDoc.pendingDelivery)
    const { pendingDelivery: _pending, ...recovered } = guardDoc
    await floorStore.write(recovered)
    return recovered
  }
  return guardDoc
}

export function createDeliveryStore(path = defaultDeliveriesPath(), opts: {
  guard?: GuardWiring
  /** In-process fault injection after the journal seal, before data rename; never read from a request. */
  afterFloorSeal?: () => void | Promise<void>
} = {}): DeliveryStore {
  const anchor = guardPathsOf({ deliveriesFile: path })
  /** `missing` (no file yet) is an empty book; `unreadable` is NOT an empty book. */
  const readState = async (strict = false): Promise<{ kind: 'ok'; doc: DeliveryDoc } | { kind: 'missing' } | { kind: 'unreadable'; why: string }> => {
    // A sealed journal is the committed logical document even if the process died before the data rename.
    // Readers need no write lock; the next writer materializes it under deliveries → guards.
    try {
      if (await deliveryReadRule(anchor.paths.guards) !== 'off') {
        const pending = (await createGuardsStore(anchor.paths.guards).read()).pendingDelivery
        if (pending !== undefined) return { kind: 'ok', doc: parseDeliveryDocStrict(pending) }
      }
    } catch (e) { console.warn('[guard] delivery read falls back to ledger:', e instanceof Error ? e.message : String(e)) }
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
      if (options?.guardsPath && resolve(options.guardsPath) !== resolve(anchor.paths.guards)) throw new GuardLockOrderError('guardsPath must be the guard file beside this delivery store')
      await mkdir(dirname(path), { recursive: true })
      const write = async (held?: { contended: boolean }, base = false) => {
        const materialize = (serialized: string) => materializeDelivery(path, serialized)
        const floorStore = createGuardsStore(anchor.paths.guards)
        // Deterministic roll-forward, including a crash after rename but before journal removal.
        if (!base) await rollForwardDelivery(path, floorStore, await floorStore.read())
        else {
          // OFF keeps its ordinary delivery lock. Only a present journal needs the later guards lock.
          // Read again after taking it; activation cannot interleave while the delivery lock is held.
          let guardDoc: GuardsDoc | undefined
          try { if (await deliveryHasJournal(anchor.paths.guards)) guardDoc = await floorStore.read() }
          catch (e) { if (await ruleAState(anchor.dir) !== 'off') throw e }
          if (guardDoc?.pendingDelivery !== undefined) {
            if (held?.contended) throw new GuardBusy('deliveries')
            const recover = async () => { await rollForwardDelivery(path, floorStore, await floorStore.read()) }
            if (options?.evidence && options.guardsPath) await recover()
            else await withGuardLocks(['guards'], recover, { paths: anchor.paths, alreadyHeld: ['deliveries'] })
          }
        }
        const s = await readState(!!options?.evidence)
        if (s.kind === 'unreadable') {
          // Keep the bytes (once per distinct file state) and refuse: an empty document must never replace them.
          const backup = `${path}.unreadable.bak`
          let kept: string | null = backup
          try { await stat(backup) } catch { try { await copyFile(path, backup) } catch { kept = null } }
          throw new DeliveryStoreUnreadable(path, kept, s.why)
        }
        const doc = s.kind === 'ok' ? s.doc : { version: 1 as const, deliveries: {} }
        // Snapshot every protected binding before the callback; the evidence option cannot disable detection.
        const phasesBefore = structuredClone(doc.deliveries)
        const value = await fn(doc)
        // S7a (§5.1): the piece-activity stamp lands in the SAME write as the action it describes — never a second best-effort write,
        // so no crash can leave an action without its stamp. Only a SEMANTIC change stamps: an empty or idempotent patch (which still
        // refreshes `updatedAt`) is not an action.
        for (const st of options?.stamp ? (Array.isArray(options.stamp) ? options.stamp : [options.stamp]) : []) {
          const after = doc.deliveries[st.key]
          if (after && (st.when?.() ?? true) && semanticallyChanged(phasesBefore[st.key], after)) stampActivity(after, st.actor, st.at)
        }
        // Judge exactly the representation the serializer will persist, including promoted preserved records.
        const serialized = serializeDeliveryDoc(doc)
        const final = parseDeliveryDocStrict(serialized)
        const floorRule = base ? 'off' : await ruleAState(anchor.dir)
        const floors = floorRule === 'off' ? {} : (await floorStore.read()).deliveryFloors ?? {}
        const commit = async () => {
          if (floorRule !== 'off') {
            // Seal floor + full pending bytes together. One atomic sealed rename commits both logically;
            // after a crash readers see the journal and the next writer rolls it forward before any mutation.
            const guardDoc = await floorStore.read()
            const next = { ...(guardDoc.deliveryFloors ?? {}) }
            for (const [id, r] of Object.entries({ ...phasesBefore, ...final.deliveries })) {
              const old = next[id]
              // Board-only adoptions carry no authorization. Their release/re-adoption must not acquire a tombstone.
              // Keep any older evidence or ranked history, including floors sealed by older builds.
              if (isPureAdoption(r) && !protectedFloor(old)) { delete next[id]; continue }
              const items = new Map((old?.evidence ?? []).map(i => [i.id, i]))
              for (const i of r.evidence ?? []) if (!items.has(i.id)) items.set(i.id, i)
              const extend = (was: readonly unknown[] = [], now: readonly unknown[] = []) => was.every((e, i) => JSON.stringify(e) === JSON.stringify(now[i])) ? now : was
              next[id] = { taskId: r.taskId, phase: old?.phase && phaseRank(old.phase) >= phaseRank(r.phase) ? old.phase : r.phase, revision: Math.max(old?.revision ?? 0, r.revision), history: extend(old?.history, r.history), evidenceHistory: extend(old?.evidenceHistory, r.evidenceHistory), evidence: [...items.values()] }
            }
            await floorStore.write({ ...guardDoc, deliveryFloors: next, pendingDelivery: serialized })
            await opts.afterFloorSeal?.()
          }
          await materialize(serialized)
          if (floorRule !== 'off') {
            const { pendingDelivery: _pending, ...committed } = await floorStore.read()
            await floorStore.write(committed)
          }
        }
        const raised = deliveryRaises(phasesBefore, final.deliveries)
        const retreats = Object.entries(final.deliveries).flatMap(([key, r]) => {
          const before = phasesBefore[key]
          return before && phaseRank(r.phase) < phaseRank(before.phase) ? [{ key, rank: phaseRank(r.phase), fromPhase: before.phase }] : []
        })
        const tampered = [
          ...deliveryTamper(phasesBefore, final.deliveries, !!options?.guard),
          ...deliveryTamper(Object.fromEntries(Object.entries(floors).filter(([id]) => {
            const before = phasesBefore[id], after = final.deliveries[id]
            if (after && isPureAdoption(after) && !protectedFloor(floors[id])) return false
            if (JSON.stringify(before) === JSON.stringify(after)) return false
            // A retreat (including its appended history/revision) does not reclaim lost authorization.
            // The direct before/after tamper check above still protects existing history and evidence.
            if (before && after && after.phase !== before.phase && phaseRank(after.phase) <= phaseRank(before.phase)) return false
            return true
          })), final.deliveries, true),
        ]
        if (base) {
          // Rule off when the write started. Nothing protected changed → the base write. Otherwise re-read the rule under
          // the deliveries lock (the activation takes it first). A rule that moved mid-write fails closed: the callback is
          // not re-run (it may have effects outside the document) — the caller retries under the guarded lock set.
          if ((!raised.length && !tampered.length) || await ruleAState(anchor.dir) === 'off') { await commit(); return value }
          throw new GuardBusy('guards')
        }
        if (tampered.length) {
          const rule = await ruleAState(anchor.dir)
          if (rule === 'on') throw new GuardRefused(tampered[0]!)
          if (rule === 'shadow') for (const t of tampered) console.warn(`[guard] would_refuse ${t.code} ${t.piece}`)
        }
        if (!raised.length && (!retreats.length || !options?.guard)) { await commit(); return value }
        // `withFileLock` goes ahead WITHOUT the lock after its wait; a guard never does (§2.6.1).
        if (held?.contended) throw new GuardBusy('deliveries')
        await guardedWrite({
          raised, retreats, ctx: options?.guard, paths: anchor.paths, wiring: opts.guard,
          locks: [], alreadyHeld: ['deliveries', 'guards'],
          recordOf: async key => final.deliveries[key] ?? null,
          stateOf: r => ({ boardStatus: '', boardStage: '', phase: final.deliveries[r.key]?.phase ?? null }),
          writeDocuments: commit,
        })
        return value
      }
      // Both policy and records are read only after deliveries and guards are held.
      const paths = anchor.paths
      if (inGuardTransaction(paths)) return serializeGuardWrite(paths, 'deliveries', () => write())
      const guarded = () => withGuardLocks(['deliveries', 'guards'], () => write(), { paths })
      // A write carrying a custody stamp (only built when rule C is on) is fail-closed whatever rule A says (S7a N1, §2.6.1): it never
      // goes ahead after the lock wait with another holder still on the file, and the stamp never rides a write that did.
      const stamped = Array.isArray(options?.stamp) ? options.stamp.length > 0 : options?.stamp !== undefined
      if (stamped || await peekRuleA(paths) !== 'off') return guarded()
      // Rule A off (N2): exactly the base's locking — the evidence path's fail-closed locks, otherwise `withFileLock`.
      return options?.evidence
        ? withGuardLocks(options.guardsPath ? ['deliveries', 'guards'] : ['deliveries'], () => write(undefined, true), { paths })
        : withFileLock(path, held => write(held, true))
    },
  }
}

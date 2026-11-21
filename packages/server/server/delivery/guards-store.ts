/**
 * delivery/guards-store.ts — durable checkpoints and intents, `<dataDir>/guards.json` (spec §2.6).
 *
 * A checkpoint is the current rank a piece is AUTHORIZED to hold and the complete set of authorizations that
 * granted it. It is per piece and never evicted while the piece exists — unlike the activity feed (`TaskEvent`,
 * capped at 2000) it cannot age out. Older binaries never read or write this file (§2.7), so they cannot erase it.
 *
 * TWO-PHASE COMMIT. intent (guards.json) → the document write(s) → checkpoint commit + intent removal
 * (guards.json). A crash between steps leaves an INTENT: recovery commits it when the documents already show the
 * target and drops it otherwise (`planRecovery`). Events play no part in authorization.
 * Delivery floors additionally carry `pendingDelivery`: floor + serialized delivery bytes are sealed in one rename.
 * Readers see those committed bytes; the next delivery writer rolls them forward before its mutation and clears the
 * journal only after the delivery rename. A crash cannot strand the data behind its floor or require lowering it.
 *
 * LOCKING IS NOT DONE HERE. The functions on this file assume the caller holds the guards lock (and, per §2.6.1,
 * tasks → deliveries before it) through `withGuardLocks`; `applyGuardedWrite` is the one composition that does.
 * `write` refuses to replace an unreadable file with an empty document.
 *
 * Types below mirror the spec's `PieceCheckpoint`; `by` is typed structurally here because the request principal
 * (`principal.ts`) lands with S0a — S0b only stores it.
 */
import { readFile, copyFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { withGuardLocks, type GuardLockName, type GuardLockPaths } from './guard-locks'
import { unsealed, verdictFor, writeSealed, type TamperReason } from './guard-integrity'
import type { TamperView } from './guard'
import type { SweepMemory } from './sweep-plan'

export type GuardAuth =
  | { kind: 'evidence'; ids: string[]; sha256: string[] }
  | { kind: 'release'; releaseKey: string; proof: 'ancestry' | 'patch-id' | 'tree-holds'; containingCommit: string }
  | { kind: 'verification'; jobId: string; strength: string }
  | { kind: 'non-code'; reportId: string; qaVerdictRef: string }
  | { kind: 'owner'; via: 'vault-credential' | 'legacy-browser'; grantIdHash?: string }
  | { kind: 'override'; via: 'vault-credential' | 'legacy-browser'; grantIdHash?: string; reason: string }
  | { kind: 'accepted'; acceptedBy: 'qa-other-model' | 'owner' | 'leader-same-model'; by: string }
  | { kind: 'grandfathered'; at: string }

export interface PieceCheckpoint {
  key: string
  rank: number
  boardStatus: string
  boardStage: string
  phase: string | null
  revision: number
  headSha: string | null
  auth: GuardAuth[]
  by: { kind: string; [k: string]: unknown }
  at: string
  transitionId: string
  /** How the piece was classified when it was authorized (S1b, §3.2); `declared` when a leader named where to look. */
  classification?: { category: string; headSha: string; declared?: { by: string; repo: string; head: string; at: string } }
  /** A GROUP's checkpoint: the board status the guard accepted for each member (R3-1) — the sweep reverts a member only when it differs. */
  members?: Record<string, { status: string; at: string }>
}

export interface GuardIntent { transitionId: string; target: PieceCheckpoint; at: string }
/** `rules`: S0d.2's authenticated MIRROR of each guarantee rule's state (`activation.ts` writes it in the same guards-locked section). */
export interface GuardsDoc { version: 1; checkpoints: Record<string, PieceCheckpoint>; intents: Record<string, GuardIntent>; rules?: Record<string, 'off' | 'shadow' | 'on'>; deliveryFloors?: Record<string, TamperView>; pendingDelivery?: string; migrations?: { a?: { version: 1; at: string } }; sweep?: SweepMemory }

export class GuardsUnreadable extends Error {
  readonly code = 'guards_unreadable'
  /** S0d.2: set when the file is not what agentop sealed (deleted, hand-edited, unsealed, or its key is gone). */
  readonly tampered?: TamperReason
  constructor(readonly path: string, readonly why: string, tampered?: TamperReason) {
    super(`guards.json is unreadable (${why}); guarded writes are refused so no authorization is lost`)
    if (tampered) this.tampered = tampered
  }
}

export const emptyGuards = (): GuardsDoc => ({ version: 1, checkpoints: {}, intents: {} })
const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** PURE. Throws on anything that is not a version-1 guards document; entries must carry their identity. */
export function parseGuards(text: string): GuardsDoc {
  const raw: unknown = JSON.parse(text)
  if (!isRec(raw) || raw.version !== 1) throw new Error('not a version 1 guards document')
  const checkpoints: Record<string, PieceCheckpoint> = {}
  const intents: Record<string, GuardIntent> = {}
  const deliveryFloors: Record<string, TamperView> = {}
  if (raw.deliveryFloors !== undefined) {
    if (!isRec(raw.deliveryFloors)) throw new Error('deliveryFloors is not an object')
    for (const [k, v] of Object.entries(raw.deliveryFloors)) {
      if (!isRec(v) || !Number.isInteger(v.revision) || (v.revision as number) < 1 || !Array.isArray(v.history) || !Array.isArray(v.evidence) || !Array.isArray(v.evidenceHistory)) throw new Error(`delivery floor ${k} is malformed`)
      deliveryFloors[k] = v as TamperView
    }
  }
  if (raw.pendingDelivery !== undefined && typeof raw.pendingDelivery !== 'string') throw new Error('pendingDelivery is not serialized data')
  let sweep: SweepMemory | undefined
  if (raw.sweep !== undefined) {
    if (!isRec(raw.sweep) || !isRec(raw.sweep.reverts)) throw new Error('sweep memory is malformed')
    const reverts: Record<string, string[]> = {}
    for (const [k, v] of Object.entries(raw.sweep.reverts)) { if (!Array.isArray(v) || v.some(s => typeof s !== 'string')) throw new Error(`sweep memory ${k} is malformed`); reverts[k] = v as string[] }
    sweep = { reverts }
    for (const field of ['plans', 'catchUpFailures', 'noBaselineSince', 'unacceptedSince'] as const) {
      const value = raw.sweep[field]
      if (value !== undefined) {
        if (!isRec(value) || Object.values(value).some(v => typeof v !== 'string')) throw new Error(`sweep ${field} is malformed`)
        sweep[field] = value as Record<string, string>
      }
    }
    if (raw.sweep.memberAlerts !== undefined) {
      const value = raw.sweep.memberAlerts
      if (!isRec(value) || Object.values(value).some(v => !isRec(v) || typeof v.at !== 'string' || typeof v.text !== 'string')) throw new Error('sweep memberAlerts is malformed')
      if (Object.values(value).some(v => (v as { actions?: unknown }).actions !== undefined && (!Array.isArray((v as { actions?: unknown }).actions) || ((v as { actions: unknown[] }).actions).some(x => typeof x !== 'string')))) throw new Error('sweep memberAlerts is malformed')
      sweep.memberAlerts = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, { at: (v as { at: string }).at, text: (v as { text: string }).text, ...((v as { actions?: string[] }).actions ? { actions: (v as { actions: string[] }).actions } : {}) }]))
    }
    if (raw.sweep.forgedMarks !== undefined) {
      const value = raw.sweep.forgedMarks
      if (!isRec(value) || Object.values(value).some(v => typeof v !== 'string')) throw new Error('sweep forgedMarks is malformed')
      sweep.forgedMarks = value as Record<string, string>
    }
    if (raw.sweep.placeholders !== undefined) {
      const value = raw.sweep.placeholders
      if (!isRec(value) || Object.values(value).some(v => !isRec(v) || typeof v.groupId !== 'string' || typeof v.taskId !== 'string' || typeof v.restoredAt !== 'string' || typeof v.restorationId !== 'string' || (v.dismissedAt !== undefined && typeof v.dismissedAt !== 'string'))) throw new Error('sweep placeholders is malformed')
      sweep.placeholders = value as NonNullable<SweepMemory['placeholders']>
    }
    for (const field of ['ownerRemoved', 'acceptedMissing'] as const) {
      const value = raw.sweep[field]
      if (value !== undefined) {
        if (!isRec(value) || Object.values(value).some(v => !isRec(v) || typeof v.groupId !== 'string' || typeof v.at !== 'string')) throw new Error(`sweep ${field} is malformed`)
        sweep[field] = value as NonNullable<SweepMemory['ownerRemoved']>
      }
    }
    if (raw.sweep.warning !== undefined) {
      if (typeof raw.sweep.warning !== 'string') throw new Error('sweep warning is malformed')
      sweep.warning = raw.sweep.warning
    }
  }
  if (raw.migrations !== undefined && (!isRec(raw.migrations) || (raw.migrations.a !== undefined && (!isRec(raw.migrations.a) || raw.migrations.a.version !== 1 || typeof raw.migrations.a.at !== 'string' || !Number.isFinite(Date.parse(raw.migrations.a.at)))))) throw new Error('migration stamp is malformed')
  const floors = { ...(raw.deliveryFloors === undefined ? {} : { deliveryFloors }), ...(typeof raw.pendingDelivery === 'string' ? { pendingDelivery: raw.pendingDelivery } : {}), ...(sweep ? { sweep } : {}), ...(raw.migrations ? { migrations: raw.migrations as GuardsDoc['migrations'] } : {}) }
  if (raw.checkpoints !== undefined && !isRec(raw.checkpoints)) throw new Error('checkpoints is not an object')
  if (raw.intents !== undefined && !isRec(raw.intents)) throw new Error('intents is not an object')
  for (const [k, v] of Object.entries((raw.checkpoints as Record<string, unknown>) ?? {})) {
    if (!isRec(v) || v.key !== k || typeof v.rank !== 'number' || typeof v.transitionId !== 'string') throw new Error(`checkpoint ${k} is malformed`)
    checkpoints[k] = v as unknown as PieceCheckpoint
  }
  for (const [k, v] of Object.entries((raw.intents as Record<string, unknown>) ?? {})) {
    if (!isRec(v) || typeof v.transitionId !== 'string' || !isRec(v.target) || v.target.key !== k) throw new Error(`intent ${k} is malformed`)
    intents[k] = v as unknown as GuardIntent
  }
  if (raw.rules !== undefined) {
    if (!isRec(raw.rules)) throw new Error('rules is not an object')
    const rules: Record<string, 'off' | 'shadow' | 'on'> = {}
    for (const [k, v] of Object.entries(raw.rules)) { if (v !== 'off' && v !== 'shadow' && v !== 'on') throw new Error(`rule ${k} is malformed`); rules[k] = v }
    return { version: 1, checkpoints, intents, rules, ...floors }
  }
  return { version: 1, checkpoints, intents, ...floors }
}

/** PURE. Phase one: record what is about to be written. */
export function beginIntent(doc: GuardsDoc, target: PieceCheckpoint, at: string): GuardsDoc {
  return { ...doc, intents: { ...doc.intents, [target.key]: { transitionId: target.transitionId, target, at } } }
}

/** PURE. Phase three: the intent becomes the checkpoint. A different transitionId changes nothing. */
export function commitIntent(doc: GuardsDoc, key: string, transitionId: string): GuardsDoc {
  const intent = doc.intents[key]
  if (!intent || intent.transitionId !== transitionId) return doc
  const { [key]: _gone, ...rest } = doc.intents
  return { ...doc, checkpoints: { ...doc.checkpoints, [key]: intent.target }, intents: rest }
}

/** PURE. The tick's recovery: commit what the documents already show, drop what they do not. */
export function planRecovery(doc: GuardsDoc, documentsShow: (target: PieceCheckpoint) => boolean): { commit: GuardIntent[]; drop: string[] } {
  const commit: GuardIntent[] = []; const drop: string[] = []
  for (const [key, intent] of Object.entries(doc.intents)) (documentsShow(intent.target) ? commit.push(intent) : drop.push(key))
  return { commit, drop }
}

export interface GuardsStore {
  readonly path: string
  /** Absent → empty. Unreadable → throws `GuardsUnreadable`. Never creates the file. */
  read(): Promise<GuardsDoc>
  /** Atomic, 0600. Refuses (and keeps the bytes) when the file on disk is unreadable. Caller holds the guards lock. */
  write(doc: GuardsDoc): Promise<void>
}

export function defaultGuardsPath(dataDir = process.env.AGENTISTICS_DIR ?? join(process.env.HOME ?? '', '.agentistics')): string {
  return join(dataDir, 'guards.json')
}

export function createGuardsStore(path = defaultGuardsPath()): GuardsStore {
  const read = async (): Promise<GuardsDoc> => {
    let text: string | null
    try { text = await readFile(path, 'utf8') } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new GuardsUnreadable(path, e instanceof Error ? e.message.split('\n')[0]! : String(e))
      text = null
    }
    // S0d.2: the seal first. A deleted, hand-edited, unsealed or key-less file is TAMPERED — refused, never "empty".
    const v = await verdictFor(path, 'guards', text)
    if (v.state === 'tampered') throw new GuardsUnreadable(path, `tampered: ${v.reason}`, v.reason)
    if (text === null) return emptyGuards()
    if (!text.trim()) throw new GuardsUnreadable(path, 'the file is empty')
    try { return parseGuards(unsealed(text)) } catch (e) { throw new GuardsUnreadable(path, e instanceof Error ? e.message : String(e)) }
  }
  return {
    path,
    read,
    async write(doc) {
      await read() // throws when unreadable or tampered: the bytes stay, nothing replaces them
      await writeSealed(path, 'guards', doc)
    },
  }
}

/** Keep one copy of an unreadable file for a person to look at (once per distinct file state). */
export async function keepUnreadableCopy(path: string): Promise<string | null> {
  const backup = `${path}.unreadable.bak`
  try { await stat(backup); return backup } catch { /* none yet */ }
  try { await copyFile(path, backup); return backup } catch { return null }
}

export interface GuardedWrite {
  locks: readonly GuardLockName[]
  paths?: GuardLockPaths
  guardsPath?: string
  waitMs?: number
  alreadyHeld?: readonly GuardLockName[]
  piece: string
  target: PieceCheckpoint
  now: string
  /** The document write(s). Runs after the intent is durable. */
  writeDocuments: () => Promise<void>
  /** Test seam: runs after the documents were written and before the checkpoint commit (a crash point). */
  afterDocuments?: () => void | Promise<void>
  /** Kept for the recovery planner's callers; not used by the happy path. */
  documentsShow?: (target: PieceCheckpoint) => boolean
}

/**
 * The §2.6 sequence under the held lock set: intent → documents → checkpoint commit. Any failure after the intent
 * leaves the intent on disk for `planRecovery`; nothing is written when the locks cannot be taken (`guard_busy`).
 */
export async function applyGuardedWrite(w: GuardedWrite): Promise<void> {
  const guardsPath = w.guardsPath ?? w.paths?.guards ?? defaultGuardsPath()
  const store = createGuardsStore(guardsPath)
  await withGuardLocks(w.locks, async () => {
    const withIntent = beginIntent(await store.read(), w.target, w.now)
    await store.write(withIntent)
    await w.writeDocuments()
    await w.afterDocuments?.()
    await store.write(commitIntent(await store.read(), w.piece, w.target.transitionId))
  }, { paths: w.paths, waitMs: w.waitMs, alreadyHeld: w.alreadyHeld })
}

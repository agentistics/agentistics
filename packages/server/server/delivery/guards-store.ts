/**
 * delivery/guards-store.ts — durable checkpoints and intents, `<dataDir>/guards.json` (spec §2.6).
 *
 * A checkpoint is the highest rank a piece was AUTHORIZED to reach and the complete set of authorizations that
 * granted it. It is per piece and never evicted while the piece exists — unlike the activity feed (`TaskEvent`,
 * capped at 2000) it cannot age out. Older binaries never read or write this file (§2.7), so they cannot erase it.
 *
 * TWO-PHASE COMMIT. intent (guards.json) → the document write(s) → checkpoint commit + intent removal
 * (guards.json). A crash between steps leaves an INTENT: recovery commits it when the documents already show the
 * target and drops it otherwise (`planRecovery`). Events play no part in authorization.
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
}

export interface GuardIntent { transitionId: string; target: PieceCheckpoint; at: string }
/** `rules`: S0d.2's authenticated MIRROR of each guarantee rule's state (`activation.ts` writes it in the same guards-locked section). */
export interface GuardsDoc { version: 1; checkpoints: Record<string, PieceCheckpoint>; intents: Record<string, GuardIntent>; rules?: Record<string, 'off' | 'shadow' | 'on'> }

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
    return { version: 1, checkpoints, intents, rules }
  }
  return { version: 1, checkpoints, intents }
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

/**
 * delivery/activation.ts — per-rule activation, `<dataDir>/guarantees.json` (spec §2.7).
 *
 * `{ rules: { a|b|c|d: { state: 'off'|'shadow'|'on', since?, build } }, statusStages?, log? }`.
 *
 *   - ABSENT FILE = EVERY RULE `off`; so is an absent rule entry, a junk state, and an unparseable file (with a
 *     WARN naming the file). Nothing ever moves a rule to `shadow` or `on` by itself: an upgrade never starts
 *     refusing a user's existing moves.
 *   - `off`, `shadow` and `activate` are OWNER-ONLY moves. The owner-proof primitive arrives in S0a, so the
 *     principal check is an interface (`OwnerCheck`) the caller supplies; the answer is consulted FIRST so a
 *     stranger learns nothing about prerequisites.
 *   - `on` only after: (1) the build declares every prerequisite capability, (2) the rule's migration ran,
 *     (3) ≥ 24 h in `shadow` with no unexplained `would_refuse`. Rule b also needs rule a on. Rule d has no write
 *     guard (its invariant is a projection, §6): its only prerequisite is the S8 capability.
 *   - `statusStages` is the MIRROR of each status's stored stage (§2.2): an older binary's tasks.json writer drops
 *     `stage` (it is not in its status whitelist), this file is one it never opens, and `restoreStatusStages`
 *     puts the stages back.
 *
 * No locking here: the caller holds the guards lock through `withGuardLocks` (a guarantee change is a guards-set
 * write). Writes are atomic, 0600, and never replace an unreadable file.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { STATUS_STAGES } from '@agentistics/core'

export const RULE_IDS = ['a', 'b', 'c', 'd'] as const
export type RuleId = (typeof RULE_IDS)[number]
export type RuleState = 'off' | 'shadow' | 'on'

// The stage vocabulary is core's (`TaskStatusDef.stage`, S0c): a mirror entry is valid exactly when a stored stage is.
const STAGE_SET: ReadonlySet<string> = new Set(STATUS_STAGES)

export interface RuleEntry { state: RuleState; since?: string; build: string }
export interface GuaranteeChange { rule: RuleId; from: RuleState; to: RuleState; via: OwnerVia; at: string; build: string }
export interface GuaranteesDoc {
  rules: Partial<Record<RuleId, RuleEntry>>
  statusStages?: Record<string, string>
  log?: GuaranteeChange[]
}
export type OwnerVia = 'vault-credential' | 'legacy-browser'

const LOG_CAP = 200
const SHADOW_MIN_MS = 24 * 3600 * 1000
const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** PURE. A document, or `null` text → the empty one. Throws on text that is not a JSON object. */
export function parseGuarantees(text: string | null): { doc: GuaranteesDoc; warn?: string } {
  if (text === null) return { doc: { rules: {} } }
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return { doc: { rules: {} }, warn: 'guarantees.json is unparseable; every rule is off until it is fixed or removed' } }
  if (!isRec(raw)) return { doc: { rules: {} }, warn: 'guarantees.json is not an object; every rule is off until it is fixed or removed' }
  const rules: GuaranteesDoc['rules'] = {}
  if (isRec(raw.rules)) {
    for (const r of RULE_IDS) {
      const e = raw.rules[r]
      if (isRec(e) && (e.state === 'off' || e.state === 'shadow' || e.state === 'on')) {
        rules[r] = { state: e.state, ...(typeof e.since === 'string' ? { since: e.since } : {}), build: typeof e.build === 'string' ? e.build : '' }
      }
    }
  }
  const doc: GuaranteesDoc = { rules }
  if (isRec(raw.statusStages)) {
    const m: Record<string, string> = {}
    for (const [k, v] of Object.entries(raw.statusStages)) if (typeof v === 'string') m[k] = v
    doc.statusStages = m
  }
  if (Array.isArray(raw.log)) doc.log = raw.log.filter((c): c is GuaranteeChange => isRec(c) && typeof c.rule === 'string' && typeof c.to === 'string') as GuaranteeChange[]
  return { doc }
}

export const ruleState = (doc: GuaranteesDoc, rule: RuleId): RuleState => doc.rules[rule]?.state ?? 'off'

/** PURE. `guarantee-off: <rule>, by <via>` for each rule whose latest recorded move is an owner's `off`. */
export function guaranteeWarnings(doc: GuaranteesDoc): string[] {
  const out: string[] = []
  for (const r of RULE_IDS) {
    if (ruleState(doc, r) !== 'off') continue
    const last = [...(doc.log ?? [])].reverse().find(c => c.rule === r)
    if (last && last.to === 'off') out.push(`guarantee-off: ${r}, by ${last.via}`)
  }
  return out
}

/** PURE. Re-apply the mirrored stage where a status has none (an older writer dropped it). Unknown stages are ignored. */
export function restoreStatusStages<S extends { id: string; stage?: string }>(
  statuses: readonly S[], mirror: Record<string, string> | undefined,
): { statuses: S[]; restored: string[] } {
  const restored: string[] = []
  const out = statuses.map(s => {
    const m = mirror?.[s.id]
    if (s.stage === undefined && m !== undefined && STAGE_SET.has(m)) { restored.push(s.id); return { ...s, stage: m } }
    return s
  })
  return { statuses: out, restored }
}

// --- the moves -------------------------------------------------------------------------------------------------

export interface GuaranteeMove { rule: RuleId; from: RuleState; to: RuleState }
/** The principal check, stubbed behind an interface until S0a's owner-proof primitive exists. */
export type OwnerCheck = (move: GuaranteeMove) => Promise<{ ok: true; via: OwnerVia } | { ok: false; code: 'owner_required' | 'owner_proof_required' }>

export interface ActivationFacts {
  now: string
  /** The running build's label, recorded on the rule. */
  build: string
  /** Capabilities the build declares (`S0`…`S8`). */
  capabilities: readonly string[]
  /** Rules whose `guarantee-migrate` ran and wrote its checkpoints. */
  migrated: readonly RuleId[]
  /** `would_refuse` entries from the shadow week nobody explained. */
  unexplainedWouldRefuse: number
}

/** Prerequisite capabilities per rule (§2.7): a ← S0–S2, S3; b ← a, S4–S6; c ← S7; d ← S8. */
export const RULE_CAPABILITIES: Record<RuleId, readonly string[]> = {
  a: ['S0', 'S1', 'S2', 'S3'], b: ['S4', 'S5', 'S6'], c: ['S7'], d: ['S8'],
}
const RULE_REQUIRES_RULES: Record<RuleId, readonly RuleId[]> = { a: [], b: ['a'], c: [], d: [] }

export type MoveRefusal =
  | { ok: false; code: 'owner_required' | 'owner_proof_required' | 'guarantees_unreadable' | 'shadow_required' | 'shadow_too_short' | 'unexplained_would_refuse' | 'migration_missing' }
  | { ok: false; code: 'prerequisite_capability' | 'prerequisite_rule'; missing: string[] }
export type MoveResult = { ok: true } | MoveRefusal

export interface GuaranteesStore {
  readonly path: string
  read(): Promise<{ doc: GuaranteesDoc; warn?: string }>
  setState(rule: RuleId, to: RuleState, ctx: { check: OwnerCheck; facts: ActivationFacts }): Promise<MoveResult>
  /** Mirror each status's stored stage (statuses without one are not mirrored). */
  writeStatusStages(statuses: ReadonlyArray<{ id: string; stage?: string }>): Promise<void>
}

export function defaultGuaranteesPath(dataDir = process.env.AGENTISTICS_DIR ?? join(process.env.HOME ?? '', '.agentistics')): string {
  return join(dataDir, 'guarantees.json')
}

export function createGuaranteesStore(path = defaultGuaranteesPath()): GuaranteesStore {
  /** `null` text = no file. Unreadable (present, but not valid) is distinguished so a write can refuse. */
  const load = async (): Promise<{ doc: GuaranteesDoc; warn?: string; unreadable: boolean }> => {
    let text: string
    try { text = await readFile(path, 'utf8') } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ...parseGuarantees(null), unreadable: false }
      return { doc: { rules: {} }, warn: 'guarantees.json cannot be read; every rule is off', unreadable: true }
    }
    const p = parseGuarantees(text)
    return { ...p, unreadable: p.warn !== undefined }
  }
  const save = async (doc: GuaranteesDoc) => {
    await mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.tmp`
    await writeFile(tmp, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600 })
    await rename(tmp, path)
  }
  return {
    path,
    async read() { const { doc, warn } = await load(); return warn ? { doc, warn } : { doc } },
    async setState(rule, to, { check, facts }) {
      const { doc, unreadable } = await load()
      if (unreadable) return { ok: false, code: 'guarantees_unreadable' }
      const from = ruleState(doc, rule)
      const who = await check({ rule, from, to })
      if (!who.ok) return { ok: false, code: who.code }
      if (to === 'on') {
        const refusal = activationRefusal(doc, rule, facts)
        if (refusal) return refusal
      }
      const entry: RuleEntry = { state: to, build: facts.build, ...(to === 'off' ? {} : { since: facts.now }) }
      // staying in the same state keeps its original `since`
      if (from === to && doc.rules[rule]?.since) entry.since = doc.rules[rule]!.since
      const log = [...(doc.log ?? []), { rule, from, to, via: who.via, at: facts.now, build: facts.build }].slice(-LOG_CAP)
      await save({ ...doc, rules: { ...doc.rules, [rule]: entry }, log })
      return { ok: true }
    },
    async writeStatusStages(statuses) {
      const { doc, unreadable } = await load()
      if (unreadable) throw new Error('guarantees.json is unreadable; the stage mirror was not written')
      const m: Record<string, string> = {}
      for (const s of statuses) if (s.stage !== undefined && STAGE_SET.has(s.stage)) m[s.id] = s.stage
      await save({ ...doc, statusStages: m })
    },
  }
}

function activationRefusal(doc: GuaranteesDoc, rule: RuleId, f: ActivationFacts): MoveRefusal | null {
  const missingCaps = RULE_CAPABILITIES[rule].filter(c => !f.capabilities.includes(c))
  if (missingCaps.length) return { ok: false, code: 'prerequisite_capability', missing: [...missingCaps] }
  const missingRules = RULE_REQUIRES_RULES[rule].filter(r => ruleState(doc, r) !== 'on')
  if (missingRules.length) return { ok: false, code: 'prerequisite_rule', missing: [...missingRules] }
  if (rule === 'd') return null // no write guard: no migration, no shadow week
  if (!f.migrated.includes(rule)) return { ok: false, code: 'migration_missing' }
  const entry = doc.rules[rule]
  if (entry?.state !== 'shadow' || !entry.since) return { ok: false, code: 'shadow_required' }
  if (Date.parse(f.now) - Date.parse(entry.since) < SHADOW_MIN_MS) return { ok: false, code: 'shadow_too_short' }
  if (f.unexplainedWouldRefuse > 0) return { ok: false, code: 'unexplained_would_refuse' }
  return null
}

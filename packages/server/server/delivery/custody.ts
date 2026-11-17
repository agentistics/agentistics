/**
 * delivery/custody.ts — the custody clocks and the custody plan (ENTREGA.GARANTIDA §5.1–§5.2, S7a). PURE: no store, no
 * fleet, no clock of its own — the tick (`custody-tick.ts`) reads the facts and hands them in, and writes the patches back.
 *
 * THREE separate clocks (r1 anchored absence to `lastSeenMs`, a poller's observation stamp refreshed for every live process,
 * silent or not — so a zombie leader never aged out):
 *
 *   LIVENESS         the session row is alive. Necessary, NEVER sufficient. `lastSeenMs`, a heartbeat, a status word and
 *                    transcript writes are deliberately not inputs of this module at all: a transcript is per conversation,
 *                    not per task, so a leader answering about task X writes the same transcript as for Y.
 *   PIECE ACTIVITY   `record.leaderActivityAt` / `leaderActivityBy`: the last TASK-SCOPED board action a leader or custodian
 *                    took on this piece (a guarded transition, a gate run, evidence attach/remove, a release declaration, a
 *                    custody take/release, a decision/block thread comment). Written by the service when the actor leads the
 *                    piece; plain comments never write it.
 *   ABSENCE          `record.leaderAbsentSince: ISO | null`, PERSISTED. Set and cleared only here (the tick):
 *                      · set when the piece is at a running stage or at rank 1–3 and no LIVE leader (filed, custodian or a
 *                        live leader of the task) has piece activity within N. It is anchored at the moment the activity
 *                        STOPPED — the last piece action — and not at the tick that noticed: the clock that matters is the
 *                        piece's, and a zombie that stopped acting N+1 min ago is an orphan now;
 *                      · a NEVER-LED piece (no leader filed, no custodian ever, no activity) is anchored at the moment it
 *                        entered its current stage;
 *                      · a led piece with NO activity on record (it predates the stamp) is anchored at the first tick that
 *                        sees it absent — it gets its full N, never a take-over on day one;
 *                      · cleared when a live leader performs a piece action;
 *                      · unchanged on restart (it is a stored ISO) and unchanged when the fleet read is UNKNOWN.
 *   ORPHAN           now − leaderAbsentSince > N (N = 4 h by default, `preferences.delivery.orphanAfterHours`, 1–48).
 *
 * Custody is per PIECE, never filing (`conversationOwners` is not touched), and an AUTHORIZATION of the actor — it is never a
 * substitute for evidence or proof. This slice (S7a) owns the clocks, the plan and the queue; `leads()` accepting the custodian,
 * wake routing, check-in and the SessionStart discovery are S7b.
 */

/** Phases at which the absence clock runs: a running stage (rank 0) and ranks 1–3. Queued, blocked and published never accrue it. */
const RUNNING_PHASES: ReadonlySet<string> = new Set(['executando', 'qa', 'ajuste'])
const RANKED_PHASES: ReadonlySet<string> = new Set(['revisao_lider', 'pr_merge', 'ci'])
export const custodyEligible = (phase: string): boolean => RUNNING_PHASES.has(phase) || RANKED_PHASES.has(phase)

export const DEFAULT_ORPHAN_HOURS = 4
export const MIN_ORPHAN_HOURS = 1
export const MAX_ORPHAN_HOURS = 48
/** The configured threshold in ms; anything outside 1–48 h (or not a number) is the default. */
export function orphanMsOf(hours: unknown): number {
  const h = typeof hours === 'number' && Number.isFinite(hours) && hours >= MIN_ORPHAN_HOURS && hours <= MAX_ORPHAN_HOURS ? hours : DEFAULT_ORPHAN_HOURS
  return h * 3600_000
}

export interface Custody {
  /** The custodian; `null` = the project leader's QUEUE (nobody live in the project). */
  sessionId: string | null
  since: string
  via: 'project-leader' | 'queue'
  /** `normalizeGitRemote(Task.repo)`, else the repo of the piece's sessions, else the sidebar folder; `''` = unknown. */
  project: string
  /** The assignment message reached the custodian (ISO). Absent = not yet delivered; the tick retries. */
  notifiedAt?: string
}

export type CustodyEvent = 'assigned' | 'queued' | 'lost' | 'ended'
export interface CustodyLogEntry { at: string; event: CustodyEvent; sessionId: string | null; reason: string }
const LOG_CAP = 20

/** What the plan reads of a delivery record (and the board's task/project facts the tick resolved). */
export interface CustodyPiece {
  key: string
  taskId: string
  phase: string
  project: string
  /** When the piece entered its current stage (the last history entry into it, else the record's creation). */
  stageSince: string
  leaderSessionId?: string
  leaderActivityAt?: string
  leaderActivityBy?: string
  leaderAbsentSince?: string | null
  custody?: Custody | null
  custodyLog?: CustodyLogEntry[]
}

/**
 * What the plan reads of a session row. `lastSeenMs`, `lastTranscriptAt` and `status` are carried ONLY so a test (and the
 * mutation control) can prove they are ignored; no rule reads them.
 */
export interface CustodySession { id: string; alive: boolean; role?: string; taskId?: string; status?: string; lastSeenMs?: number; lastTranscriptAt?: string }

export interface CustodyPatch {
  key: string
  /** Present = write it (`null` clears). Absent = unchanged. */
  absentSince?: string | null
  custody?: Custody | null
  log?: Array<Omit<CustodyLogEntry, 'at'>>
  /** The assignment message reached the custodian. */
  notified?: boolean
}
export interface CustodyAssignment { sessionId: string; project: string; keys: string[] }
export interface CustodyPlan { patches: CustodyPatch[]; assignments: CustodyAssignment[]; actions: string[] }

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null
  const v = Date.parse(iso)
  return Number.isFinite(v) ? v : null
}

export interface CustodyInput {
  now: number
  orphanMs: number
  pieces: readonly CustodyPiece[]
  /** `null` = the fleet could NOT be read. Nothing changes then: no clock advances, none clears. */
  sessions: readonly CustodySession[] | null
}

/** PURE. The whole tick's decision. */
export function planCustody(input: CustodyInput): CustodyPlan {
  const { now, orphanMs, pieces, sessions } = input
  const plan: CustodyPlan = { patches: [], assignments: [], actions: [] }
  if (!sessions) return plan
  const byId = new Map(sessions.map(s => [s.id, s] as const))
  /** A session is alive AND has taken a piece action recently enough. Future stamps (skew) count as fresh, never as older than now. */
  const age = (iso: string | undefined): number | null => { const t = ms(iso); return t === null ? null : Math.max(0, now - t) }
  const fresh = (iso: string | undefined): boolean => { const a = age(iso); return a !== null && a <= orphanMs }

  // Project leaders: a live leader with piece activity in the last N on ANY piece of the project.
  const cands = new Map<string, Map<string, number>>()
  for (const p of pieces) {
    const by = p.leaderActivityBy
    if (!by || !p.project || !fresh(p.leaderActivityAt)) continue
    const s = byId.get(by)
    if (!s?.alive || s.role !== 'leader') continue
    const at = Math.min(ms(p.leaderActivityAt)!, now)
    const m = cands.get(p.project) ?? cands.set(p.project, new Map()).get(p.project)!
    m.set(by, Math.max(m.get(by) ?? 0, at))
  }
  const bestFor = (project: string, not: ReadonlySet<string>): string | null => {
    if (!project) return null
    const m = cands.get(project)
    if (!m) return null
    // ties → most recent activity, then the smaller id
    return [...m.entries()].filter(([id]) => !not.has(id)).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0] ?? null
  }
  const assign = new Map<string, CustodyAssignment>()
  const want = (sessionId: string, project: string, key: string) => {
    const a = assign.get(sessionId) ?? assign.set(sessionId, { sessionId, project, keys: [] }).get(sessionId)!
    if (!a.keys.includes(key)) a.keys.push(key)
  }

  for (const p of pieces) {
    if (!custodyEligible(p.phase)) {
      // Published: custody ends with the piece and the clock stops. Queued / blocked: nothing accrues, nothing is touched.
      if (p.phase === 'publicado' && (p.custody || (p.leaderAbsentSince ?? null) !== null)) {
        const patch: CustodyPatch = { key: p.key, absentSince: null, custody: null }
        if (p.custody) patch.log = [{ event: 'ended', sessionId: p.custody.sessionId, reason: 'the piece was published' }]
        plan.patches.push(patch)
        plan.actions.push(`custody-ended ${p.key}: published`)
      }
      continue
    }
    const actor = p.leaderActivityBy
    const actorRow = actor ? byId.get(actor) : undefined
    // PRESENT: a live leader of THIS piece (filed, custodian, or a live leader of its task) with piece activity within N.
    const present = !!actor && !!actorRow?.alive && fresh(p.leaderActivityAt)
      && (actor === p.leaderSessionId || actor === p.custody?.sessionId || (actorRow.role === 'leader' && actorRow.taskId === p.taskId))
    const patch: CustodyPatch = { key: p.key }
    const log: NonNullable<CustodyPatch['log']> = []
    const absent = p.leaderAbsentSince ?? null

    if (present) {
      if (absent !== null) patch.absentSince = null
      // The FILED leader acted again after custody began: custody ends (recorded). A custodian's own action keeps it.
      if (p.custody && actor === p.leaderSessionId && actor !== p.custody.sessionId && (ms(p.leaderActivityAt) ?? 0) >= (ms(p.custody.since) ?? 0)) {
        patch.custody = null
        log.push({ event: 'ended', sessionId: p.custody.sessionId, reason: 'the filed leader acted on the piece again' })
        plan.actions.push(`custody-ended ${p.key}`)
      }
    } else {
      let since = absent
      if (since === null) {
        const neverLed = !p.leaderSessionId && !p.custody && !p.leaderActivityAt
        const last = ms(p.leaderActivityAt)
        since = neverLed ? p.stageSince : last !== null ? new Date(Math.min(last, now)).toISOString() : new Date(now).toISOString()
        patch.absentSince = since
      }
      const sinceMs = ms(since) ?? now
      if (now - sinceMs > orphanMs) {
        const c = p.custody ?? null
        // The custodian holds while alive and inside N of its own last action on the piece or, with none, of its assignment.
        const own = c?.sessionId && actor === c.sessionId ? ms(p.leaderActivityAt) ?? 0 : 0
        const holds = !!c?.sessionId && !!byId.get(c.sessionId)?.alive && now - Math.max(ms(c.since) ?? 0, own) <= orphanMs
        if (holds) {
          if (c && !c.notifiedAt) want(c.sessionId!, c.project, p.key)
        } else {
          const not = new Set([p.leaderSessionId, c?.sessionId].filter((x): x is string => !!x))
          const cand = bestFor(p.project, not)
          if (c?.sessionId) log.push({ event: 'lost', sessionId: c.sessionId, reason: 'the custodian is gone or took no piece action for N hours' })
          if (cand) {
            patch.custody = { sessionId: cand, since: new Date(now).toISOString(), via: 'project-leader', project: p.project }
            log.push({ event: 'assigned', sessionId: cand, reason: 'the project leader took the orphan piece' })
            want(cand, p.project, p.key)
            plan.actions.push(`custody-assigned ${p.key} → ${cand}`)
          } else if (!(c && c.sessionId === null && c.project === p.project)) {
            patch.custody = { sessionId: null, since: new Date(now).toISOString(), via: 'queue', project: p.project }
            log.push({ event: 'queued', sessionId: null, reason: 'no live leader in the project' })
            plan.actions.push(`custody-queued ${p.key}`)
          }
        }
      }
    }
    if (log.length) patch.log = log
    if (Object.keys(patch).length > 1) plan.patches.push(patch)
  }
  plan.assignments = [...assign.values()].sort((a, b) => (a.sessionId < b.sessionId ? -1 : 1))
  return plan
}

/** One stamp request: the store applies it in the SAME write as the action (store.update `stamp`). */
export interface ActivityStamp { key: string; actor: string; at: string; /** Evaluated after the write callback; `false` = the action was refused, nothing to stamp. */ when?: () => boolean }

/** Fields a write refreshes without anything having happened: they never make an action. */
const NOISE_FIELDS = ['updatedAt', 'leaderTouchedAt', 'leaderActivityAt', 'leaderActivityBy'] as const
const strip = (r: unknown): string => {
  const c = structuredClone(r) as Record<string, unknown>
  for (const k of NOISE_FIELDS) delete c[k]
  return JSON.stringify(c)
}
/**
 * PURE. Did a write change the record in any way that is not a timestamp refresh? An empty, invalid or idempotent patch is not an
 * action, so it is no activity (§5.1: the clock follows WORK, not calls). A brand-new record is a change.
 */
export function semanticallyChanged(before: unknown, after: unknown): boolean {
  if (!after) return false
  if (!before) return true
  return strip(before) !== strip(after)
}

/** What the board knows of leader work on a piece (the tick reads it under the tasks lock). */
export interface BoardActivityFacts {
  comments: ReadonlyArray<{ taskId: string; subtaskId?: string; threadId?: string; role?: string; sessionId?: string; kind?: string; createdAt: string }>
  events: ReadonlyArray<{ taskId: string; subtaskId?: string; at: string; actor: string; kind: string }>
}
/**
 * PURE. The latest board-side piece action on `piece` (§5.1): a thread comment of kind `decision`/`block` posted by a VERIFIED
 * session (`role: 'session'`, a `sessionId`) on this task/piece, and an authorized board status move by a session actor outside
 * the DeliveryService. Plain comments (no thread / no kind), unverified posters and the flow's own events never count.
 */
export function boardActivityOf(piece: { key: string; taskId: string }, facts: BoardActivityFacts): { at: string; by: string } | null {
  let best: { at: string; by: string; t: number } | null = null
  const on = (taskId: string, subtaskId: string | undefined) => taskId === piece.taskId && (subtaskId === piece.key || (subtaskId === undefined && piece.key === piece.taskId))
  const take = (at: string, by: string) => { const t = ms(at); if (t !== null && (!best || t > best.t)) best = { at, by, t } }
  for (const c of facts.comments) {
    if (!c.threadId || (c.kind !== 'decision' && c.kind !== 'block') || c.role !== 'session' || !c.sessionId || !on(c.taskId, c.subtaskId)) continue
    take(c.createdAt, c.sessionId)
  }
  for (const e of facts.events) {
    if (e.kind !== 'status' || !e.actor || e.actor === 'owner' || e.actor.startsWith('flow:') || !on(e.taskId, e.subtaskId)) continue
    take(e.at, e.actor)
  }
  const b = best as { at: string; by: string } | null
  return b ? { at: b.at, by: b.by } : null
}

/** PURE. The piece-activity stamp the service writes when the actor leads (or holds custody of) the piece. Mutates and returns `rec`. */
export function stampActivity<T extends { leaderActivityAt?: string; leaderActivityBy?: string }>(rec: T, actor: string, at: string): T {
  rec.leaderActivityAt = at
  rec.leaderActivityBy = actor
  return rec
}

/** PURE. A patch applied to a record's custody fields (the tick persists exactly this; a test reuses it as the "stored state"). */
export function applyCustodyPatch<T extends Pick<CustodyPiece, 'leaderAbsentSince' | 'custody' | 'custodyLog'>>(rec: T, patch: CustodyPatch, at: string): T {
  const next: T = { ...rec }
  if ('absentSince' in patch) next.leaderAbsentSince = patch.absentSince ?? null
  if ('custody' in patch) { if (patch.custody) next.custody = patch.custody; else delete next.custody }
  if (patch.notified && next.custody) next.custody = { ...next.custody, notifiedAt: at }
  if (patch.log?.length) next.custodyLog = [...(next.custodyLog ?? []), ...patch.log.map(l => ({ ...l, at }))].slice(-LOG_CAP)
  return next
}

/**
 * PURE. What a surface says of a piece: `no-leader` is valid ONLY while now − leaderAbsentSince ≤ N; past it the piece is an
 * `orphan` (custody or the queue). `led` = no absence on record (or a piece the clocks do not apply to).
 */
export function custodyView(p: Pick<CustodyPiece, 'phase' | 'leaderAbsentSince'>, now: number, orphanMs: number): 'led' | 'no-leader' | 'orphan' {
  if (!custodyEligible(p.phase)) return 'led'
  const since = ms(p.leaderAbsentSince ?? undefined)
  if (since === null) return 'led'
  return now - since > orphanMs ? 'orphan' : 'no-leader'
}

/** The message a custodian receives when the tick assigns it pieces — ONE per custodian per tick, however many pieces. */
export function assignmentText(a: CustodyAssignment, titles: ReadonlyMap<string, string> = new Map()): string {
  const list = a.keys.map(k => `${k}${titles.get(k) ? ` (${titles.get(k)})` : ''}`).join(', ')
  return `[from flow custódia · peças sem líder]\n${a.keys.length} peça(s) do projeto ${a.project || '?'} ficaram sem líder há mais de N horas e passaram para a sua custódia: ${list}.\n`
    + `Custódia autoriza você a conduzir a peça (aprovar os portões do líder, declarar o release); NÃO substitui evidência nem prova — subir de fase continua exigindo as duas. Se o líder original voltar a agir na peça, a custódia termina.\n`
    + `${a.keys.length} piece(s) of project ${a.project || '?'} have had no leader for over N hours and are now in your custody: ${list}. Custody lets you drive them (approve the leader gates, declare the release); it is not evidence or proof.`
}

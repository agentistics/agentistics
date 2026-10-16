/**
 * PLAN LIMITS — the host half. Keeps the LAST record per harness account (core `planLimits.ts`
 * parses and decides everything), persists it beside the notifier's memory, raises the threshold
 * notices once per threshold per window period, and tells the browser over the existing SSE stream
 * (`event: plan-limits`, an empty refresh signal — the stream is shared, the data is a scoped GET).
 *
 * Two taps, both reading what the harness already wrote (no request that would spend quota):
 * - claude: every stdout line a STRUCTURED (web-born) session's relay delivers
 *   (`structured-durable.ts`), cheap-filtered on the literal `rate_limit_event` before parsing;
 * - claude (TUI sessions): `claude-usage.ts` polls the subscription usage endpoint Claude Code's own
 *   `/usage` reads, with the login it already keeps — the TUI writes no stream-json to tap;
 * - codex: the tail of a rollout file the session-directory watcher saw change (`sse.ts`).
 * At boot the newest few of each are read once, so a restart does not forget the last value.
 */
import { readFile, readdir, stat, writeFile, rename, mkdir } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { watch as fsWatch } from 'node:fs'
import {
  agentVisible, alternativeWithRoom, HARNESS_ORDER, meterDiscontinuity, newerLimits, parseClaudeRateLimitEvent,
  parseCodexRateLimits, planBudget, planPace, planThresholdNotices, registeredPlanLabel, resetNoticesFor, withPlanLabel,
  type HarnessId,
  type LivePlanSession, type PlanLimits, type PlanNoticeState, type PlanThresholdNotice,
} from '@agentistics/core'
import { AGENTISTICS_DATA_DIR, CODEX_DIR, CODEX_SESSIONS_DIR } from './config'
import {
  bind, byId, currentHarnessAccounts, forceProbe, hasIdentityProbe, readAccounts, startSegment,
} from './harness-accounts'
import { readTailBytes, windowLines } from './sessions/transcript-window'
import { harnessSpawnabilities, type HarnessSpawnability } from './sessions/harness-spawnable'

let filePath: string | null = null
const FILE = (): string => filePath ?? join(AGENTISTICS_DATA_DIR, 'plan-limits.json')

interface Persisted { limits: Record<string, PlanLimits>; notices: PlanNoticeState }

let state: Persisted = { limits: {}, notices: {} }
const history = new Map<string, PlanLimits[]>()
let loaded: Promise<void> | null = null

type LiveUsageSample = { tokens: number; at: number; model: string; harness: HarnessId }
const liveUsage = new Map<string, LiveUsageSample>()
const isHarnessId = (value: string): value is HarnessId => HARNESS_ORDER.some(harness => harness === value)

/** Turn the live fleet's rolling token deltas into percentages of each plan's measured burn. */
export function sampleLivePlanSessions(
  sessions: readonly { session_id: string; harness: string; model?: string; input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }[],
  liveIds: readonly string[],
  nowMs: number,
  burnByHarness: Partial<Record<HarnessId, number>> = {},
  working?: ReadonlySet<string>,
): LivePlanSession[] {
  const wanted = new Set(liveIds)
  for (const id of liveUsage.keys()) if (!wanted.has(id)) liveUsage.delete(id)
  const rates = new Map<string, { session: typeof sessions[number]; rate: number; harness: HarnessId }>()
  for (const s of sessions) {
    if (!isHarnessId(s.harness)) continue
    if (!wanted.has(s.session_id)) continue
    const tokens = (s.input_tokens ?? 0) + (s.output_tokens ?? 0) + (s.cache_read_input_tokens ?? 0) + (s.cache_creation_input_tokens ?? 0)
    const previous = liveUsage.get(s.session_id)
    const recent = previous && previous.harness === s.harness && nowMs >= previous.at && nowMs - previous.at <= 10 * 60_000
    const rate = recent ? Math.max(0, tokens - previous.tokens) : 0
    liveUsage.set(s.session_id, { tokens, at: nowMs, model: s.model ?? 'unknown', harness: s.harness })
    if (working?.has(s.session_id) || rate > 0) rates.set(s.session_id, { session: s, rate, harness: s.harness })
  }
  for (const harness of new Set([...rates.values()].map(x => x.harness))) {
    const group = [...rates.entries()].filter(([, x]) => x.harness === harness)
    const total = group.reduce((n, [, x]) => n + x.rate, 0)
    const burn = Math.max(0, burnByHarness[harness] ?? 0)
    for (const [, x] of group) x.rate = total > 0 ? burn * x.rate / total : 0
  }
  return [...rates].map(([id, x]) => ({ id, model: x.session.model ?? 'unknown', burnPctPerHour: x.rate, harness: x.harness }))
}

const keyOf = (l: Pick<PlanLimits, 'harness' | 'account'>): string => `${l.harness}:${l.account}`

type Sink = {
  notify: (n: PlanThresholdNotice, alt: string | null) => void
  changed: () => void
  /** Spec §5: a sharp drop the probe could not explain — this account counts from zero again. */
  segment?: (s: { harness: HarnessId; account: string; at: number }) => void
}
/**
 * Set ONLY in the server process, which makes it the OWNER: the one process that raises notices and
 * tells the browser. Other agentop processes (the watcher daemon, a CLI command, a relay host) can
 * see a record first — they store it in the shared file and nothing more, and the owner picks it up
 * from there (`syncPlanLimitsFromFile`). Holding the state only in memory was the bug: a record
 * written by another process never reached the server, so the Limits tab kept saying "not reported".
 */
let sink: Sink | null = null

/** Wired once by the server (sse.ts owns the stream and the notification path). */
export function setPlanLimitsSink(s: Sink | null): void { sink = s }

async function readFileState(): Promise<Persisted | null> {
  try {
    const raw = JSON.parse(await readFile(FILE(), 'utf8')) as Partial<Persisted>
    return {
      limits: raw.limits && typeof raw.limits === 'object' ? raw.limits : {},
      notices: raw.notices && typeof raw.notices === 'object' ? raw.notices : {},
    }
  } catch { return null }
}

function load(): Promise<void> {
  loaded ??= (async () => {
    const f = await readFileState()
    if (f) state = f
    try { fileMtime = (await stat(FILE())).mtimeMs } catch { /* absent */ }
    if (f && await migrateDefaultRecords()) persistSoon()
  })()
  return loaded
}

/** Legacy `<harness>:default` keys re-keyed to an account id; the persist drops them from the file. */
const migratedAway = new Set<string>()

/**
 * Step 4 of C1: a meter recorded before accounts existed (`account: 'default'`) belongs to the
 * account the DEFAULT root is bound to — a binding exists only after a CONFIRMED probe, so nothing
 * is re-keyed on a guess. With no binding the record stays where it is. Notice state moves with it.
 */
async function migrateDefaultRecords(): Promise<boolean> {
  const legacy = Object.entries(state.limits).filter(([, l]) => l.account === 'default')
  if (!legacy.length) return false
  let bindings: Record<string, string>
  try { bindings = (await readAccounts()).bindings } catch { return false }
  let moved = false
  for (const [oldKey, l] of legacy) {
    const id = bindings[`${l.harness}:`]
    if (!id) continue
    const next = { ...l, account: id }
    const newKey = keyOf(next)
    state.limits[newKey] = state.limits[newKey] ? newerLimits(state.limits[newKey], next) : next
    delete state.limits[oldKey]
    migratedAway.add(oldKey)
    for (const [k, v] of Object.entries(state.notices)) {
      if (!k.startsWith(`${oldKey}:`)) continue
      const nk = `${newKey}:${k.slice(oldKey.length + 1)}`
      if (!state.notices[nk]) state.notices[nk] = v
      delete state.notices[k]
    }
    const h = history.get(oldKey)
    if (h) { history.set(newKey, [...(history.get(newKey) ?? []), ...h.map(x => ({ ...x, account: id }))]); history.delete(oldKey) }
    moved = true
  }
  return moved
}

let fileMtime = 0
let persistTimer: ReturnType<typeof setTimeout> | null = null
let persistOff = false
function persistSoon(): void {
  if (persistTimer || persistOff) return
  persistTimer = setTimeout(() => {
    persistTimer = null
    void (async () => {
      // MERGE with what is on disk: another process may have written a newer record since we
      // read. Records: newer wins per account. Notices: only the owner's memory is authoritative.
      const disk = await readFileState()
      const limits = { ...(disk?.limits ?? {}) }
      for (const [k, l] of Object.entries(state.limits)) limits[k] = newerLimits(limits[k], l)
      for (const k of migratedAway) delete limits[k]
      const out: Persisted = { limits, notices: sink ? state.notices : (disk?.notices ?? state.notices) }
      const tmp = `${FILE()}.${process.pid}.tmp`
      await mkdir(dirname(FILE()), { recursive: true })
      await writeFile(tmp, JSON.stringify(out), { mode: 0o600 })
      await rename(tmp, FILE())
      try { fileMtime = (await stat(FILE())).mtimeMs } catch { /* raced */ }
    })().catch(() => { /* a lost write costs one record, re-read on the next turn */ })
  }, 500)
  persistTimer.unref?.()
}

/** Store `l` when it is newer than what is held; notices and the SSE signal follow a real change. */
export async function ingestPlanLimits(l: PlanLimits): Promise<boolean> {
  await load()
  const key = keyOf(l)
  if (migratedAway.has(key)) return false
  const held = state.limits[key]
  if (held && newerLimits(held, l) === held) return false
  let newSegment = false
  if (held && l.account !== 'default' && meterDiscontinuity(held, l)) {
    const switched = await accountSwitch(l)
    // Signal 1: the root now holds ANOTHER login — the reading is that account's; the held one
    // (and its hold) is left exactly as it was.
    if (switched) return ingestPlanLimits({ ...l, account: switched })
    // Same login, or a harness that cannot say: a new segment for this account (spec §5).
    newSegment = true
    segmentStarts.set(l.account, l.updatedAt)
    history.delete(key)
    state.notices = resetNoticesFor(state.notices, l.harness, l.account)
    await startSegment(l.account, l.updatedAt).catch(() => {})
  }
  state.limits[key] = l
  const readings = history.get(key) ?? []
  readings.push(l)
  const cutoff = l.updatedAt - 7 * 24 * 3_600_000
  history.set(key, readings.filter(x => x.updatedAt >= cutoff).slice(-32))
  // Only the owner judges thresholds: a notice decided by a process that cannot raise it would be
  // recorded as told and never reach anyone.
  const notices: PlanThresholdNotice[] = []
  if (sink) {
    const r = planThresholdNotices(state.notices, l)
    state.notices = r.state
    notices.push(...r.notices)
  }
  persistSoon()
  const all = Object.values(state.limits)
  if (newSegment) sink?.segment?.({ harness: l.harness, account: l.account, at: l.updatedAt })
  for (const n of notices) sink?.notify(n, n.threshold >= 100 ? alternativeWithRoom(all, n.harness, Date.now()) : null)
  sink?.changed()
  return true
}

/** Segment starts this process knows of (the registry's `segments` is the durable copy). */
const segmentStarts = new Map<string, number>()

/**
 * A discontinuous reading: re-probe the account's root, bypassing the 60 s cache. A confirmed
 * DIFFERENT key re-binds the root and answers the account the reading belongs to; anything else
 * (same key, no probe for this harness, a probe that could not tell) answers null.
 */
async function accountSwitch(l: PlanLimits): Promise<string | null> {
  if (!hasIdentityProbe(l.harness)) return null
  try {
    const account = await byId(l.account)
    if (!account) return null
    const identity = await forceProbe(l.harness, account.root)
    if (identity.key === 'default' || identity.key === account.key) return null
    const bound = await bind(account.root, { ...identity, harness: l.harness })
    return bound.account.id === l.account ? null : bound.account.id
  } catch { return null }
}

/**
 * Take in what ANOTHER process wrote to the shared file: every record newer than the one held goes
 * through `ingestPlanLimits`, so the owner raises its notices and tells the browser. Cheap when
 * nothing changed (one `stat`). Returns how many records were new.
 */
export async function syncPlanLimitsFromFile(): Promise<number> {
  await load()
  let m = 0
  try { m = (await stat(FILE())).mtimeMs } catch { return 0 }
  if (m === fileMtime) return 0
  fileMtime = m
  const disk = await readFileState()
  if (!disk) return 0
  let n = 0
  for (const l of Object.values(disk.limits)) if (await ingestPlanLimits(l)) n++
  return n
}

const fileWatchers = new Set<ReturnType<typeof fsWatch>>()

/** The server watches the shared file so a record another process wrote reaches the browser at once. */
export function watchPlanLimitsFile(): () => void {
  let t: ReturnType<typeof setTimeout> | null = null
  const kick = () => {
    if (t) return
    t = setTimeout(() => { t = null; void syncPlanLimitsFromFile().catch(() => {}) }, 200)
    t.unref?.()
  }
  let w: ReturnType<typeof fsWatch> | null = null
  try {
    w = fsWatch(dirname(FILE()), { persistent: false }, (_e, name) => {
      // PREFIX, not the exact name: every writer replaces the file by an atomic rename of
      // `plan-limits.json.<pid>.tmp`, and Bun reports that rename under the SOURCE name only.
      if (String(name).startsWith(basename(FILE()))) kick()
    })
    // Held at module level: a watcher nothing references can be collected, and then it stops firing.
    fileWatchers.add(w)
  } catch { /* no watch: the GET still syncs on read */ }
  return () => { if (w) { w.close(); fileWatchers.delete(w) } if (t) clearTimeout(t) }
}

/**
 * WHOSE meter a reading is (spec §5 "Attribution"). Parsers emit `'default'`; a tap rewrites it
 * before ingest. A reading from the DEFAULT root takes that root's binding and, with none yet,
 * stays `'default'` (exactly the pre-accounts behaviour; the load migration re-keys it once a
 * probe confirms the login). A reading from any other root takes that root's binding or is
 * DROPPED (null): a meter under the wrong account is worse than none — it lifts a hold.
 */
export async function attributeReading(harness: HarnessId, root: string | null): Promise<string | null> {
  let bindings: Record<string, string> = {}
  try { bindings = (await readAccounts()).bindings } catch { /* unreadable registry: as if empty */ }
  return bindings[`${harness}:${root ?? ''}`] ?? (root === null ? 'default' : null)
}

/** Ingest a reading from `root` once attributed; dropped when the account cannot be determined. */
export async function ingestFromRoot(l: PlanLimits, root: string | null, accountId?: string): Promise<boolean> {
  const account = accountId || await attributeReading(l.harness, root)
  if (!account) return false
  return ingestPlanLimits({ ...l, account })
}

/**
 * Where each harness keeps its rollouts, per config root: a reading is attributed by the root its
 * file sits under. Only harnesses whose meter is a FILE are here; the rest have no path tap.
 */
const ROLLOUT_HOME: Record<HarnessId, { home: () => string; sub: string } | null> = {
  claude: null, codex: { home: () => CODEX_DIR, sub: 'sessions' },
  gemini: null, copilot: null, antigravity: null, kimi: null, opencode: null,
}

/**
 * The root a rollout path belongs to: the default home (null) or an account root the registry
 * binds. `undefined` when it sits under none of them — such a reading is dropped.
 */
export async function rolloutRoot(harness: HarnessId, path: string): Promise<string | null | undefined> {
  const spec = ROLLOUT_HOME[harness]
  if (!spec) return undefined
  const under = (dir: string) => resolve(path).startsWith(`${resolve(dir, spec.sub)}${sep}`)
  let roots: string[] = []
  try {
    const prefix = `${harness}:`
    roots = Object.keys((await readAccounts()).bindings).filter(k => k.startsWith(prefix) && k.length > prefix.length)
      .map(k => k.slice(prefix.length))
  } catch { /* unreadable registry: only the default home is known */ }
  // The longest match wins, so an account root nested under the default home is not mistaken for it.
  const hit = roots.filter(under).sort((a, b) => b.length - a.length)[0]
  if (hit) return hit
  return under(spec.home()) ? null : undefined
}

type ManagedLookup = () => Promise<readonly { id: string; conversationId?: string; accountId?: string }[]>
let managedLookup: ManagedLookup = async () => (await import('./sessions/registry')).readRegistry()

/** The account a managed session runs on (`ManagedSession.accountId`), when it carries one. */
export async function managedAccountOf(by: { id?: string; conversationId?: string }): Promise<string | undefined> {
  try {
    const rows = await managedLookup()
    const hit = rows.find(r => (by.id && r.id === by.id) || (by.conversationId && r.conversationId === by.conversationId))
    return hit?.accountId || undefined
  } catch { return undefined }
}

/** Tests only: the managed-session rows attribution reads. */
export function __setManagedLookupForTest(f: ManagedLookup | null): void {
  managedLookup = f ?? (async () => (await import('./sessions/registry')).readRegistry())
}

/**
 * The claude tap: one raw stream-json line as the relay delivered it. `accountId` is the
 * structured session's `ManagedSession.accountId` (or a lookup, called only for a rate-limit
 * line); a session started before accounts existed carries none and is the default root's.
 * Never throws.
 */
export function noteStructuredLine(
  line: string, atMs: number,
  accountId?: string | Promise<string | undefined> | (() => Promise<string | undefined>),
): void {
  if (!line.includes('rate_limit_event')) return
  let parsed: unknown
  try { parsed = JSON.parse(line) } catch { return }
  const l = parseClaudeRateLimitEvent(parsed, atMs)
  if (!l) return
  void Promise.resolve().then(() => typeof accountId === 'function' ? accountId() : accountId)
    .then(a => ingestFromRoot(l, null, a)).catch(() => {})
}

/** The newest `rate_limits` record in the last 256 KB of a codex rollout, or null. */
export async function latestCodexLimits(path: string): Promise<PlanLimits | null> {
  const tail = await readTailBytes(path, 256 * 1024)
  if (!tail) return null
  const lines = windowLines(tail)
  for (let i = lines.length - 1; i >= 0; i--) {
    const s = lines[i]!
    if (!s.includes('"rate_limits"')) continue
    try {
      const l = parseCodexRateLimits(JSON.parse(s))
      if (l) return l
    } catch { /* a partial line: keep looking */ }
  }
  return null
}

const codexPending = new Map<string, ReturnType<typeof setTimeout>>()
const codexInFlight = new Set<Promise<unknown>>()
const readRollout = (path: string): void => {
  codexPending.delete(path)
  const p = latestCodexLimits(path).then(l => { if (l) return ingestRollout(l, path) }).catch(() => {})
  codexInFlight.add(p)
  void p.finally(() => codexInFlight.delete(p))
}
/** The codex tap: a rollout the watcher saw change. Debounced per file (a turn writes many lines). */
export function noteCodexRollout(path: string): void {
  if (!/rollout-.*\.jsonl$/.test(path) || codexPending.has(path)) return
  const t = setTimeout(() => readRollout(path), 1000)
  t.unref?.()
  codexPending.set(path, t)
}

/** Tests only: run every debounced rollout read now and wait until each has been ingested. */
export async function __settleCodexRolloutsForTest(): Promise<void> {
  for (const [path, t] of [...codexPending]) { clearTimeout(t); readRollout(path) }
  while (codexInFlight.size) await Promise.all([...codexInFlight])
}

const CONVERSATION_IN_NAME = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i

/**
 * A rollout reading is the account of the managed session that links its conversation when there
 * is one, else the binding of the root the file sits under; under no known root it is dropped.
 */
export async function ingestRollout(l: PlanLimits, path: string): Promise<boolean> {
  const conversationId = CONVERSATION_IN_NAME.exec(basename(path))?.[1]
  const linked = conversationId ? await managedAccountOf({ conversationId }) : undefined
  if (linked) return ingestPlanLimits({ ...l, account: linked })
  const root = await rolloutRoot(l.harness, path)
  if (root === undefined) return false
  return ingestFromRoot(l, root)
}

async function newestFiles(dir: string, match: (name: string) => boolean, depth: number, limit: number): Promise<string[]> {
  // Date-named directories (codex `YYYY/MM/DD`) sort lexically; walk the newest few only.
  const out: { p: string; m: number }[] = []
  const walk = async (d: string, left: number): Promise<void> => {
    let names: string[]
    try { names = await readdir(d) } catch { return }
    if (left > 0) {
      for (const n of names.sort().reverse().slice(0, 2)) await walk(join(d, n), left - 1)
      return
    }
    for (const n of names) {
      if (!match(n)) continue
      try { out.push({ p: join(d, n), m: (await stat(join(d, n))).mtimeMs }) } catch { /* gone */ }
    }
  }
  await walk(dir, depth)
  return out.sort((a, b) => b.m - a.m).slice(0, limit).map(x => x.p)
}

/** Boot: read the newest structured streams and codex rollouts once. */
export async function seedPlanLimits(structuredDir: string): Promise<void> {
  await load()
  // structured/<id>/out.jsonl — newest five by mtime.
  let ids: string[] = []
  try { ids = await readdir(structuredDir) } catch { /* none yet */ }
  const outs: { p: string; m: number }[] = []
  for (const id of ids) {
    const p = join(structuredDir, id, 'out.jsonl')
    try { outs.push({ p, m: (await stat(p)).mtimeMs }) } catch { /* no stream */ }
  }
  outs.sort((a, b) => b.m - a.m)
  for (const { p } of outs.slice(0, 5)) {
    const account = managedAccountOf({ id: basename(dirname(p)) })
    const tail = await readTailBytes(p, 256 * 1024)
    if (!tail) continue
    const lines = windowLines(tail)
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i]!.includes('rate_limit_event')) continue
      try {
        const rec = JSON.parse(lines[i]!) as { t?: unknown; l?: unknown }
        if (typeof rec.l !== 'string' || typeof rec.t !== 'number') continue
        const l = parseClaudeRateLimitEvent(JSON.parse(rec.l), rec.t)
        if (l) { await ingestFromRoot(l, null, await account); break }
      } catch { /* keep looking */ }
    }
  }
  for (const p of await newestFiles(CODEX_SESSIONS_DIR, n => /^rollout-.*\.jsonl$/.test(n), 3, 3)) {
    const l = await latestCodexLimits(p)
    if (l) await ingestRollout(l, p)
  }
}

/** What `GET /api/plan-limits` answers: every account observed, with its registered plan name. */
export async function planLimitsPayload(
  billing: Parameters<typeof withPlanLabel>[1],
  nowMs = Date.now(),
  liveSessions: readonly LivePlanSession[] = [],
): Promise<{ harnesses: Partial<Record<HarnessId, HarnessSpawnability>>; limits: PlanLimits[]; registered: { harness: HarnessId; plan: string }[]; budgets: Array<ReturnType<typeof planBudget> & ReturnType<typeof planPace>>; hiddenFromAgents: Array<ReturnType<typeof planBudget> & ReturnType<typeof planPace>>; freeSlots: number; freeSlotsByHarness: Partial<Record<HarnessId, number>>; liveSessions: LivePlanSession[]; pauseUntil?: number; now: number }> {
  await syncPlanLimitsFromFile()
  let registrySegments: Record<string, number> = {}
  try { registrySegments = (await readAccounts()).segments } catch { /* none known */ }
  const segmentOf = (account: string): number | undefined => {
    const starts = [segmentStarts.get(account), registrySegments[account]].filter((v): v is number => v !== undefined)
    return starts.length ? Math.max(...starts) : undefined
  }
  const limits = Object.values(state.limits)
    .map(l => withPlanLabel(l, billing, nowMs))
    .sort((a, b) => a.harness.localeCompare(b.harness))
  // Plans registered in Settings → Billing whose harness has reported no window yet: listed by
  // name with NO meters (nothing observed is not nothing used).
  const registered: { harness: HarnessId; plan: string }[] = []
  for (const h of Object.keys(billing?.profiles ?? {}) as HarnessId[]) {
    const plan = registeredPlanLabel(billing, h, nowMs)
    if (plan && !limits.some(l => l.harness === h)) registered.push({ harness: h, plan })
  }
  const currentAccounts = await currentHarnessAccounts([
    ...limits.map(l => l.harness),
    ...liveSessions.flatMap(s => s.harness ? [s.harness] : []),
  ])
  const harnesses = harnessSpawnabilities(nowMs)
  const allBudgets = limits.map(l => {
    const budget = planBudget(l, nowMs)
    // Only measured sessions enter planSlots' per-session average. Working sessions with no
    // billed tokens remain in the public live summary, without diluting the measured burn.
    const planSessions = liveSessions.filter(s => s.burnPctPerHour > 0 && (!s.harness || s.harness === l.harness))
    const availability = harnesses[l.harness]!
    return { ...budget, ...planPace(l, nowMs, history.get(keyOf(l)) ?? [], planSessions, segmentOf(l.account)), ...availability,
      ...(!availability.spawnable ? { freeSlots: 0, suggestedParallel: 0 } : {}),
    }
  })
  // Legacy meters are `'default'`; the harness-level login stands in for the registry until C1.
  const budgets = agentVisible(
    allBudgets.map(b => ({ ...b, account: 'default' })),
    currentAccounts.map(a => ({ id: `${a.harness}:current`, harness: a.harness, available: a.available })),
  ).map(({ account: _account, ...b }) => b)
  const keep = new Set(budgets.map(b => b.harness))
  const hiddenFromAgents = allBudgets.filter(b => !keep.has(b.harness))
  const freeSlotsByHarness = Object.fromEntries(budgets.map(b => [b.harness, b.freeSlots])) as Partial<Record<HarnessId, number>>
  // A caller choosing a harness must not be blocked by another harness's exhausted plan.
  const availableBudgets = budgets.filter(b => b.spawnable && b.status !== 'hold')
  const freeSlots = availableBudgets.length ? Math.max(...availableBudgets.map(b => b.freeSlots)) : 0
  const pauseUntil = budgets.map(b => b.pauseUntil).filter((v): v is number => v !== undefined).sort((a, b) => a - b)[0]
  const hiddenHarnesses = new Set(currentAccounts.filter(a => !a.available).map(a => a.harness))
  const publicLiveSessions = liveSessions.filter(s => !s.harness || !hiddenHarnesses.has(s.harness)).map(({ harness: _harness, ...s }) => s)
  // Hidden-from-agents wins over spawnability: a hidden harness must not be named in the map.
  const publicHarnesses = Object.fromEntries(Object.entries(harnesses).filter(([h]) => !hiddenHarnesses.has(h as HarnessId))) as Partial<Record<HarnessId, HarnessSpawnability>>
  return { harnesses: publicHarnesses, limits, registered, budgets, hiddenFromAgents, freeSlots, freeSlotsByHarness, liveSessions: publicLiveSessions, ...(pauseUntil !== undefined ? { pauseUntil } : {}), now: nowMs }
}

/** Tests only. */
export function __resetPlanLimitsForTest(file: string | null = null): void {
  for (const t of codexPending.values()) clearTimeout(t)
  codexPending.clear()
  state = { limits: {}, notices: {} }
  history.clear()
  segmentStarts.clear()
  migratedAway.clear()
  // Without a file of its own, a test must never sync the REAL data dir's file (the hook runs with
  // the owner's HOME): a path that cannot exist keeps `syncPlanLimitsFromFile` empty.
  filePath = file ?? join(AGENTISTICS_DATA_DIR, `.plan-limits-test-none-${process.pid}`, 'plan-limits.json')
  liveUsage.clear()
  fileMtime = 0
  loaded = file ? null : Promise.resolve()
  persistOff = file === null
}

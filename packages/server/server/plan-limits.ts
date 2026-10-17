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
  agentVisible, alternativeWithRoom, harnessAggregate, HARNESS_LABELS, HARNESS_ORDER, meterDiscontinuity, newerLimits, parseClaudeRateLimitEvent,
  parseCodexRateLimits, planBudget, planPace, planThresholdNotices, registeredPlanLabel, resetNoticesFor, withPlanLabel, yieldStaleRows,
  type HarnessId,
  type LivePlanSession, type PlanLimits, type PlanNoticeState, type PlanThresholdNotice,
} from '@agentistics/core'
import { AGENTISTICS_DATA_DIR, ANTIGRAVITY_DIR, CLAUDE_DIR, CODEX_DIR, CODEX_SESSIONS_DIR, COPILOT_DIR, GEMINI_DIR, KIMI_DIR, OPENCODE_DIR } from './config'
import {
  bind, byId, canonicalAccountId, forceProbe, sameLogin, hasIdentityProbe, listHarnessAccounts, readAccounts, startSegment, type AccountsFile,
} from './harness-accounts'
import { withFileLock } from './sessions/file-lock'
import { readTailBytes, windowLines } from './sessions/transcript-window'
import { harnessSpawnabilities, type HarnessSpawnability } from './sessions/harness-spawnable'

let filePath: string | null = null
const FILE = (): string => filePath ?? join(AGENTISTICS_DATA_DIR, 'plan-limits.json')

interface Persisted { limits: Record<string, PlanLimits>; notices: PlanNoticeState }

let state: Persisted = { limits: {}, notices: {} }
const history = new Map<string, PlanLimits[]>()
let loaded: Promise<void> | null = null

type LiveUsageSample = { tokens: number; at: number; model: string; harness: HarnessId; account?: string }
const liveUsage = new Map<string, LiveUsageSample>()
/** The account a transcript path resolved to, per session: one root scan per session, not per request.
 *  `viaDefault`: the account came from the default home's binding (a guess), not an explicit root. */
const pathAccounts = new Map<string, { harness: HarnessId; account: string; viaDefault: boolean }>()
const isHarnessId = (value: string): value is HarnessId => HARNESS_ORDER.some(harness => harness === value)

/** One key for both the API's measured budgets and the sampler's resolved accounts. */
export const planAccountKey = (harness: HarnessId, account = 'default'): string => `${harness}:${account}`

const sessionHomes: Record<HarnessId, string> = {
  claude: CLAUDE_DIR, codex: CODEX_DIR, gemini: GEMINI_DIR, copilot: COPILOT_DIR,
  kimi: KIMI_DIR, antigravity: ANTIGRAVITY_DIR, opencode: OPENCODE_DIR,
}

/** Explicit managed ids and transcript roots win over the default/only-visible fallback. */
function fallbackSessionAccount(harness: HarnessId, registry: AccountsFile, visible: readonly string[]): string | undefined {
  const bound = registry.bindings[`${harness}:`]
  // A default binding that points at a hidden or retired account must not swallow default-home
  // sessions while exactly one other account is the visible one.
  const boundGone = bound !== undefined && registry.accounts.some(a => a.id === bound && (!a.available || a.retired))
  if (bound && !(boundGone && visible.length === 1)) return bound
  return visible.length === 1 ? visible[0] : undefined
}

type LiveSessionRef = { session_id: string; harness: string; native_session_id?: string; project_path?: string }
const resolveLiveTranscriptPath = async (s: LiveSessionRef, bindings: Record<string, string>): Promise<string | null> => {
  const readers = await import('./sessions/harness-transcript')
  const ref = { conversationId: s.native_session_id ?? s.session_id, cwd: s.project_path }
  const prefix = `${s.harness}:`
  const roots = Object.keys(bindings).filter(k => k.startsWith(prefix) && k.length > prefix.length).map(k => k.slice(prefix.length))
  // Search registered roots as well as the harness's normal home. No conversation content is read.
  for (const root of roots) {
    let path: string | null = null
    switch (s.harness) {
      case 'claude': {
        const { resolveChatTranscriptPath } = await import('./sessions/chat-tail')
        path = await resolveChatTranscriptPath(s.project_path ?? '', ref.conversationId, join(root, 'projects'))
        break
      }
      case 'codex': path = await readers.resolveCodexTranscript(ref, join(root, 'sessions')); break
      case 'gemini': path = await readers.resolveGeminiTranscript(ref, join(root, 'tmp')); break
      case 'copilot': path = await readers.resolveCopilotTranscript(ref, join(root, 'session-state')); break
      case 'kimi': path = await readers.resolveKimiTranscript(ref, join(root, 'sessions')); break
      case 'antigravity': path = await readers.resolveAntigravityTranscript(ref, join(root, 'brain')); break
    }
    if (path) return path
  }
  return readers.transcriptReaderFor(s.harness)?.resolve(ref) ?? null
}
let liveTranscriptPath = resolveLiveTranscriptPath
/** Tests only: avoid looking for transcripts in the owner's home. */
export function __setLiveTranscriptPathForTest(f: typeof liveTranscriptPath | null): void { liveTranscriptPath = f ?? resolveLiveTranscriptPath }

function accountAtPath(harness: HarnessId, path: string, bindings: Record<string, string>, retired: ReadonlySet<string> = new Set()): string | undefined {
  return attributeAtPath(harness, path, bindings, retired)?.account
}

function attributeAtPath(harness: HarnessId, path: string, bindings: Record<string, string>, retired: ReadonlySet<string> = new Set()): { account: string; viaDefault: boolean } | undefined {
  const prefix = `${harness}:`
  const under = (root: string) => resolve(path).startsWith(`${resolve(root)}${sep}`)
  const root = Object.keys(bindings).filter(k => k.startsWith(prefix) && k.length > prefix.length)
    .map(k => k.slice(prefix.length)).filter(under).sort((a, b) => b.length - a.length)[0]
  if (root) { const account = bindings[`${prefix}${root}`]; return account ? { account, viaDefault: false } : undefined }
  if (!under(sessionHomes[harness])) return undefined
  // The DEFAULT home's binding is a guess about whoever signed in there last: when it names an account
  // that has since signed out it says nothing about this session, unlike an explicit per-root binding.
  const dflt = bindings[prefix]
  return dflt && !retired.has(dflt) ? { account: dflt, viaDefault: true } : undefined
}

/** Turn the live fleet's rolling token deltas into percentages of each plan's measured burn. */
export async function sampleLivePlanSessions(
  sessions: readonly { session_id: string; harness: string; native_session_id?: string; project_path?: string; model?: string; input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }[],
  liveIds: readonly string[],
  nowMs: number,
  burnByAccount: Readonly<Record<string, number>> = {},
  working?: ReadonlySet<string>,
): Promise<LivePlanSession[]> {
  const registry = await readAccounts().catch((): AccountsFile => ({ version: 2, accounts: [], bindings: {}, segments: {} }))
  const managed = await managedLookup().catch(() => [])
  const managedAccounts = new Map<string, string>()
  for (const row of managed) if (row.accountId) {
    const accountId = canonicalAccountId(registry, row.accountId)
    managedAccounts.set(row.id, accountId)
    if (row.conversationId) managedAccounts.set(row.conversationId, accountId)
  }
  const wanted = new Set(liveIds)
  for (const id of liveUsage.keys()) if (!wanted.has(id)) liveUsage.delete(id)
  for (const id of pathAccounts.keys()) if (!wanted.has(id)) pathAccounts.delete(id)
  const rates = new Map<string, { session: typeof sessions[number]; rate: number; harness: HarnessId; account?: string }>()
  for (const s of sessions) {
    if (!isHarnessId(s.harness)) continue
    if (!wanted.has(s.session_id)) continue
    let account = managedAccounts.get(s.session_id) ?? (s.native_session_id ? managedAccounts.get(s.native_session_id) : undefined)
    if (!account) {
      const retiredIds = new Set(registry.accounts.filter(a => a.retired).map(a => a.id))
      let known = pathAccounts.get(s.session_id)
      // A default-home attribution cached while the account was active is stale once it retires.
      if (known?.viaDefault && retiredIds.has(known.account)) { pathAccounts.delete(s.session_id); known = undefined }
      if (known && known.harness === s.harness) account = known.account
      else {
        const path = await liveTranscriptPath(s, registry.bindings).catch(() => null)
        const hit = path ? attributeAtPath(s.harness, path, registry.bindings, retiredIds) : undefined
        account = hit?.account
        if (hit) pathAccounts.set(s.session_id, { harness: s.harness, account: hit.account, viaDefault: hit.viaDefault })
      }
      const visible = registry.accounts.filter(a => a.harness === s.harness && a.available && !a.retired).map(a => a.id)
      const metered = Object.keys(burnByAccount).filter(k => k.startsWith(`${s.harness}:`)).map(k => k.slice(s.harness.length + 1))
        .filter(id => !registry.accounts.some(a => a.harness === s.harness && a.id === id && (!a.available || a.retired)))
      account ??= fallbackSessionAccount(s.harness, registry, [...new Set([...visible, ...metered])])
    }
    const tokens = (s.input_tokens ?? 0) + (s.output_tokens ?? 0) + (s.cache_read_input_tokens ?? 0) + (s.cache_creation_input_tokens ?? 0)
    const previous = liveUsage.get(s.session_id)
    const recent = previous && previous.harness === s.harness && (previous.account === account || previous.account === undefined) && nowMs >= previous.at && nowMs - previous.at <= 10 * 60_000
    const rate = recent ? Math.max(0, tokens - previous.tokens) : 0
    liveUsage.set(s.session_id, { tokens, at: nowMs, model: s.model ?? 'unknown', harness: s.harness, account })
    if (working?.has(s.session_id) || rate > 0) rates.set(s.session_id, { session: s, rate, harness: s.harness, account })
  }
  for (const key of new Set([...rates.values()].map(x => planAccountKey(x.harness, x.account)))) {
    const group = [...rates.entries()].filter(([, x]) => planAccountKey(x.harness, x.account) === key)
    const total = group.reduce((n, [, x]) => n + x.rate, 0)
    const burn = Math.max(0, burnByAccount[key] ?? 0)
    for (const [, x] of group) x.rate = total > 0 ? burn * x.rate / total : 0
  }
  return [...rates].map(([id, x]) => ({ id, model: x.session.model ?? 'unknown', burnPctPerHour: x.rate, harness: x.harness, ...(x.account ? { account: x.account } : {}) }))
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

/**
 * Keys re-keyed to another account (legacy `<harness>:default`, or an id the registry merged away):
 * old key -> survivor account id. The persist folds whatever the FILE still holds under an old key
 * into its survivor, newest reading winning — another process may have published a newer reading
 * under the old key after this one moved its own, and deleting it unread would lose that reading.
 */
const migratedAway = new Map<string, string>()

/**
 * Step 4 of C1: a meter recorded before accounts existed (`account: 'default'`) belongs to the
 * account the DEFAULT root is bound to — a binding exists only after a CONFIRMED probe, so nothing
 * is re-keyed on a guess. With no binding the record stays where it is. Notice state moves with it.
 */
async function migrateDefaultRecords(registry?: AccountsFile): Promise<boolean> {
  let file = registry
  if (!file) try { file = await readAccounts() } catch { return false }
  const { bindings } = file
  // Also a meter under an id the registry MERGED into another (one login stored twice): it belongs
  // to the survivor, where the newer of the two readings wins — never a second row for one plan.
  const legacy = Object.entries(state.limits).filter(([, l]) => l.account === 'default' || canonicalAccountId(file, l.account) !== l.account)
  if (!legacy.length) return false
  let moved = false
  for (const [oldKey, l] of legacy) {
    const id = l.account === 'default' ? bindings[`${l.harness}:`] : canonicalAccountId(file, l.account)
    if (!id) continue
    const next = { ...l, account: id }
    const newKey = keyOf(next)
    state.limits[newKey] = state.limits[newKey] ? newerLimits(state.limits[newKey], next) : next
    delete state.limits[oldKey]
    migratedAway.set(oldKey, id)
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

/**
 * Every record under a key that no longer names its account is folded into its FINAL survivor's
 * key: `moved` (this process's own migrations) and the registry's current aliases are followed
 * together until they settle, because a destination this process cached may itself have been folded
 * since (X→A cached, A→B now). Every record is then reduced into its final key from the ORIGINAL
 * snapshot, newest `updatedAt` winning — an intermediate key is never read back after it was written
 * to, so a stale snapshot of it can neither replace a newer reading nor be left behind.
 */
export function foldAliasedLimits(
  limits: Record<string, PlanLimits>,
  moved: ReadonlyMap<string, string>,
  registry: Pick<AccountsFile, 'aliases'> | null,
): void {
  const finalAccount = (l: PlanLimits): string => {
    let at = l.account
    const seen = new Set<string>()
    for (let i = 0; i < 16; i++) {
      const k = keyOf({ harness: l.harness, account: at })
      if (seen.has(k)) break
      seen.add(k)
      const next = moved.get(k) ?? (registry && at !== 'default' ? canonicalAccountId(registry, at) : at)
      if (next === at) break
      at = next
    }
    return at
  }
  const out: Record<string, PlanLimits> = {}
  for (const l of Object.values(limits)) {
    const to = finalAccount(l)
    const next = to === l.account ? l : { ...l, account: to }
    const nk = keyOf(next)
    out[nk] = newerLimits(out[nk], next)
  }
  for (const k of Object.keys(limits)) delete limits[k]
  Object.assign(limits, out)
}

let fileMtime = 0
let persistTimer: ReturnType<typeof setTimeout> | null = null
let persistOff = false
/** State not yet covered by a successful write: set on every change, cleared only by a write that covers it. */
let persistDirty = false
let persistFailures = 0
const PERSIST_BASE_MS = 500
const PERSIST_MAX_MS = 30_000
/** Test seams: the lock, the file operations and the base delay (production uses the real ones). */
const persistHooks = { lock: withFileLock, write: writeFile, rename, baseMs: PERSIST_BASE_MS }
export function __setPersistHooksForTest(h: Partial<typeof persistHooks> | null): void {
  Object.assign(persistHooks, { lock: withFileLock, write: writeFile, rename, baseMs: PERSIST_BASE_MS }, h ?? {})
}
function persistSoon(): void {
  persistDirty = true
  if (persistTimer || persistOff) return
  // Bounded exponential backoff after a failed attempt (error or contended lock).
  const delay = Math.min(persistHooks.baseMs * 2 ** persistFailures, Math.max(PERSIST_MAX_MS, persistHooks.baseMs))
  persistTimer = setTimeout(() => {
    persistTimer = null
    void (async () => {
      // Taken BEFORE the snapshot: a change arriving during the write sets it again and is retried.
      persistDirty = false
      let ok = false
      try {
        // The registry is read BEFORE the limits lock: never hold one file's lock while waiting on
        // another's. A registry a moment stale only folds less; the next persist folds the rest.
        const registry = await readAccounts().catch(() => null)
        // MERGE with what is on disk, under the lock every limits writer shares: a reading another
        // process publishes between our read and our rename would otherwise be overwritten.
        // Records: newer wins per account. Notices: only the owner's memory is authoritative.
        ok = await persistHooks.lock(FILE(), async ({ contended }) => {
          if (contended) return false
          const disk = await readFileState()
          const limits = { ...(disk?.limits ?? {}) }
          for (const [k, l] of Object.entries(state.limits)) limits[k] = newerLimits(limits[k], l)
          foldAliasedLimits(limits, migratedAway, registry)
          const out: Persisted = { limits, notices: sink ? state.notices : (disk?.notices ?? state.notices) }
          const tmp = `${FILE()}.${process.pid}.tmp`
          await mkdir(dirname(FILE()), { recursive: true })
          await persistHooks.write(tmp, JSON.stringify(out), { mode: 0o600 })
          await persistHooks.rename(tmp, FILE())
          try { fileMtime = (await stat(FILE())).mtimeMs } catch { /* raced */ }
          return true
        })
      } catch { /* a failed write is retried below, never abandoned */ }
      if (ok) { persistFailures = 0; return }
      // A contended lock never writes unlocked, and an I/O error keeps the reading pending: both retry.
      persistFailures++
      persistSoon()
    })()
  }, delay)
  persistTimer.unref?.()
}

/** Last `maybeMigrateDefault` run: the registry file is read at most this often per process. */
let lastMigrateCheck = 0

/**
 * A `'default'` binding can be CONFIRMED after boot (the first probe that names the login), which
 * leaves the legacy record beside the account's own. Re-run the load migration then — throttled,
 * and only while a legacy record exists, so a machine with no binding never pays for it.
 */
async function maybeMigrateDefault(registry?: AccountsFile): Promise<void> {
  if (registry) { if (await migrateDefaultRecords(registry)) persistSoon(); return }
  if (!Object.values(state.limits).some(l => l.account === 'default')) return
  const t = Date.now()
  if (t - lastMigrateCheck < 5_000) return
  lastMigrateCheck = t
  if (await migrateDefaultRecords()) persistSoon()
}

/** Store `l` when it is newer than what is held; notices and the SSE signal follow a real change. */
export async function ingestPlanLimits(reading: PlanLimits): Promise<boolean> {
  await load()
  let l = reading
  if (l.account !== 'default') {
    // A tap may still name an id the registry merged away (a managed session started before): the
    // reading is the survivor's.
    try { const at = canonicalAccountId(await readAccounts(), l.account); if (at !== l.account) l = { ...l, account: at } } catch { /* as named */ }
  }
  const key = keyOf(l)
  if (migratedAway.has(key)) {
    // The migration moved this key's record to the default root's account. Once that binding is
    // gone (the root was removed) the legacy reading has nowhere else to live: take it back.
    let bound = true
    try { bound = Boolean((await readAccounts()).bindings[`${l.harness}:`]) } catch { /* keep dropping */ }
    if (bound) return false
    migratedAway.delete(key)
  }
  if (l.account !== 'default') await maybeMigrateDefault()
  const held = state.limits[key]
  if (held && newerLimits(held, l) === held) {
    // An identical repeat of a reading that has not reached disk yet must not lose its persist.
    if (persistDirty) persistSoon()
    return false
  }
  let newSegment = false
  if (held && l.account !== 'default' && meterDiscontinuity(held, l)) {
    const switched = await accountSwitch(l)
    // Signal 1: the root now holds ANOTHER login — the reading is that account's; the held one
    // (and its hold) is left exactly as it was.
    if (switched) return ingestPlanLimits({ ...l, account: switched })
    // The awaits above let another reading land: judge against what is held NOW, so an older
    // reading never overwrites a newer one and one discontinuity opens one segment.
    const fresh = state.limits[key]
    if (fresh && newerLimits(fresh, l) === fresh) return false
    // Same login, or a harness that cannot say: a new segment for this account (spec §5).
    if (fresh && meterDiscontinuity(fresh, l)) {
      await startSegment(l.account, l.updatedAt).catch(() => {})
      const again = state.limits[key]
      if (again && newerLimits(again, l) === again) return false
      newSegment = true
      segmentStarts.set(l.account, l.updatedAt)
      history.delete(key)
      state.notices = resetNoticesFor(state.notices, l.harness, l.account)
    }
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

/**
 * The account of one managed session, looked up lazily and remembered ONLY once it is known: an
 * `undefined` (registry unreadable, row not written yet) is retried on the next line instead of
 * pinning the session to the default root for its whole life.
 */
export function sessionAccountOf(id: string): () => Promise<string | undefined> {
  let known: string | undefined
  return async () => (known ??= await managedAccountOf({ id, conversationId: id }))
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

export type AccountBudgetRow = ReturnType<typeof planBudget> & ReturnType<typeof planPace> & HarnessSpawnability & { account: string; accountLabel: string; yieldsTo?: string }

export interface PlanLimitsPayload {
  /** Which harnesses can be spawned here; a harness hidden from agents is absent. */
  harnesses: Partial<Record<HarnessId, HarnessSpawnability>>
  /** Owner surfaces: every account observed, with the owner-only login `label`. */
  limits: PlanLimits[]
  /** Plans registered in Billing for an account that has reported no window yet. */
  registered: { harness: HarnessId; account: string; plan: string }[]
  budgets: AccountBudgetRow[]
  hiddenFromAgents: AccountBudgetRow[]
  freeSlots: number
  freeSlotsByHarness: Partial<Record<HarnessId, number>>
  freeSlotsByAccount: Record<string, number>
  liveSessions: Omit<LivePlanSession, 'harness' | 'account'>[]
  pauseUntil?: number
  now: number
}

/** What `GET /api/plan-limits` answers: one row per account observed, agent-visible ones in `budgets`. */
export async function planLimitsPayload(
  billingIn: Parameters<typeof withPlanLabel>[1],
  nowMs = Date.now(),
  liveSessions: readonly LivePlanSession[] = [],
): Promise<PlanLimitsPayload> {
  await syncPlanLimitsFromFile()
  const registry = await readAccounts().catch((): AccountsFile => ({ version: 2, accounts: [], bindings: {}, segments: {} }))
  await maybeMigrateDefault(registry)
  // A plan registered under an id the registry merged away is the survivor's (unless it has its own).
  let billing = billingIn
  const aliasedProfiles = Object.entries(registry.aliases ?? {})
    .flatMap(([from]) => { const to = canonicalAccountId(registry, from), p = billingIn?.accountProfiles?.[from]
      return p && !billingIn?.accountProfiles?.[to] ? [[to, p] as const] : [] })
  if (billingIn && aliasedProfiles.length) billing = { ...billingIn, accountProfiles: { ...billingIn.accountProfiles, ...Object.fromEntries(aliasedProfiles) } }
  const registrySegments = registry.segments
  const segmentOf = (account: string): number | undefined => {
    const starts = [segmentStarts.get(account), registrySegments[account]].filter((v): v is number => v !== undefined)
    return starts.length ? Math.max(...starts) : undefined
  }
  const profileHarnesses = [...new Set([
    ...Object.keys(billing?.profiles ?? {}).filter(isHarnessId),
    ...Object.keys(billing?.accountProfiles ?? {}).flatMap(id => registry.accounts.filter(a => a.id === id).map(a => a.harness)),
  ])]
  // The stored meters are read BEFORE the registry await: an answer never mixes a meter stored
  // while the accounts were being resolved with accounts resolved before it existed.
  const stored = Object.values(state.limits)
  const harnesses = [...new Set<HarnessId>([
    ...stored.map(l => l.harness),
    ...liveSessions.flatMap(s => s.harness ? [s.harness] : []),
    ...profileHarnesses,
  ])]
  const accounts = harnesses.length ? await listHarnessAccounts(harnesses) : []
  const accountId = (a: { id: string; harness: HarnessId }) => a.id || `${a.harness}:current`
  const byAccount = new Map(accounts.map(a => [accountId(a), a]))
  const visibility = accounts.map(a => ({ id: accountId(a), harness: a.harness, available: a.available, ...(a.retired ? { retired: true } : {}) }))
  // "<Harness> #n" by firstSeen order within the harness; a nickname stands in unless it looks like an email.
  const labelOf = (harness: HarnessId, account: string): string => {
    const known = byAccount.get(account)
    if (known?.nickname && !known.nickname.includes('@')) return known.nickname
    const ofHarness = accounts.filter(a => a.harness === harness && a.available && !a.retired).sort((x, y) => x.firstSeen - y.firstSeen)
    const n = ofHarness.findIndex(a => accountId(a) === account) + 1
    return n > 0 ? `${HARNESS_LABELS[harness]} #${n}` : HARNESS_LABELS[harness]
  }
  const limits = stored
    .map(l => withPlanLabel(l, billing, nowMs))
    .map(l => { const label = byAccount.get(l.account)?.label; return label ? { ...l, label } : l })
    .sort((a, b) => a.harness.localeCompare(b.harness) || a.account.localeCompare(b.account))
  const spawnability = harnessSpawnabilities(nowMs)
  const resolvedSessions = liveSessions.map(s => {
    if (s.account || !s.harness) return s
    const visible = [...new Set([
      ...accounts.filter(a => a.id && a.harness === s.harness && a.available && !a.retired).map(accountId),
      ...limits.filter(l => l.harness === s.harness && !byAccount.has(l.account)).map(l => l.account),
    ])]
    const account = fallbackSessionAccount(s.harness, registry, visible)
    return account ? { ...s, account } : s
  })
  const sessionVisible = (s: LivePlanSession) => {
    const known = s.account ? byAccount.get(s.account) : undefined
    return !known || (known.available && !known.retired && (!s.harness || known.harness === s.harness))
  }
  const belongsTo = (s: LivePlanSession, l: PlanLimits) =>
    (!s.harness || s.harness === l.harness) && s.account === l.account
  const allBudgets: AccountBudgetRow[] = limits.map(l => {
    const budget = planBudget(l, nowMs)
    // Only measured sessions enter planSlots' per-session average. Working sessions with no
    // billed tokens remain in the public live summary, without diluting the measured burn.
    const planSessions = resolvedSessions.filter(s => s.burnPctPerHour > 0 && belongsTo(s, l))
    const availability = spawnability[l.harness]!
    return { ...budget, ...planPace(l, nowMs, history.get(keyOf(l)) ?? [], planSessions, segmentOf(l.account)), ...availability,
      ...(!availability.spawnable ? { freeSlots: 0, suggestedParallel: 0 } : {}),
      account: l.account, accountLabel: labelOf(l.harness, l.account),
    }
  })
  const visibleBudgets = agentVisible(allBudgets, visibility)
  const shown = new Set(visibleBudgets)
  const hiddenFromAgents = allBudgets.filter(b => !shown.has(b))
  // Only rows agents may see compete, and only an account the registry says is the same login.
  const recordOf = (id: string) => registry.accounts.find(a => a.id === id)
  const sameAccount = (x: string, y: string) => {
    const cx = canonicalAccountId(registry, x), cy = canonicalAccountId(registry, y)
    if (cx === cy) return true
    const rx = recordOf(cx), ry = recordOf(cy)
    return !!rx && !!ry && sameLogin(rx, ry)
  }
  const budgets = yieldStaleRows(visibleBudgets, sameAccount)
  // Plans registered in Settings → Billing whose account has reported no window yet: listed by
  // name with NO meters (nothing observed is not nothing used). Hidden accounts are absent.
  const registered: PlanLimitsPayload['registered'] = []
  for (const h of profileHarnesses) {
    const mine = accounts.filter(a => a.harness === h && !a.retired)
    const targets = mine.length ? mine : [{ id: '', harness: h, available: true } as const]
    for (const a of targets) {
      const plan = registeredPlanLabel(billing, h, nowMs, a.id || undefined)
      if (!plan) continue
      const account = a.id || 'default'
      if (!a.available || limits.some(l => l.harness === h && (l.account === account || (!a.id && !byAccount.has(l.account))))) continue
      registered.push({ harness: h, account, plan })
    }
  }
  const aggregates = harnessAggregate(budgets)
  const freeSlotsByHarness = Object.fromEntries(aggregates.map(a => [a.harness, a.freeSlots])) as Partial<Record<HarnessId, number>>
  const freeSlotsByAccount = Object.fromEntries(budgets.map(b => [b.account, b.freeSlots ?? 0]))
  // A caller choosing a harness must not be blocked by another harness's exhausted plan.
  const open = aggregates.filter(a => spawnability[a.harness]?.spawnable !== false && a.status !== 'hold')
  const freeSlots = open.length ? Math.max(...open.map(a => a.freeSlots)) : 0
  const pauseUntil = budgets.map(b => b.pauseUntil).filter((v): v is number => v !== undefined).sort((a, b) => a - b)[0]
  const publicLiveSessions = resolvedSessions
    .filter(sessionVisible)
    .map(({ harness: _harness, account: _account, ...s }) => s)
  // Hidden-from-agents wins over spawnability: a harness whose every account is off is not named.
  // Read from the REGISTRY as well as the observed rows: a harness with no meter, no live session and
  // no Billing profile reads no accounts above, and an all-OFF harness must still not be named.
  const hiddenOutright = (h: HarnessId) => {
    const ids = new Set(visibility.map(a => a.id))
    const live = [...visibility, ...registry.accounts.filter(a => !ids.has(a.id))]
      .filter(a => a.harness === h && !a.retired)
    return live.length > 0 && live.every(a => !a.available)
  }
  const publicHarnesses = Object.fromEntries(Object.entries(spawnability).filter(([h]) => !hiddenOutright(h as HarnessId))) as Partial<Record<HarnessId, HarnessSpawnability>>
  return { harnesses: publicHarnesses, limits, registered, budgets, hiddenFromAgents, freeSlots, freeSlotsByHarness, freeSlotsByAccount, liveSessions: publicLiveSessions, ...(pauseUntil !== undefined ? { pauseUntil } : {}), now: nowMs }
}

/** Tests only. */
export function __resetPlanLimitsForTest(file: string | null = null): void {
  for (const t of codexPending.values()) clearTimeout(t)
  codexPending.clear()
  state = { limits: {}, notices: {} }
  history.clear()
  segmentStarts.clear()
  migratedAway.clear()
  lastMigrateCheck = 0
  // Without a file of its own, a test must never sync the REAL data dir's file (the hook runs with
  // the owner's HOME): a path that cannot exist keeps `syncPlanLimitsFromFile` empty.
  filePath = file ?? join(AGENTISTICS_DATA_DIR, `.plan-limits-test-none-${process.pid}`, 'plan-limits.json')
  liveUsage.clear()
  pathAccounts.clear()
  fileMtime = 0
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = null
  persistDirty = false
  persistFailures = 0
  __setPersistHooksForTest(null)
  loaded = file ? null : Promise.resolve()
  persistOff = file === null
}

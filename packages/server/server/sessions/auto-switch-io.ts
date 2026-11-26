/**
 * auto-switch-io.ts — CONTA.AUTO, the ACT. One tick: for every live managed session whose last turn stopped on a usage
 * limit, ask the pure policy (`auto-switch.ts`) and, when it says move, run the SAME switch every door runs
 * (`switchSessionAccountImpl`, through the host) with `resendPending`, then say so: a notification and a comment on the
 * session's task/subtask. The tick holds no state of its own: the per-conversation episode lives in `auto-switch.json`
 * (under the data dir, written under the file lock), so a restart neither forgets an episode nor repeats a move.
 *
 * Everything the tick reads or does is a dep, so the policy's integration test drives a fake limit-blocked row through the
 * real switch path with no disk, no process and no clock. Never throws: a row that fails is skipped and logged.
 */
import { readFile, mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { AccountBudget, HarnessId } from '@agentistics/core'
import { switchSupported, type SwitchOption } from './account-switch'
import { clock, decideAutoSwitch, autoSwitchWords, resumeDue, type AutoEpisode } from './auto-switch'
import type { ManagedSession } from './types'

export const AUTO_SWITCH_FILE = 'auto-switch.json'
/** A tick moves at most this many sessions: a fleet-wide limit is worked through, not stampeded. */
export const MAX_MOVES_PER_TICK = 3
/** A session that produced output this recently is working, not stuck: its transcript is not even opened (QA F7). */
export const IDLE_MIN_MS = 30_000

export interface EpisodeRead { episodes: Record<string, AutoEpisode>; /** The file existed and could not be read (it was moved aside). */ corrupt: boolean }
export interface EpisodeStore {
  read(): Promise<EpisodeRead>
  /** Read-modify-write, serialised. */
  update(fn: (doc: Record<string, AutoEpisode>) => void): Promise<void>
}

/** What the transcript says: still stopped at a limit (with what the refused turn was), positively not, or could not be read. */
export type LimitRead = { kind: 'limited'; resetsAt?: number; at?: number; pendingPrompt?: string } | { kind: 'clear' } | { kind: 'unread' }

export interface AutoSwitchDeps {
  lang: 'en' | 'pt'
  now: () => number
  timeZone?: string
  enabled: () => Promise<boolean>
  rows: () => Promise<readonly ManagedSession[]>
  /** Ids of the sessions whose process is alive. */
  alive: () => Promise<ReadonlySet<string>>
  /** Ms since the session last produced output; `undefined` = unknown (then it is looked at). */
  idleMs?: (row: ManagedSession) => Promise<number | undefined>
  /** The account the row runs on now (`resolveSessionAccount`). */
  currentAccount: (row: ManagedSession, rows: readonly ManagedSession[]) => Promise<string | undefined>
  limitOf: (row: ManagedSession) => Promise<LimitRead>
  budgets: () => Promise<readonly AccountBudget[]>
  /** The accounts the switch would accept for this row (agentic, signed in, same harness first). */
  options: (row: ManagedSession, accountId: string | undefined) => Promise<readonly SwitchOption[]>
  /** Accounts whose login the harness refused (registry `loginExpiredAt`): never a target. */
  expired?: () => Promise<ReadonlySet<string>>
  switchAccount: (req: { id: string; accountId: string; resendPending: true }) => Promise<{ ok: boolean; message?: string; id?: string }>
  /** Type a message into a live session (the single resume after a "nobody has room" stop). */
  sendPrompt?: (id: string, text: string) => Promise<boolean>
  label: (harness: HarnessId, accountId: string | undefined) => Promise<string | undefined>
  notify: (n: { type: 'info' | 'warning'; code: string; title: string; message: string; meta: Record<string, unknown> }) => void
  comment: (taskId: string, subtaskId: string | undefined, body: string) => Promise<void>
  store: EpisodeStore
}

export interface AutoSwitchResult { moved: Array<{ from: string; to: string; id?: string }>; none: string[]; failed: string[]; resumed: string[] }

const shortId = (row: ManagedSession) => row.label?.trim() || row.harnessName?.trim() || row.id

/** A session being moved right now (this process): a slow switch is never started twice by two ticks. */
const inFlight = new Set<string>()

/** The one message the resume sends when the refused turn is not known: a system line, never taken for the owner's. */
const resumeText = (lang: 'en' | 'pt') => lang === 'pt'
  ? '[from agentistics · conta] O limite da conta liberou. Pode continuar de onde parou.'
  : '[from agentistics · account] The account limit is over. You can carry on where you stopped.'

export async function runAutoSwitchTick(d: AutoSwitchDeps): Promise<AutoSwitchResult> {
  const out: AutoSwitchResult = { moved: [], none: [], failed: [], resumed: [] }
  if (!(await d.enabled().catch(() => false))) return out
  const rows = await d.rows().catch(() => [] as readonly ManagedSession[])
  const alive = await d.alive().catch(() => new Set<string>())
  const read = await d.store.read().catch((): EpisodeRead => ({ episodes: {}, corrupt: true }))
  const episodes = read.episodes
  // An unreadable store means the loop guard is unknown: this tick acts on NOTHING; every session found stopped now is
  // recorded as already handled (so a copy of an old limit is never taken for a new one) and decided afresh only by a NEWER limit.
  const conservative = read.corrupt
  let budgets: readonly AccountBudget[] | null = null
  let expired: ReadonlySet<string> | null = null
  const taken = new Set<string>()
  for (const row of rows) {
    if (!conservative && out.moved.length >= MAX_MOVES_PER_TICK) break
    const conv = row.conversationId
    const harness = row.harness as HarnessId
    if (row.endedAt || !alive.has(row.id) || !conv || !switchSupported(harness) || inFlight.has(row.id)) continue
    try {
      const idle = await d.idleMs?.(row).catch(() => undefined)
      if (idle !== undefined && idle < IDLE_MIN_MS) continue // working: not stuck, and its transcript is not opened
      const probe = await d.limitOf(row)
      if (probe.kind === 'unread') continue // could not read it: that proves nothing — the episode (the loop guard) stays
      const episode = episodes[conv]
      if (probe.kind === 'clear') {
        if (episode) await d.store.update(doc => { delete doc[conv] })
        continue
      }
      const current = (await d.currentAccount(row, rows)) ?? row.accountId
      if (conservative) {
        if (current) await d.store.update(doc => { doc[conv] = { account: current, tried: [current], handled: true, at: d.now(), seenAt: probe.at ?? d.now() } })
        continue
      }
      // The single resume of a "nobody has room" stop, once its window has opened.
      if (current && episode?.account === current && resumeDue(episode, d.now())) {
        const sent = d.sendPrompt ? await d.sendPrompt(row.id, probe.pendingPrompt ?? resumeText(d.lang)).catch(() => false) : false
        if (sent) {
          await d.store.update(doc => { const e = doc[conv]; if (e) e.resumedAt = d.now() })
          out.resumed.push(row.id)
        }
        continue
      }
      budgets ??= await d.budgets()
      expired ??= d.expired ? await d.expired().catch(() => new Set<string>()) : new Set<string>()
      const decision = decideAutoSwitch({
        enabled: true, now: d.now(), harness, supported: true, ...(current ? { currentAccount: current } : {}),
        limit: { ...(probe.resetsAt !== undefined ? { resetsAt: probe.resetsAt } : {}), ...(probe.at !== undefined ? { at: probe.at } : {}) },
        ...(row.model ? { model: row.model } : {}), takenThisTick: taken,
        options: await d.options(row, current), budgets, episode, expired,
      })
      if (decision.kind === 'skip' || decision.kind === 'clear') continue
      const from = (await d.label(harness, current)) ?? current ?? harness
      const tz = d.timeZone ? { tz: d.timeZone } : {}
      if (decision.kind === 'none') {
        await d.store.update(doc => { doc[conv] = decision.episode })
        const w = autoSwitchWords({ kind: 'none', lang: d.lang, session: shortId(row), from, ...(decision.resetsAt !== undefined ? { resetsAt: decision.resetsAt } : {}), ...tz })
        d.notify({ type: 'warning', code: decision.resetsAt !== undefined ? 'account.auto_none' : 'account.auto_none_manual', title: w.title, message: w.message, meta: { id: row.id, session: shortId(row), from, until: untilOf(decision.resetsAt, d.lang, d.timeZone) } })
        out.none.push(row.id)
        continue
      }
      inFlight.add(row.id)
      try {
        const r = await d.switchAccount({ id: row.id, accountId: decision.target.id, resendPending: true })
        if (!r.ok) {
          // The switch gave the session back on its own account (or refused): this target counts as tried, so the next tick picks another.
          await d.store.update(doc => { doc[conv] = { account: current ?? '', tried: [...new Set([...decision.episode.tried, decision.target.id])], handled: false, at: d.now() } })
          out.failed.push(row.id)
          continue
        }
        taken.add(decision.target.id) // the budgets were read once: no second session lands on this account this tick
        await d.store.update(doc => { doc[conv] = decision.episode })
        const to = decision.target.label || decision.target.id
        const w = autoSwitchWords({ kind: 'move', lang: d.lang, session: shortId(row), from, to, ...(decision.resetsAt !== undefined ? { resetsAt: decision.resetsAt } : {}), ...tz })
        d.notify({ type: 'info', code: 'account.auto_switched', title: w.title, message: w.message, meta: { id: r.id ?? row.id, session: shortId(row), from, to, until: untilOf(decision.resetsAt, d.lang, d.timeZone) } })
        if (row.taskId && w.comment) await d.comment(row.taskId, row.subtaskId, w.comment).catch(() => undefined)
        out.moved.push({ from, to, ...(r.id ? { id: r.id } : {}) })
      } finally { inFlight.delete(row.id) }
    } catch (e) {
      console.error(`[auto-switch] ${row.id}: ${e instanceof Error ? e.message : String(e)}`)
      out.failed.push(row.id)
    }
  }
  return out
}

const untilOf = (ms: number | undefined, lang: 'en' | 'pt', tz?: string): string => (ms === undefined ? '' : clock(ms, lang, tz))

// ── The episode store (a small JSON file, written under the file lock) ────────────────────────────────

export function fileEpisodeStore(dataDir: string): EpisodeStore {
  const file = join(dataDir, AUTO_SWITCH_FILE)
  /** Missing = empty and fine; present but unreadable/invalid = moved aside (never silently overwritten) and `corrupt`. */
  const read = async (): Promise<EpisodeRead> => {
    let raw: string
    try { raw = await readFile(file, 'utf8') } catch { return { episodes: {}, corrupt: false } }
    try {
      const doc = JSON.parse(raw) as { episodes?: unknown }
      if (doc && typeof doc === 'object' && doc.episodes && typeof doc.episodes === 'object' && !Array.isArray(doc.episodes)) return { episodes: doc.episodes as Record<string, AutoEpisode>, corrupt: false }
    } catch { /* fall through */ }
    await rename(file, `${file}.corrupt-${Date.now()}`).catch(() => undefined)
    console.error(`[auto-switch] ${AUTO_SWITCH_FILE} was unreadable: moved aside; this tick acts on nothing`)
    return { episodes: {}, corrupt: true }
  }
  return {
    read,
    async update(fn) {
      const { withFileLock } = await import('./file-lock')
      await mkdir(dirname(file), { recursive: true })
      await withFileLock(file, async () => {
        const doc = (await read()).episodes
        fn(doc)
        const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
        await writeFile(tmp, JSON.stringify({ v: 1, episodes: doc }, null, 2))
        await rename(tmp, file)
      })
    },
  }
}

// ── The real wiring ───────────────────────────────────────────────────────────────────────────────────

/** The tail reads of the 60 s tick, cached by mtime for the life of the process. */
let sharedProbeCache: import('./account-switch-io').LimitProbeCache | undefined

export async function defaultAutoSwitchDeps(lang: 'en' | 'pt'): Promise<AutoSwitchDeps> {
  const [{ featureOn }, { readPreferences }, { readRegistry }, { resolveBackend }, { AGENTISTICS_DATA_DIR }] = await Promise.all([
    import('@agentistics/core'), import('../preferences'), import('./registry'), import('./index'), import('../config'),
  ])
  const probeCache = (sharedProbeCache ??= (await import('./account-switch-io')).newLimitProbeCache())
  return {
    lang,
    now: () => Date.now(),
    // On by default while multiple accounts are on; the Settings switch (`autoSwitchAccounts: false`) turns it off.
    enabled: async () => featureOn('multi-account') && (await readPreferences()).autoSwitchAccounts !== false,
    rows: () => readRegistry(),
    alive: async () => new Set((await (await resolveBackend()).list()).filter(b => b.alive).map(b => b.id)),
    currentAccount: async (row, rows) => {
      const [{ resolveSessionAccount, registryOfSpawnRows }, { spawnAccountContext }] = await Promise.all([import('./session-account'), import('./spawn-account-io')])
      const ctx = await spawnAccountContext([row.harness as HarnessId])
      return resolveSessionAccount(rows, { id: row.id }, registryOfSpawnRows(ctx.accounts))
    },
    // The transcript path is remembered per conversation and its tail re-read only when the file's mtime changed (QA F7).
    limitOf: async row => {
      const { readTailProbe, syncLoginExpiry } = await import('./account-switch-io')
      const tail = await readTailProbe({ harness: row.harness as HarnessId, conversationId: row.conversationId!, cwd: row.cwd, ...(row.accountId ? { accountId: row.accountId } : {}) }, probeCache)
      // The same read keeps the registry's "login expired" mark in step, so Usage → Accounts shows it
      // without anybody opening the session.
      await syncLoginExpiry(row.accountId, tail)
      const r = tail.limit
      return r.kind === 'limited'
        ? { kind: 'limited', ...(r.state.resetsAt !== undefined ? { resetsAt: r.state.resetsAt } : {}), ...(r.state.at !== undefined ? { at: r.state.at } : {}), ...(r.state.pendingPrompt ? { pendingPrompt: r.state.pendingPrompt } : {}) }
        : r
    },
    idleMs: async row => {
      const l = (await (await resolveBackend()).list().catch(() => [])).find(b => b.id === row.id)
      return l && typeof l.lastActivityMs === 'number' ? Date.now() - l.lastActivityMs : undefined
    },
    sendPrompt: async (id, text) => {
      const { runFleetAction } = await import('./fleet-web')
      return (await runFleetAction(lang, { action: 'prompt', id, text })).ok
    },
    budgets: async () => {
      const [{ planLimitsPayload }, { readPreferences: prefs }] = await Promise.all([import('../plan-limits'), import('../preferences')])
      return (await planLimitsPayload((await prefs()).billing, Date.now())).budgets
    },
    options: async (row, accountId) => {
      const { listSwitchTargets } = await import('./account-switch-io')
      return (await listSwitchTargets({ harness: row.harness as HarnessId, ...(accountId ? { accountId } : {}), agentCaller: true })).options
    },
    expired: async () => {
      const { spawnAccountRows } = await import('./spawn-account-io')
      return new Set((await spawnAccountRows()).filter(a => a.expired).map(a => a.id))
    },
    switchAccount: async req => {
      const { hostForFleet } = await import('./fleet-web')
      const host = await hostForFleet(lang)
      if (!host.switchSessionAccount) return { ok: false, message: 'unavailable' }
      const r = await host.switchSessionAccount(req)
      return { ok: r.ok, ...(r.message ? { message: r.message } : {}), ...(r.id ? { id: r.id } : {}) }
    },
    label: async (harness, id) => (await import('./account-switch-io')).accountLabel(harness, id),
    notify: n => { void import('../sse').then(m => m.broadcastNotification({ type: n.type, code: n.code, title: n.title, message: n.message, meta: n.meta })).catch(() => undefined) },
    comment: async (taskId, subtaskId, body) => {
      const { addComment } = await import('./task-web')
      await addComment(taskId, { author: 'agentistics', body, ...(subtaskId ? { subtaskId } : {}), kind: undefined })
    },
    store: fileEpisodeStore(AGENTISTICS_DATA_DIR),
  }
}

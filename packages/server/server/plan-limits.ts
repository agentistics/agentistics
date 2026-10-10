/**
 * PLAN LIMITS — the host half. Keeps the LAST record per harness account (core `planLimits.ts`
 * parses and decides everything), persists it beside the notifier's memory, raises the threshold
 * notices once per threshold per window period, and tells the browser over the existing SSE stream
 * (`event: plan-limits`, an empty refresh signal — the stream is shared, the data is a scoped GET).
 *
 * Two taps, both reading what the harness already wrote (no request that would spend quota):
 * - claude: every stdout line a STRUCTURED (web-born) session's relay delivers
 *   (`structured-durable.ts`), cheap-filtered on the literal `rate_limit_event` before parsing;
 * - codex: the tail of a rollout file the session-directory watcher saw change (`sse.ts`).
 * At boot the newest few of each are read once, so a restart does not forget the last value.
 */
import { readFile, readdir, stat, writeFile, rename, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  alternativeWithRoom, newerLimits, parseClaudeRateLimitEvent, parseCodexRateLimits,
  planThresholdNotices, withPlanLabel,
  type PlanLimits, type PlanNoticeState, type PlanThresholdNotice,
} from '@agentistics/core'
import { AGENTISTICS_DATA_DIR, CODEX_SESSIONS_DIR } from './config'
import { readTailBytes, windowLines } from './sessions/transcript-window'

const FILE = (): string => join(AGENTISTICS_DATA_DIR, 'plan-limits.json')

interface Persisted { limits: Record<string, PlanLimits>; notices: PlanNoticeState }

let state: Persisted = { limits: {}, notices: {} }
let loaded: Promise<void> | null = null

const keyOf = (l: Pick<PlanLimits, 'harness' | 'account'>): string => `${l.harness}:${l.account}`

type Sink = {
  notify: (n: PlanThresholdNotice, alt: string | null) => void
  changed: () => void
}
let sink: Sink | null = null

/** Wired once by the server (sse.ts owns the stream and the notification path). */
export function setPlanLimitsSink(s: Sink | null): void { sink = s }

function load(): Promise<void> {
  loaded ??= (async () => {
    try {
      const raw = JSON.parse(await readFile(FILE(), 'utf8')) as Partial<Persisted>
      state = {
        limits: raw.limits && typeof raw.limits === 'object' ? raw.limits : {},
        notices: raw.notices && typeof raw.notices === 'object' ? raw.notices : {},
      }
    } catch { /* absent or unreadable: start empty — nothing observed */ }
  })()
  return loaded
}

let persistTimer: ReturnType<typeof setTimeout> | null = null
let persistOff = false
function persistSoon(): void {
  if (persistTimer || persistOff) return
  persistTimer = setTimeout(() => {
    persistTimer = null
    const tmp = `${FILE()}.tmp`
    void mkdir(AGENTISTICS_DATA_DIR, { recursive: true })
      .then(() => writeFile(tmp, JSON.stringify(state), { mode: 0o600 }))
      .then(() => rename(tmp, FILE()))
      .catch(() => { /* a lost write costs one record, re-read on the next turn */ })
  }, 500)
  persistTimer.unref?.()
}

/** Store `l` when it is newer than what is held; notices and the SSE signal follow a real change. */
export async function ingestPlanLimits(l: PlanLimits): Promise<boolean> {
  await load()
  const key = keyOf(l)
  const held = state.limits[key]
  if (held && newerLimits(held, l) === held) return false
  state.limits[key] = l
  const { notices, state: next } = planThresholdNotices(state.notices, l)
  state.notices = next
  persistSoon()
  const all = Object.values(state.limits)
  for (const n of notices) sink?.notify(n, n.threshold >= 100 ? alternativeWithRoom(all, n.harness, Date.now()) : null)
  sink?.changed()
  return true
}

/** The claude tap: one raw stream-json line as the relay delivered it. Never throws. */
export function noteStructuredLine(line: string, atMs: number): void {
  if (!line.includes('rate_limit_event')) return
  let parsed: unknown
  try { parsed = JSON.parse(line) } catch { return }
  const l = parseClaudeRateLimitEvent(parsed, atMs)
  if (l) void ingestPlanLimits(l)
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
/** The codex tap: a rollout the watcher saw change. Debounced per file (a turn writes many lines). */
export function noteCodexRollout(path: string): void {
  if (!/rollout-.*\.jsonl$/.test(path) || codexPending.has(path)) return
  const t = setTimeout(() => {
    codexPending.delete(path)
    void latestCodexLimits(path).then(l => { if (l) void ingestPlanLimits(l) }).catch(() => {})
  }, 1000)
  t.unref?.()
  codexPending.set(path, t)
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
    const tail = await readTailBytes(p, 256 * 1024)
    if (!tail) continue
    const lines = windowLines(tail)
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i]!.includes('rate_limit_event')) continue
      try {
        const rec = JSON.parse(lines[i]!) as { t?: unknown; l?: unknown }
        if (typeof rec.l !== 'string' || typeof rec.t !== 'number') continue
        const l = parseClaudeRateLimitEvent(JSON.parse(rec.l), rec.t)
        if (l) { await ingestPlanLimits(l); break }
      } catch { /* keep looking */ }
    }
  }
  for (const p of await newestFiles(CODEX_SESSIONS_DIR, n => /^rollout-.*\.jsonl$/.test(n), 3, 3)) {
    const l = await latestCodexLimits(p)
    if (l) await ingestPlanLimits(l)
  }
}

/** What `GET /api/plan-limits` answers: every account observed, with its registered plan name. */
export async function planLimitsPayload(
  billing: Parameters<typeof withPlanLabel>[1],
  nowMs = Date.now(),
): Promise<{ limits: PlanLimits[]; now: number }> {
  await load()
  const limits = Object.values(state.limits)
    .map(l => withPlanLabel(l, billing, nowMs))
    .sort((a, b) => a.harness.localeCompare(b.harness))
  return { limits, now: nowMs }
}

/** Tests only. */
export function __resetPlanLimitsForTest(): void {
  state = { limits: {}, notices: {} }
  loaded = Promise.resolve()
  persistOff = true
}

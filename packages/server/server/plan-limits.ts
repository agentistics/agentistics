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
import { basename, dirname, join } from 'node:path'
import { watch as fsWatch } from 'node:fs'
import {
  alternativeWithRoom, newerLimits, parseClaudeRateLimitEvent, parseCodexRateLimits,
  planThresholdNotices, registeredPlanLabel, withPlanLabel,
  type HarnessId,
  type PlanLimits, type PlanNoticeState, type PlanThresholdNotice,
} from '@agentistics/core'
import { AGENTISTICS_DATA_DIR, CODEX_SESSIONS_DIR } from './config'
import { readTailBytes, windowLines } from './sessions/transcript-window'

let filePath: string | null = null
const FILE = (): string => filePath ?? join(AGENTISTICS_DATA_DIR, 'plan-limits.json')

interface Persisted { limits: Record<string, PlanLimits>; notices: PlanNoticeState }

let state: Persisted = { limits: {}, notices: {} }
let loaded: Promise<void> | null = null

const keyOf = (l: Pick<PlanLimits, 'harness' | 'account'>): string => `${l.harness}:${l.account}`

type Sink = {
  notify: (n: PlanThresholdNotice, alt: string | null) => void
  changed: () => void
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
  })()
  return loaded
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
  const held = state.limits[key]
  if (held && newerLimits(held, l) === held) return false
  state.limits[key] = l
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
  for (const n of notices) sink?.notify(n, n.threshold >= 100 ? alternativeWithRoom(all, n.harness, Date.now()) : null)
  sink?.changed()
  return true
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
): Promise<{ limits: PlanLimits[]; registered: { harness: HarnessId; plan: string }[]; now: number }> {
  await syncPlanLimitsFromFile()
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
  return { limits, registered, now: nowMs }
}

/** Tests only. */
export function __resetPlanLimitsForTest(file: string | null = null): void {
  state = { limits: {}, notices: {} }
  filePath = file
  fileMtime = 0
  loaded = file ? null : Promise.resolve()
  persistOff = file === null
}

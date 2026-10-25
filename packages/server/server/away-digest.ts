/** Server-owned away-mode summary offers and the bounded digest sent to Nay. */
import {
  AWAY_OFF, DEFAULT_AWAY_DIGEST_SCHEDULE, awayActive, awayDigestDurationLabel, parseAwayDigestSchedule, parseAwayState, redactSecrets,
  type AwayDigestSchedule, type AwayState,
} from '@agentistics/core'
import type { PreferencesMutator } from './preferences'

/** The defaults (`DEFAULT_AWAY_DIGEST_SCHEDULE`) in milliseconds; the live values come from preferences. */
export const AWAY_DIGEST_AFTER = (DEFAULT_AWAY_DIGEST_SCHEDULE.firstAfterMin ?? 0) * 60 * 1000
export const AWAY_DIGEST_BUCKET = DEFAULT_AWAY_DIGEST_SCHEDULE.everyMin * 60 * 1000

export interface AwayDigestState {
  since: string
  lastBucket: number
  snoozedUntil?: number
  lastDeliveredAt?: number
  conversationId?: string
}

export function awayDigestWindow(away: AwayState, now: number, digest?: AwayDigestState): { since: number; until: number } | null {
  const since = Math.max(Date.parse(away.since), digest?.since === away.since && digest.lastDeliveredAt ? digest.lastDeliveredAt : -Infinity)
  if (!awayActive(away, now) || !Number.isFinite(since)) return null
  return { since, until: now }
}

export function awayDigestOfferDue(
  away: AwayState, state: AwayDigestState | undefined, now: number, schedule: AwayDigestSchedule = DEFAULT_AWAY_DIGEST_SCHEDULE,
): number | null {
  if (schedule.firstAfterMin === null) return null
  const window = awayDigestWindow(away, now, state)
  if (!window || now - window.since < schedule.firstAfterMin * 60 * 1000) return null
  if (state?.since !== away.since) state = undefined
  if (state?.snoozedUntil && now < state.snoozedUntil) return null
  const bucket = Math.floor((now - window.since) / (schedule.everyMin * 60 * 1000))
  return state?.lastBucket === bucket ? null : bucket
}

const safe = (value: unknown): unknown => {
  if (typeof value === 'string') return redactSecrets(value).replace(/\b(token|secret|password|authorization|cookie)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]').slice(0, 500)
  if (Array.isArray(value)) return value.slice(0, 30).map(safe)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      if (/token|secret|password|authorization|cookie|key/i.test(key)) continue
      out[key] = safe(item)
    }
    return out
  }
  return value
}

export interface AwayDigestSources {
  awayDigest?: AwayDigestState
  tasks?: readonly { id: string; title: string; status: string }[]
  events?: readonly { taskId: string; at: string; kind: string; detail?: string; from?: string; to?: string }[]
  sessions?: readonly { id: string; title?: string; harness?: string; task?: string; taskId?: string; createdAt: string; endedAt?: string }[]
  notices?: readonly { ts: number; meta?: Record<string, unknown> }[]
  version?: { current: string; latest: string; updateAvailable: boolean }
  releases?: readonly { tag: string; published_at: string }[]
}

/** Pure digest projection used by production and tests. Every source is bounded and windowed. */
export function buildAwayDigestFromSources(away: AwayState, now: number, sources: AwayDigestSources): Record<string, unknown> {
  const window = awayDigestWindow(away, now, sources.awayDigest)
  if (!window) return { window: 'unavailable' }
  const inWindow = (at: string | number) => { const ms = typeof at === 'number' ? at : Date.parse(at); return Number.isFinite(ms) && ms >= window.since && ms <= window.until }
  const events = (sources.events ?? []).filter(e => inWindow(e.at)).slice(0, 30)
  const tasks = sources.tasks ?? []
  const taskById = new Map(tasks.map(t => [t.id, t]))
  return {
    window: { since: new Date(window.since).toISOString(), until: new Date(window.until).toISOString() },
    tasks: [...new Set(events.map(e => e.taskId))].slice(0, 30).map(id => ({
      id, title: safe(taskById.get(id)?.title ?? 'unavailable'), status: taskById.get(id)?.status ?? 'unavailable',
      events: events.filter(e => e.taskId === id).map(e => safe(e)),
    })),
    checkIns: events.filter(e => e.kind === 'checkin').slice(0, 30).map(e => safe(e)),
    sessions: (sources.sessions ?? []).filter(s => inWindow(s.createdAt) || (s.endedAt ? inWindow(s.endedAt) : false)).slice(0, 30).map(s => safe(s)),
    awayNotices: (sources.notices ?? []).filter(n => inWindow(n.ts)).slice(0, 30).map(n => safe({ at: new Date(n.ts).toISOString(), ...(n.meta ?? {}) })),
    version: sources.version ?? 'unavailable',
    releases: sources.releases ? sources.releases.filter(r => inWindow(r.published_at)).slice(0, 30).map(r => safe(r)) : 'unavailable',
    pending: 'unavailable',
  }
}

export async function buildAwayDigest(away: AwayState, now: number): Promise<Record<string, unknown>> {
  const { readPreferences } = await import('./preferences')
  const prefs = await readPreferences()
  const window = awayDigestWindow(away, now, prefs.awayDigest)
  if (!window) return { window: 'unavailable' }
  const since = new Date(window.since).toISOString()
  const until = new Date(window.until).toISOString()
  const result: Record<string, unknown> = { window: { since, until } }

  try {
    const { loadTaskWorld } = await import('./sessions/task-source')
    const world = await loadTaskWorld()
    const taskById = new Map(world.book.tasks.map(t => [t.id, t]))
    const events = world.book.events.filter(e => {
      const at = Date.parse(e.at)
      return Number.isFinite(at) && at >= window.since && at <= window.until
    }).slice(-30)
    result.tasks = [...new Set(events.map(e => e.taskId))].slice(0, 30).map(id => {
      const task = taskById.get(id)
      return { id, title: safe(task?.title ?? 'unavailable'), status: task?.status ?? 'unavailable', events: events.filter(e => e.taskId === id).map(e => safe({ at: e.at, kind: e.kind, detail: e.detail, from: e.from, to: e.to })) }
    })
    result.checkIns = events.filter(e => e.kind === 'checkin').map(e => safe({ taskId: e.taskId, at: e.at, detail: e.detail })).slice(0, 30)
    result.pending = [
      ...world.book.subtasks.filter(s => s.status === 'in_review').map(s => ({ kind: 'subtask', id: s.id, status: s.status })),
      ...world.book.comments.filter(c => c.kind === 'block').map(c => ({ kind: 'block', taskId: c.taskId, at: c.createdAt })),
    ].slice(0, 30)
  } catch { result.tasks = 'unavailable'; result.checkIns = 'unavailable'; result.pending = 'unavailable' }

  // The current active total is the same one shown by the away dialog, independent of the
  // bounded list of sessions created/ended during the digest window below.
  try {
    const { defaultAwayDeps, readAwayView } = await import('./away')
    result.activeSessions = (await readAwayView(await defaultAwayDeps())).activeSessions
  } catch { result.activeSessions = 'unavailable' }

  try {
    const { readRegistry } = await import('./sessions/registry')
    const sessions = await readRegistry()
    result.sessions = sessions.filter(s => {
      const created = Date.parse(s.createdAt)
      const ended = s.endedAt ? Date.parse(s.endedAt) : NaN
      return (Number.isFinite(created) && created >= window.since && created <= window.until) || (Number.isFinite(ended) && ended >= window.since && ended <= window.until)
    }).slice(0, 30).map(s => safe({ id: s.id, title: s.label ?? s.harnessName ?? 'unavailable', harness: s.harness, task: s.task ?? s.taskId, createdAt: s.createdAt, endedAt: s.endedAt }))
  } catch { result.sessions = 'unavailable' }

  try {
    const { readNotificationsFrom, NOTIFICATIONS_FILE } = await import('./notifications-store')
    const notices = await readNotificationsFrom(NOTIFICATIONS_FILE)
    result.awayNotices = notices.filter(n => n.code === 'away.notice' && n.ts >= window.since && n.ts <= window.until).slice(0, 30).map(n => safe({ at: new Date(n.ts).toISOString(), ...(n.meta ?? {}) }))
  } catch { result.awayNotices = 'unavailable' }
  try {
    const { getVersionInfo } = await import('./version')
    const version = await getVersionInfo()
    result.version = { current: version.current, latest: version.latest, updateAvailable: version.hasUpdate }
    result.releases = version.releases
      ? version.releases.filter(r => Date.parse(r.published_at) >= window.since && Date.parse(r.published_at) <= window.until).slice(0, 30).map(r => safe(r))
      : 'unavailable'
  } catch { result.version = 'unavailable' }
  if (!('releases' in result)) result.releases = 'unavailable'
  return result
}

export type AwayDigestAnswer = { ok: true; conversationId: string; bucket: number } | { ok: false; error: 'stale' | 'bad_answer' | 'not_away' | 'failed' }

export interface AwayDigestAnswerDeps {
  read: () => Promise<{ away?: AwayState; awayDigest?: AwayDigestState; awayDigestSchedule?: unknown }>
  update: (mutate: PreferencesMutator) => Promise<unknown>
  build: (away: AwayState, now: number) => Promise<Record<string, unknown>>
  startNay: (lang: 'pt' | 'en') => Promise<{ ok: boolean; id?: string; launch?: { harness: string; model?: string; effort?: string } }>
  prompt: (lang: 'pt' | 'en', id: string, text: string) => Promise<{ ok: boolean }>
  /** Called as each real step STARTS — the web's step indicator draws exactly these. */
  onPhase?: (phase: AwayDigestPhase) => void
}

/** The steps a "yes" really goes through, in order. `writing` is the wait for Nay's first words. */
export type AwayDigestPhase = 'collect' | 'prepare' | 'send' | 'writing'

export function awayDigestPrompt(
  lang: 'pt' | 'en',
  away: AwayState,
  now: number,
  digest: Record<string, unknown>,
  lastDeliveredAt?: number,
): string {
  const windowStart = Math.max(Date.parse(away.since), lastDeliveredAt ?? -Infinity)
  const window = `${Number.isFinite(windowStart) ? new Date(windowStart).toISOString() : away.since} ${lang === 'pt' ? 'até' : 'to'} ${new Date(now).toISOString()}`
  return lang === 'pt'
    ? `Você recebeu o JSON abaixo. Produza um relatório visual em Markdown com as seções Resumo, Releases, Tarefas, Sessões, Check-ins, Avisos e Esperando por você. Use somente o JSON, não invente fatos; marque dados unavailable como indisponíveis. Janela: ${window}.\n\n${JSON.stringify(digest)}`
    : `You received the JSON below. Produce a visual Markdown status report with sections Summary, Releases, Tasks, Sessions, Check-ins, Notices, and Waiting for you. Use only the JSON; do not invent facts, and mark unavailable data as unavailable. Window: ${window}.\n\n${JSON.stringify(digest)}`
}

/** An offer resets its response state but keeps delivery history for this away window. */
export function awayDigestOfferState(since: string, bucket: number, state?: AwayDigestState): AwayDigestState {
  return { since, lastBucket: bucket, ...(state?.since === since && state.lastDeliveredAt !== undefined ? { lastDeliveredAt: state.lastDeliveredAt } : {}) }
}

const answerDepsLocks = new Map<string, { answer: 'yes' | 'no'; run: Promise<AwayDigestAnswer> }>()

async function answerAwayDigestWithDepsUnlocked(answer: unknown, bucket: unknown, lang: 'pt' | 'en', deps: AwayDigestAnswerDeps, now: number, since?: unknown): Promise<AwayDigestAnswer> {
  if (answer !== 'yes' && answer !== 'no') return { ok: false, error: 'bad_answer' }
  if (!Number.isInteger(bucket)) return { ok: false, error: 'stale' }
  const key = Number(bucket)
  const prefs = await deps.read()
  const away = parseAwayState(prefs.away ?? AWAY_OFF)
  if (since !== away.since) return { ok: false, error: 'stale' }
  if (!awayActive(away, now)) return { ok: false, error: 'not_away' }
  const due = awayDigestOfferDue(away, prefs.awayDigest, now, parseAwayDigestSchedule(prefs.awayDigestSchedule))
  if (prefs.awayDigest?.conversationId && prefs.awayDigest.lastBucket === key) return { ok: true, conversationId: prefs.awayDigest.conversationId, bucket: key }
  if (due !== key && prefs.awayDigest?.lastBucket !== key) return { ok: false, error: awayActive(away, now) ? 'stale' : 'not_away' }
  const persist = async (state: AwayDigestState): Promise<boolean> => {
    let saved = false
    await deps.update(cur => {
      const currentAway = parseAwayState(cur.away ?? AWAY_OFF)
      if (currentAway.since !== away.since || !awayActive(currentAway, now)) return undefined
      saved = true
      return { awayDigest: state }
    })
    return saved
  }
  if (answer === 'no') {
    if (!(await persist({ ...awayDigestOfferState(away.since, key, prefs.awayDigest), snoozedUntil: now + 60 * 60 * 1000 }))) return { ok: false, error: 'stale' }
    return { ok: true, conversationId: '', bucket: key }
  }
  deps.onPhase?.('collect')
  const digest = await deps.build(away, now)
  deps.onPhase?.('prepare')
  const out = await deps.startNay(lang)
  if (!out.ok || !out.id) return { ok: false, error: 'failed' }
  deps.onPhase?.('send')
  if (!(await deps.prompt(lang, out.id, awayDigestPrompt(lang, away, now, digest, prefs.awayDigest?.lastDeliveredAt))).ok) return { ok: false, error: 'failed' }
  if (!(await persist({ since: away.since, lastBucket: key, lastDeliveredAt: now, conversationId: out.id }))) return { ok: false, error: 'stale' }
  return { ok: true, conversationId: out.id, bucket: key }
}

export async function answerAwayDigestWithDeps(answer: unknown, bucket: unknown, lang: 'pt' | 'en', deps: AwayDigestAnswerDeps, now = Date.now(), since?: unknown): Promise<AwayDigestAnswer> {
  if (answer !== 'yes' && answer !== 'no') return { ok: false, error: 'bad_answer' }
  if (typeof bucket !== 'number' || !Number.isInteger(bucket)) return { ok: false, error: 'stale' }
  const prefs = await deps.read()
  const away = parseAwayState(prefs.away ?? AWAY_OFF)
  if (since !== away.since) return { ok: false, error: 'stale' }
  if (!awayActive(away, now)) return { ok: false, error: 'not_away' }
  const key = JSON.stringify([bucket, since])
  const prior = answerDepsLocks.get(key)
  if (prior) return prior.answer === answer ? prior.run : { ok: false, error: 'stale' }
  const run = answerAwayDigestWithDepsUnlocked(answer, bucket, lang, deps, now, since)
  answerDepsLocks.set(key, { answer, run })
  try { return await run } finally { answerDepsLocks.delete(key) }
}

export async function answerAwayDigest(
  answer: unknown, bucket: unknown, lang: 'pt' | 'en', now = Date.now(), since?: unknown, onPhase?: (phase: AwayDigestPhase) => void,
): Promise<AwayDigestAnswer> {
  const { readPreferences, updatePreferences } = await import('./preferences')
  const { startNaySession, defaultNayDeps } = await import('./sessions/nay-web')
  const { runFleetAction } = await import('./sessions/fleet-web')
  const { PORT } = await import('./config')
  return answerAwayDigestWithDeps(answer, bucket, lang, {
    read: async () => readPreferences(),
    update: updatePreferences,
    build: buildAwayDigest,
    startNay: async selectedLang => { const out = await startNaySession(selectedLang, defaultNayDeps(PORT)); return { ok: out.ok, id: out.id } },
    prompt: async (selectedLang, id, text) => ({ ok: (await runFleetAction(selectedLang, { action: 'prompt', id, text })).ok }),
    onPhase,
  }, now, since)
}

/** What one fleet row says about Nay's answer: `started`, still `waiting`, or `gone` (it ended first). */
/** The fields of a fleet row (`SessionView`) this reads. */
export interface NayAnswerRow { id: string; status: string; activity?: string; chatTurns?: readonly { role: string; text: string; pending?: boolean }[] }

export function nayAnswerProgress(row: Omit<NayAnswerRow, 'id'> | undefined): 'started' | 'waiting' | 'gone' {
  if (!row) return 'waiting'
  if (row.status === 'exited' || row.status === 'lost' || row.status === 'closed' || row.activity === 'exited') return 'gone'
  // A harness whose turns the poll can read: the answer has started when Nay has said something.
  if (row.chatTurns) return row.chatTurns.some(t => t.role === 'assistant' && !t.pending && t.text.trim() !== '') ? 'started' : 'waiting'
  // One it cannot read: the turn starting is the most that can be observed.
  return row.activity === 'working' ? 'started' : 'waiting'
}

export const NAY_ANSWER_WAIT_MS = 120_000

/** Polls the fleet until Nay's answer starts. `false` when it ended or the bound ran out — never a guess. */
export async function waitForNayAnswer(
  id: string,
  read: () => Promise<{ sessions: readonly NayAnswerRow[] }>,
  opts: { timeoutMs?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<boolean> {
  const timeout = opts.timeoutMs ?? NAY_ANSWER_WAIT_MS
  const interval = opts.intervalMs ?? 1500
  const sleep = opts.sleep ?? (ms => new Promise<void>(r => setTimeout(r, ms)))
  const now = opts.now ?? Date.now
  const deadline = now() + timeout
  for (;;) {
    let progress: 'started' | 'waiting' | 'gone' = 'waiting'
    try { progress = nayAnswerProgress((await read()).sessions.find(s => s.id === id)) } catch { /* a failed poll is not an answer */ }
    if (progress === 'started') return true
    if (progress === 'gone' || now() >= deadline) return false
    await sleep(interval)
  }
}

export type AwayDigestStreamLine = { phase: AwayDigestPhase } | { done: true; result: AwayDigestAnswer; answerStarted?: boolean }

/**
 * The answer as NDJSON lines: one `{phase}` as each real step starts, then `{done, result}`. A "yes"
 * that delivered also reports `writing` and waits for Nay's first words before `done`, so the web's
 * indicator ends when the answer starts, not on a timer.
 */
export function awayDigestAnswerStream(
  run: (onPhase: (phase: AwayDigestPhase) => void) => Promise<AwayDigestAnswer>,
  wait: (conversationId: string) => Promise<boolean>,
  answer: unknown,
): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream({
    async start(controller) {
      const send = (line: AwayDigestStreamLine) => { try { controller.enqueue(enc.encode(`${JSON.stringify(line)}\n`)) } catch { /* client left */ } }
      let result: AwayDigestAnswer
      try { result = await run(phase => send({ phase })) } catch { result = { ok: false, error: 'failed' } }
      if (answer === 'yes' && result.ok && result.conversationId) {
        send({ phase: 'writing' })
        // A blank line every few seconds keeps an idle-timeout proxy from closing a stream that is waiting.
        const keepAlive = setInterval(() => { try { controller.enqueue(enc.encode('\n')) } catch { /* client left */ } }, 10_000)
        let started = false
        try { started = await wait(result.conversationId) } catch { started = false } finally { clearInterval(keepAlive) }
        send({ done: true, result, answerStarted: started })
      } else send({ done: true, result })
      try { controller.close() } catch { /* already closed */ }
    },
  })
}

export async function offerAwayDigest(now = Date.now()): Promise<void> {
  if (offerRun) return offerRun
  offerRun = offerAwayDigestLocked(now)
  try { await offerRun } finally { offerRun = null }
}

async function offerAwayDigestLocked(now: number): Promise<void> {
  const { readPreferences, updatePreferences } = await import('./preferences')
  const prefs = await readPreferences()
  const away = parseAwayState(prefs.away ?? AWAY_OFF)
  const schedule = parseAwayDigestSchedule(prefs.awayDigestSchedule)
  const bucket = awayDigestOfferDue(away, prefs.awayDigest, now, schedule)
  if (bucket === null) return
  let claimed = false
  await updatePreferences(cur => {
    const currentAway = parseAwayState(cur.away ?? AWAY_OFF)
    if (currentAway.since !== away.since) return undefined
    if (awayDigestOfferDue(currentAway, cur.awayDigest, now, parseAwayDigestSchedule(cur.awayDigestSchedule)) !== bucket) return undefined
    claimed = true
    return { awayDigest: awayDigestOfferState(away.since, bucket, cur.awayDigest) }
  })
  if (!claimed) return
  const { broadcastNotification } = await import('./sse')
  const { sendMobileNotice, readMobileSubscriptions, webPushTransport } = await import('./events/mobile-push')
  const pt = prefs.lang === 'pt'
  const after = awayDigestDurationLabel(schedule.firstAfterMin ?? 0)
  broadcastNotification({ type: 'info', code: 'away.digest_offer', meta: { bucket, since: away.since, after, notificationKey: `away.digest:${away.since}:${bucket}` } })
  void sendMobileNotice(pt ? 'Agentistics · Resumo do modo ausente' : 'Agentistics · Away-mode summary', awayDigestOfferText(pt ? 'pt' : 'en', after), await readMobileSubscriptions(), webPushTransport).catch(() => {})
}

/** The offer's sentence. `after` is a duration label; the web carries the same sentence in `notifications.ts`. */
export function awayDigestOfferText(lang: 'pt' | 'en', after: string): string {
  return lang === 'pt'
    ? `Você está fora há mais de ${after}. Quer que a Nay prepare um resumo do que aconteceu?`
    : `You’ve been away for more than ${after}. Would you like Nay to prepare a summary of what happened?`
}

let timer: ReturnType<typeof setInterval> | null = null
let timerKick: ReturnType<typeof setTimeout> | null = null
let offerRun: Promise<void> | null = null
export function startAwayDigestTimer(intervalMs = 60_000): void {
  if (timer) return
  timer = setInterval(() => { void offerAwayDigest() }, intervalMs)
  if (typeof timer === 'object' && timer && 'unref' in timer) (timer as { unref: () => void }).unref()
  timerKick = setTimeout(() => { timerKick = null; if (timer) void offerAwayDigest() }, 0)
}

export function stopAwayDigestTimer(): void {
  if (timer) clearInterval(timer)
  if (timerKick) clearTimeout(timerKick)
  timerKick = null
  timer = null
}

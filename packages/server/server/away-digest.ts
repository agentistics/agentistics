/** Server-owned away-mode summary offers and the bounded digest sent to Nay. */
import { AWAY_OFF, awayActive, parseAwayState, redactSecrets, type AwayState } from '@agentistics/core'

export const AWAY_DIGEST_AFTER = 5 * 60 * 60 * 1000
export const AWAY_DIGEST_BUCKET = 15 * 60 * 1000

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

export function awayDigestOfferDue(away: AwayState, state: AwayDigestState | undefined, now: number): number | null {
  const window = awayDigestWindow(away, now, state)
  if (!window || now - window.since < AWAY_DIGEST_AFTER) return null
  if (state?.since !== away.since) state = undefined
  if (state?.snoozedUntil && now < state.snoozedUntil) return null
  const bucket = Math.floor((now - window.since) / AWAY_DIGEST_BUCKET)
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
      id, title: taskById.get(id)?.title ?? 'unavailable', status: taskById.get(id)?.status ?? 'unavailable',
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
      return { id, title: task?.title ?? 'unavailable', status: task?.status ?? 'unavailable', events: events.filter(e => e.taskId === id).map(e => safe({ at: e.at, kind: e.kind, detail: e.detail, from: e.from, to: e.to })) }
    })
    result.checkIns = events.filter(e => e.kind === 'checkin').map(e => safe({ taskId: e.taskId, at: e.at, detail: e.detail })).slice(0, 30)
    result.pending = [
      ...world.book.subtasks.filter(s => s.status === 'in_review').map(s => ({ kind: 'subtask', id: s.id, status: s.status })),
      ...world.book.comments.filter(c => c.kind === 'block').map(c => ({ kind: 'block', taskId: c.taskId, at: c.createdAt })),
    ].slice(0, 30)
  } catch { result.tasks = 'unavailable'; result.checkIns = 'unavailable'; result.pending = 'unavailable' }

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

const answerLocks = new Map<number, Promise<unknown>>()
export type AwayDigestAnswer = { ok: true; conversationId: string; bucket: number } | { ok: false; error: 'stale' | 'bad_answer' | 'not_away' | 'failed' }

export interface AwayDigestAnswerDeps {
  read: () => Promise<{ away?: AwayState; awayDigest?: AwayDigestState }>
  write: (state: AwayDigestState) => Promise<void>
  build: (away: AwayState, now: number) => Promise<Record<string, unknown>>
  startNay: (lang: 'pt' | 'en') => Promise<{ ok: boolean; id?: string; launch?: { harness: string; model?: string; effort?: string } }>
  prompt: (lang: 'pt' | 'en', id: string, text: string) => Promise<{ ok: boolean }>
}

export function awayDigestPrompt(lang: 'pt' | 'en', away: AwayState, now: number, digest: Record<string, unknown>): string {
  const window = `${away.since} ${lang === 'pt' ? 'até' : 'to'} ${new Date(now).toISOString()}`
  return lang === 'pt'
    ? `Você recebeu o JSON abaixo. Produza um relatório visual em Markdown com as seções Resumo, Releases, Tarefas, Sessões, Check-ins, Avisos e Esperando por você. Use somente o JSON, não invente fatos; marque dados unavailable como indisponíveis. Janela: ${window}.\n\n${JSON.stringify(digest)}`
    : `You received the JSON below. Produce a visual Markdown status report with sections Summary, Releases, Tasks, Sessions, Check-ins, Notices, and Waiting for you. Use only the JSON; do not invent facts, and mark unavailable data as unavailable. Window: ${window}.\n\n${JSON.stringify(digest)}`
}

export async function answerAwayDigestWithDeps(answer: unknown, bucket: unknown, lang: 'pt' | 'en', deps: AwayDigestAnswerDeps, now = Date.now(), since?: unknown): Promise<AwayDigestAnswer> {
  if (answer !== 'yes' && answer !== 'no') return { ok: false, error: 'bad_answer' }
  if (!Number.isInteger(bucket)) return { ok: false, error: 'stale' }
  const key = Number(bucket)
  const prefs = await deps.read()
  const away = parseAwayState(prefs.away ?? AWAY_OFF)
  if (since !== away.since) return { ok: false, error: 'stale' }
  const due = awayDigestOfferDue(away, prefs.awayDigest, now)
  if (prefs.awayDigest?.conversationId && prefs.awayDigest.lastBucket === key) return { ok: true, conversationId: prefs.awayDigest.conversationId, bucket: key }
  if (due !== key && prefs.awayDigest?.lastBucket !== key) return { ok: false, error: awayActive(away, now) ? 'stale' : 'not_away' }
  if (answer === 'no') {
    await deps.write({ since: away.since, lastBucket: key, snoozedUntil: now + 60 * 60 * 1000 })
    return { ok: true, conversationId: '', bucket: key }
  }
  const digest = await deps.build(away, now)
  const out = await deps.startNay(lang)
  if (!out.ok || !out.id) return { ok: false, error: 'failed' }
  if (!(await deps.prompt(lang, out.id, awayDigestPrompt(lang, away, now, digest))).ok) return { ok: false, error: 'failed' }
  await deps.write({ since: away.since, lastBucket: key, lastDeliveredAt: now, conversationId: out.id })
  return { ok: true, conversationId: out.id, bucket: key }
}

export async function answerAwayDigest(answer: unknown, bucket: unknown, lang: 'pt' | 'en', now = Date.now(), since?: unknown): Promise<AwayDigestAnswer> {
  if (answer !== 'yes' && answer !== 'no') return { ok: false, error: 'bad_answer' }
  if (!Number.isInteger(bucket)) return { ok: false, error: 'stale' }
  const key = Number(bucket)
  const prior = answerLocks.get(key)
  if (prior) return prior as Promise<AwayDigestAnswer>
  const run = (async (): Promise<AwayDigestAnswer> => {
    const { readPreferences, updatePreferences } = await import('./preferences')
    const { startNaySession, defaultNayDeps } = await import('./sessions/nay-web')
    const { runFleetAction } = await import('./sessions/fleet-web')
    const { PORT } = await import('./config')
    return answerAwayDigestWithDeps(answer, bucket, lang, {
      read: async () => readPreferences(),
      write: async state => { await updatePreferences(() => ({ awayDigest: state })) },
      build: buildAwayDigest,
      startNay: async selectedLang => { const out = await startNaySession(selectedLang, defaultNayDeps(PORT)); return { ok: out.ok, id: out.id } },
      prompt: async (selectedLang, id, text) => ({ ok: (await runFleetAction(selectedLang, { action: 'prompt', id, text })).ok }),
    }, now, since)
  })()
  answerLocks.set(key, run)
  try { return await run } finally { answerLocks.delete(key) }
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
  const bucket = awayDigestOfferDue(away, prefs.awayDigest, now)
  if (bucket === null) return
  let claimed = false
  await updatePreferences(cur => {
    const currentAway = parseAwayState(cur.away ?? AWAY_OFF)
    if (currentAway.since !== away.since) return undefined
    if (awayDigestOfferDue(currentAway, cur.awayDigest, now) !== bucket) return undefined
    claimed = true
    return { awayDigest: { since: away.since, lastBucket: bucket } }
  })
  if (!claimed) return
  const { broadcastNotification } = await import('./sse')
  const { sendMobileNotice, readMobileSubscriptions, webPushTransport } = await import('./events/mobile-push')
  const pt = prefs.lang === 'pt'
  broadcastNotification({ type: 'info', code: 'away.digest_offer', meta: { bucket, since: away.since, notificationKey: `away.digest:${away.since}:${bucket}` } })
  void sendMobileNotice(pt ? 'Agentistics · Resumo do modo ausente' : 'Agentistics · Away-mode summary', pt ? 'Fiquei fora há mais de 5 horas. Quer que a Nay prepare um resumo do que aconteceu?' : 'I’ve been away for more than 5 hours. Would you like Nay to prepare a summary of what happened?', await readMobileSubscriptions(), webPushTransport).catch(() => {})
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

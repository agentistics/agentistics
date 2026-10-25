import { describe, expect, test } from 'bun:test'
import { answerAwayDigestWithDeps, awayDigestAnswerStream, awayDigestPrompt, nayAnswerProgress, waitForNayAnswer, type AwayDigestAnswerDeps, type AwayDigestState } from './away-digest'

const start = Date.parse('2026-01-01T00:00:00.000Z')
const away = { on: true as const, since: new Date(start).toISOString(), until: null, authorised: [], note: '', maxWorkers: 6, topCaps: {} }
const bucket = 20

function fixture(overrides: Partial<{ state: AwayDigestState; start: AwayDigestAnswerDeps['startNay']; prompt: AwayDigestAnswerDeps['prompt'] }> = {}) {
  let state: AwayDigestState = overrides.state ?? { since: away.since, lastBucket: bucket }
  let starts = 0
  let prompts = 0
  const deps: AwayDigestAnswerDeps = {
    read: async () => ({ away, awayDigest: state }),
    update: async mutate => { const patch = mutate({ away, awayDigest: state }); if (patch?.awayDigest) state = patch.awayDigest },
    build: async () => ({ window: { since: away.since }, releases: 'unavailable' }),
    startNay: async lang => { starts++; return overrides.start?.(lang) ?? { ok: true, id: 'nay-1', launch: { harness: 'codex', model: 'o3', effort: 'high' } } },
    prompt: async (lang, id, text) => { prompts++; return overrides.prompt?.(lang, id, text) ?? { ok: true } },
  }
  return { deps, get state() { return state }, counts: () => ({ starts, prompts }) }
}

describe('away digest answers', () => {
  test('Yes spawns once, prompts with both language-specific report sections, and is idempotent', async () => {
    const f = fixture()
    const first = await answerAwayDigestWithDeps('yes', bucket, 'en', f.deps, start + 5 * 60 * 60 * 1000, away.since)
    const second = await answerAwayDigestWithDeps('yes', bucket, 'en', f.deps, start + 5 * 60 * 60 * 1000, away.since)
    expect(first).toEqual({ ok: true, conversationId: 'nay-1', bucket })
    expect(second).toEqual(first)
    expect(f.counts()).toEqual({ starts: 1, prompts: 1 })
  })

  test('No snoozes for one hour and never spawns', async () => {
    const f = fixture()
    const out = await answerAwayDigestWithDeps('no', bucket, 'pt', f.deps, start + 5 * 60 * 60 * 1000, away.since)
    expect(out).toEqual({ ok: true, conversationId: '', bucket })
    expect(f.state.snoozedUntil).toBe(start + 6 * 60 * 60 * 1000)
    expect(f.counts()).toEqual({ starts: 0, prompts: 0 })
  })

  test('No preserves the last delivery timestamp while snoozing', async () => {
    const delivered = start + 5 * 60 * 60 * 1000
    const f = fixture({ state: { since: away.since, lastBucket: bucket, lastDeliveredAt: delivered } })
    expect((await answerAwayDigestWithDeps('no', bucket, 'en', f.deps, delivered + 5 * 60 * 60 * 1000, away.since)).ok).toBe(true)
    expect(f.state.lastDeliveredAt).toBe(delivered)
    expect(f.state.snoozedUntil).toBe(delivered + 6 * 60 * 60 * 1000)
  })

  test('expired and disabled away windows reject persisted offers without writes or launches', async () => {
    const now = start + 5 * 60 * 60 * 1000
    for (const inactive of [{ ...away, until: new Date(now).toISOString() }, { ...away, on: false }]) {
      for (const answer of ['yes', 'no']) {
        const f = fixture()
        const deps = { ...f.deps, read: async () => ({ away: inactive, awayDigest: f.state }) }
        expect(await answerAwayDigestWithDeps(answer, bucket, 'en', deps, now, away.since)).toEqual({ ok: false, error: 'not_away' })
        expect(f.state).toEqual({ since: away.since, lastBucket: bucket })
        expect(f.counts()).toEqual({ starts: 0, prompts: 0 })
      }
    }
  })

  test('in-flight answers validate since, isolate windows, and reject conflicting Yes/No', async () => {
    const now = start + 5 * 60 * 60 * 1000
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { entered = resolve })
    const f = fixture({ start: async () => { entered(); await gate; return { ok: true, id: 'nay-first' } } })
    const first = answerAwayDigestWithDeps('yes', bucket, 'en', f.deps, now, away.since)
    await started
    try {
      expect(await answerAwayDigestWithDeps('yes', bucket, 'en', f.deps, now, 'old-window')).toEqual({ ok: false, error: 'stale' })
      expect(await answerAwayDigestWithDeps('no', bucket, 'en', f.deps, now, away.since)).toEqual({ ok: false, error: 'stale' })
      expect(await answerAwayDigestWithDeps('invalid', bucket, 'en', f.deps, now, away.since)).toEqual({ ok: false, error: 'bad_answer' })
      const next = fixture()
      const nextAway = { ...away, since: new Date(start + 1000).toISOString() }
      const nextDeps = {
        ...next.deps,
        read: async () => ({ away: nextAway, awayDigest: { since: nextAway.since, lastBucket: bucket } }),
        update: async (mutate: Parameters<AwayDigestAnswerDeps["update"]>[0]) => { mutate({ away: nextAway, awayDigest: next.state }) },
      }
      expect(await answerAwayDigestWithDeps('yes', bucket, 'en', nextDeps, now, away.since)).toEqual({ ok: false, error: 'stale' })
      expect(await answerAwayDigestWithDeps('yes', bucket, 'en', nextDeps, now, nextAway.since)).toEqual({ ok: true, conversationId: 'nay-1', bucket })
      const expiredDeps = { ...f.deps, read: async () => ({ away: { ...away, until: new Date(now).toISOString() }, awayDigest: f.state }) }
      expect(await answerAwayDigestWithDeps('yes', bucket, 'en', expiredDeps, now, away.since)).toEqual({ ok: false, error: 'not_away' })
    } finally { release(); await first }
    expect(f.counts()).toEqual({ starts: 1, prompts: 1 })
  })

  test('a stalled answer from an obsolete window cannot overwrite a newer delivery', async () => {
    const now = start + 5 * 60 * 60 * 1000
    let currentAway = away
    let state: AwayDigestState = { since: away.since, lastBucket: bucket }
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { entered = resolve })
    let launches = 0
    const deps: AwayDigestAnswerDeps = {
      read: async () => ({ away: currentAway, awayDigest: state }),
      update: async mutate => {
        const patch = mutate({ away: currentAway, awayDigest: state })
        if (patch?.awayDigest) state = patch.awayDigest
      },
      build: async () => ({}),
      startNay: async () => {
        if (++launches === 1) { entered(); await gate; return { ok: true, id: 'nay-A' } }
        return { ok: true, id: 'nay-B' }
      },
      prompt: async () => ({ ok: true }),
    }
    const first = answerAwayDigestWithDeps('yes', bucket, 'en', deps, now, away.since)
    await started
    try {
      currentAway = { ...away, since: new Date(start + 1000).toISOString() }
      state = { since: currentAway.since, lastBucket: bucket }
      expect(await answerAwayDigestWithDeps('yes', bucket, 'en', deps, now + 1000, currentAway.since)).toEqual({ ok: true, conversationId: 'nay-B', bucket })
    } finally { release() }
    expect(await first).toEqual({ ok: false, error: 'stale' })
    expect(state).toEqual({ since: currentAway.since, lastBucket: bucket, lastDeliveredAt: now + 1000, conversationId: 'nay-B' })
  })

  test('stale bucket is refused and failures remain retryable', async () => {
    const stale = fixture()
    expect(await answerAwayDigestWithDeps('yes', bucket - 1, 'en', stale.deps, start + 5 * 60 * 60 * 1000, away.since)).toEqual({ ok: false, error: 'stale' })
    const failed = fixture({ start: async () => ({ ok: false }) })
    expect(await answerAwayDigestWithDeps('yes', bucket, 'en', failed.deps, start + 5 * 60 * 60 * 1000, away.since)).toEqual({ ok: false, error: 'failed' })
    expect(failed.state.conversationId).toBeUndefined()
    expect(failed.counts().starts).toBe(1)
    const retry = fixture({ state: failed.state })
    expect((await answerAwayDigestWithDeps('yes', bucket, 'en', retry.deps, start + 5 * 60 * 60 * 1000, away.since)).ok).toBe(true)
  })

  test('old notification since is stale even when its bucket collides with the new window', async () => {
    const f = fixture()
    const newSince = new Date(start + 1000).toISOString()
    const newAway = { ...away, since: newSince }
    const deps = { ...f.deps, read: async () => ({ away: newAway, awayDigest: { since: newSince, lastBucket: bucket } }) }
    expect(await answerAwayDigestWithDeps('yes', bucket, 'en', deps, start + 5 * 60 * 60 * 1000, away.since)).toEqual({ ok: false, error: 'stale' })
  })

  test('Nay launch result carries saved harness/model/effort and prompt language is explicit', async () => {
    let prompt = ''
    const p = fixture({ start: async () => ({ ok: true, id: 'nay-settings', launch: { harness: 'gemini', model: 'gemini-2.5-pro', effort: 'medium' } }), prompt: async (_lang, _id, text) => { prompt = text; return { ok: true } } })
    expect((await answerAwayDigestWithDeps('yes', bucket, 'pt', p.deps, start + 5 * 60 * 60 * 1000, away.since)).ok).toBe(true)
    for (const section of ['Resumo', 'Releases', 'Tarefas', 'Sessões', 'Check-ins', 'Avisos', 'Esperando por você']) expect(prompt).toContain(section)
    const english = awayDigestPrompt('en', away, start, {})
    for (const section of ['Summary', 'Releases', 'Tasks', 'Sessions', 'Check-ins', 'Notices', 'Waiting for you']) expect(english).toContain(section)
  })

  test('prompt starts at the last delivered digest, not the original away time', () => {
    const delivered = start + 6 * 60 * 60 * 1000
    const prompt = awayDigestPrompt('en', away, delivered + 1_000, {}, delivered)
    expect(prompt).toContain(`Window: ${new Date(delivered).toISOString()} to ${new Date(delivered + 1_000).toISOString()}`)
    expect(prompt).not.toContain(`Window: ${away.since} to`)
  })

  test('overlapping offers for one bucket spawn and prompt only once', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let starts = 0
    let prompts = 0
    const f = fixture({
      start: async () => { starts++; await gate; return { ok: true, id: 'nay-overlap' } },
      prompt: async () => { prompts++; return { ok: true } },
    })
    const first = answerAwayDigestWithDeps('yes', bucket, 'en', f.deps, start + 5 * 60 * 60 * 1000, away.since)
    await Promise.resolve()
    const second = answerAwayDigestWithDeps('yes', bucket, 'en', f.deps, start + 5 * 60 * 60 * 1000, away.since)
    release()
    const results = await Promise.all([first, second])
    expect(results[1]).toEqual(results[0])
    expect({ starts, prompts }).toEqual({ starts: 1, prompts: 1 })
  })
})

describe('away digest progress', () => {
  test('reports each real step as it starts, in order, and only on yes', async () => {
    const f = fixture()
    const phases: string[] = []
    await answerAwayDigestWithDeps('yes', bucket, 'en', { ...f.deps, onPhase: p => phases.push(p) }, start + 5 * 60 * 60 * 1000, away.since)
    expect(phases).toEqual(['collect', 'prepare', 'send'])
    const g = fixture()
    const none: string[] = []
    await answerAwayDigestWithDeps('no', bucket, 'en', { ...g.deps, onPhase: p => none.push(p) }, start + 5 * 60 * 60 * 1000, away.since)
    expect(none).toEqual([])
  })

  test('a failed start stops at prepare: send is never claimed', async () => {
    const f = fixture({ start: async () => ({ ok: false }) })
    const phases: string[] = []
    expect(await answerAwayDigestWithDeps('yes', bucket, 'en', { ...f.deps, onPhase: p => phases.push(p) }, start + 5 * 60 * 60 * 1000, away.since)).toEqual({ ok: false, error: 'failed' })
    expect(phases).toEqual(['collect', 'prepare'])
  })

  test('a configured schedule decides which bucket an answer belongs to', async () => {
    const f = fixture({ state: { since: away.since, lastBucket: 2 } })
    const deps = { ...f.deps, read: async () => ({ away, awayDigest: f.state, awayDigestSchedule: { firstAfterMin: 60, everyMin: 30 } }) }
    expect((await answerAwayDigestWithDeps('yes', 2, 'en', deps, start + 60 * 60 * 1000, away.since)).ok).toBe(true)
  })

  test('the stream ends with writing and waits for the answer before done', async () => {
    const lines = await readLines(awayDigestAnswerStream(async onPhase => { onPhase('collect'); onPhase('prepare'); onPhase('send'); return { ok: true, conversationId: 'nay-1', bucket } }, async id => id === 'nay-1' ? 'started' : 'timeout', 'yes'))
    expect(lines).toEqual([{ phase: 'collect' }, { phase: 'prepare' }, { phase: 'send' }, { phase: 'writing' }, { done: true, result: { ok: true, conversationId: 'nay-1', bucket }, answerStarted: true }])
  })

  test('a login dialog is reported as needing login, never as writing started', () => {
    const banner = ['Welcome to Claude Code', 'Select login method:', '1. Claude account']
    expect(nayAnswerProgress({ status: 'running', activity: 'working', lastLines: banner })).toBe('login')
    expect(nayAnswerProgress({ status: 'running', activity: 'working', chatTurns: [], lastLines: ['Do you trust the files in this folder?'] })).toBe('login')
    expect(nayAnswerProgress({ status: 'running', activity: 'working', chatTurns: [{ role: 'assistant', text: 'Please log in to the site' }], lastLines: banner })).toBe('started')
  })

  test('waitForNayAnswer returns login at once; the stream reports needsLogin without a started answer', async () => {
    const row = { id: 'a', status: 'running', activity: 'working', lastLines: ['Select login method'] }
    expect(await waitForNayAnswer('a', async () => ({ sessions: [row] }), { timeoutMs: 100, intervalMs: 1, sleep: async () => {} })).toBe('login')
    const lines = await readLines(awayDigestAnswerStream(async onPhase => { onPhase('collect'); return { ok: true, conversationId: 'nay-1', bucket } }, async () => 'login', 'yes'))
    expect(lines.at(-1)).toEqual({ done: true, result: { ok: true, conversationId: 'nay-1', bucket }, answerStarted: false, needsLogin: true })
  })

  test('a repeated yes on an already delivered bucket answers done at once, without writing or waiting', async () => {
    let waited = false
    const lines = await readLines(awayDigestAnswerStream(async () => ({ ok: true, conversationId: 'nay-1', bucket }), async () => { waited = true; return 'timeout' }, 'yes'))
    expect(lines).toEqual([{ done: true, result: { ok: true, conversationId: 'nay-1', bucket } }])
    expect(waited).toBe(false)
  })

  test('a failure or a no never claims writing', async () => {
    expect(await readLines(awayDigestAnswerStream(async () => ({ ok: false, error: 'stale' }), async () => 'started', 'yes')))
      .toEqual([{ done: true, result: { ok: false, error: 'stale' } }])
    expect(await readLines(awayDigestAnswerStream(async () => ({ ok: true, conversationId: '', bucket }), async () => 'started', 'no')))
      .toEqual([{ done: true, result: { ok: true, conversationId: '', bucket } }])
  })

  test('nayAnswerProgress: text from Nay starts it; a pending tool note does not; an ended row is gone', () => {
    expect(nayAnswerProgress(undefined)).toBe('waiting')
    expect(nayAnswerProgress({ status: 'running', activity: 'working', chatTurns: [{ role: 'user', text: 'x' }, { role: 'assistant', text: 'Reading', pending: true }] })).toBe('waiting')
    expect(nayAnswerProgress({ status: 'running', activity: 'working', chatTurns: [{ role: 'assistant', text: '# Resumo' }] })).toBe('started')
    expect(nayAnswerProgress({ status: 'running', activity: 'working', lastLines: ['reading files'] })).toBe('started')
    expect(nayAnswerProgress({ status: 'running', activity: 'working' })).toBe('waiting')
    expect(nayAnswerProgress({ status: 'running', activity: 'waiting' })).toBe('waiting')
    expect(nayAnswerProgress({ status: 'exited' })).toBe('gone')
  })

  test('waitForNayAnswer is bounded and never reports a start it did not see', async () => {
    let t = 0
    const clock = { now: () => t, sleep: async (ms: number) => { t += ms }, intervalMs: 1000, timeoutMs: 3000 }
    expect(await waitForNayAnswer('a', async () => ({ sessions: [{ id: 'a', status: 'running', activity: 'waiting' }] }), clock)).toBe('timeout')
    let polls = 0
    expect(await waitForNayAnswer('a', async () => ({ sessions: [{ id: 'a', status: 'running', activity: ++polls >= 2 ? 'working' : 'waiting', lastLines: ['reading'] }] }), { ...clock, now: () => 0 })).toBe('started')
    expect(await waitForNayAnswer('a', async () => { throw new Error('poll') }, { ...clock, now: (() => { let n = 0; return () => (n += 2000) })() })).toBe('timeout')
  })
})

async function readLines(stream: ReadableStream<Uint8Array>): Promise<unknown[]> {
  const text = await new Response(stream).text()
  return text.split('\n').filter(l => l.trim()).map(l => JSON.parse(l))
}

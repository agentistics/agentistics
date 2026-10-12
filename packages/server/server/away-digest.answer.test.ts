import { describe, expect, test } from 'bun:test'
import { answerAwayDigestWithDeps, awayDigestPrompt, type AwayDigestAnswerDeps, type AwayDigestState } from './away-digest'

const start = Date.parse('2026-01-01T00:00:00.000Z')
const away = { on: true as const, since: new Date(start).toISOString(), until: null, authorizations: [], note: '', workerCeiling: null, topModelCaps: {} }
const bucket = 20

function fixture(overrides: Partial<{ state: AwayDigestState; start: AwayDigestAnswerDeps['startNay']; prompt: AwayDigestAnswerDeps['prompt'] }> = {}) {
  let state: AwayDigestState = overrides.state ?? { since: away.since, lastBucket: bucket }
  let starts = 0
  let prompts = 0
  const deps: AwayDigestAnswerDeps = {
    read: async () => ({ away, awayDigest: state }),
    write: async next => { state = next },
    build: async () => ({ window: { since: away.since }, releases: 'unavailable' }),
    startNay: async lang => { starts++; return overrides.start?.(lang) ?? { ok: true, id: 'nay-1', launch: { harness: 'codex', model: 'o3', effort: 'high' } } },
    prompt: async (lang, id, text) => { prompts++; return overrides.prompt?.(lang, id, text) ?? { ok: true } },
  }
  return { deps, get state() { return state }, counts: () => ({ starts, prompts }) }
}

describe('away digest answers', () => {
  test('Yes spawns once, prompts with both language-specific report sections, and is idempotent', async () => {
    const f = fixture()
    const first = await answerAwayDigestWithDeps('yes', bucket, 'en', f.deps, start + 5 * 60 * 60 * 1000)
    const second = await answerAwayDigestWithDeps('yes', bucket, 'en', f.deps, start + 5 * 60 * 60 * 1000)
    expect(first).toEqual({ ok: true, conversationId: 'nay-1', bucket })
    expect(second).toEqual(first)
    expect(f.counts()).toEqual({ starts: 1, prompts: 1 })
  })

  test('No snoozes for one hour and never spawns', async () => {
    const f = fixture()
    const out = await answerAwayDigestWithDeps('no', bucket, 'pt', f.deps, start + 5 * 60 * 60 * 1000)
    expect(out).toEqual({ ok: true, conversationId: '', bucket })
    expect(f.state.snoozedUntil).toBe(start + 6 * 60 * 60 * 1000)
    expect(f.counts()).toEqual({ starts: 0, prompts: 0 })
  })

  test('stale bucket is refused and failures remain retryable', async () => {
    const stale = fixture()
    expect(await answerAwayDigestWithDeps('yes', bucket - 1, 'en', stale.deps, start + 5 * 60 * 60 * 1000)).toEqual({ ok: false, error: 'stale' })
    const failed = fixture({ start: async () => ({ ok: false }) })
    expect(await answerAwayDigestWithDeps('yes', bucket, 'en', failed.deps, start + 5 * 60 * 60 * 1000)).toEqual({ ok: false, error: 'failed' })
    expect(failed.state.conversationId).toBeUndefined()
    expect(failed.counts().starts).toBe(1)
    const retry = fixture({ state: failed.state })
    expect((await answerAwayDigestWithDeps('yes', bucket, 'en', retry.deps, start + 5 * 60 * 60 * 1000)).ok).toBe(true)
  })

  test('Nay launch result carries saved harness/model/effort and prompt language is explicit', async () => {
    let prompt = ''
    const p = fixture({ start: async () => ({ ok: true, id: 'nay-settings', launch: { harness: 'gemini', model: 'gemini-2.5-pro', effort: 'medium' } }), prompt: async (_lang, _id, text) => { prompt = text; return { ok: true } } })
    expect((await answerAwayDigestWithDeps('yes', bucket, 'pt', p.deps, start + 5 * 60 * 60 * 1000)).ok).toBe(true)
    for (const section of ['Resumo', 'Releases', 'Tarefas', 'Sessões', 'Check-ins', 'Avisos', 'Esperando por você']) expect(prompt).toContain(section)
    const english = awayDigestPrompt('en', away, start, {})
    for (const section of ['Summary', 'Releases', 'Tasks', 'Sessions', 'Check-ins', 'Notices', 'Waiting for you']) expect(english).toContain(section)
  })
})

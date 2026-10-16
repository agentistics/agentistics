import { afterEach, describe, expect, it } from 'bun:test'
import { activeCapProviders, awayUntilLabel, setSessionAway, untilFromChoice } from './awayMode'

describe('away mode helpers', () => {
  const now = new Date(2026, 9, 11, 23, 50).getTime()
  it('maps choices to instants on the local clock', () => {
    expect(untilFromChoice('back', now)).toBeNull()
    expect(Date.parse(untilFromChoice('2h', now)!)).toBe(now + 2 * 3_600_000)
    const t = new Date(untilFromChoice('tomorrow9', now)!)
    expect([t.getDate(), t.getHours(), t.getMinutes()]).toEqual([12, 9, 0])
  })
  it('labels the until', () => {
    expect(awayUntilLabel({ on: true, since: '', until: null, authorised: [], maxWorkers: 6, topCaps: {} }, 'en', now)).toBe("until you're back")
    expect(awayUntilLabel({ on: true, since: '', until: new Date(now + 3_600_000).toISOString(), authorised: [], maxWorkers: 6, topCaps: {} }, 'pt', now)).toMatch(/^até /)
  })
})

describe('activeCapProviders', () => {
  const order = ['claude', 'codex', 'gemini', 'copilot', 'antigravity', 'kimi', 'opencode', 'agentistics']
  it('lists only providers with an active plan or a stored ceiling, in display order', () => {
    expect(activeCapProviders(order, [{ harness: 'codex' }], [{ harness: 'claude' }], {})).toEqual(['claude', 'codex'])
    expect(activeCapProviders(order, null, [], { gemini: 1 })).toEqual(['gemini'])
    expect(activeCapProviders(order, [], [], {})).toEqual([])
  })
  it('never lists a harness no ceiling can name', () => {
    expect(activeCapProviders(order, [{ harness: 'agentistics' }], [], {})).toEqual([])
  })
})

describe('session away requests', () => {
  const originalFetch = globalThis.fetch
  afterEach(() => { globalThis.fetch = originalFetch })
  it('uses the same endpoint for individual and all-active scopes, without changing global state', async () => {
    const sent: { url: string; body: unknown }[] = []
    globalThis.fetch = (async (url: unknown, init: RequestInit) => {
      sent.push({ url: String(url), body: JSON.parse(String(init.body)) })
      return Response.json({ ok: true, queued: false, effective: true })
    }) as unknown as typeof fetch
    expect(await setSessionAway('managed', true, 'pt')).toEqual({ ok: true, queued: false, effective: true })
    await setSessionAway('managed', false, 'en', 'active')
    expect(sent).toEqual([
      { url: '/api/away/session', body: { target: 'managed', on: true, lang: 'pt' } },
      { url: '/api/away/session', body: { target: 'managed', on: false, lang: 'en', scope: 'active' } },
    ])
  })
  it('returns route refusals so the confirmation can keep its error visible', async () => {
    globalThis.fetch = (async () => Response.json({ ok: false, error: 'leader_only' }, { status: 403 })) as unknown as typeof fetch
    expect(await setSessionAway('managed', true, 'pt')).toEqual({ ok: false, error: 'leader_only' })
  })
})

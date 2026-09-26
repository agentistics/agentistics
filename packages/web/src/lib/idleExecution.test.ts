import { describe, expect, it } from 'bun:test'
import { bannerVisible, runIdlePlan, type IdleEffects, type IdlePlanItem } from './idleExecution'

const item = (id: string, action: IdlePlanItem['action']): IdlePlanItem => ({
  id, key: id, title: id.toUpperCase(), action, group: { kind: 'new', name: 'G' },
})
const fx = (over: Partial<IdleEffects> = {}): IdleEffects & { log: string[] } => {
  const log: string[] = []
  return {
    log,
    stillIdle: async () => true,
    ensureGroup: g => { log.push(`group:${g.name}`); return 'g1' },
    fileInto: (g, k) => { log.push(`file:${g}:${k}`) },
    end: async id => { log.push(`end:${id}`); return { ok: true, message: 'ok' } },
    keep: keys => { log.push(`keep:${keys.join(',')}`) },
    ...over,
  }
}

describe('runIdlePlan', () => {
  it('files THEN ends for file-end; only ends for end; only keeps for keep', async () => {
    const f = fx()
    const out = await runIdlePlan([item('a', 'file-end'), item('b', 'end'), item('c', 'keep')], f)
    expect(f.log).toEqual(['group:G', 'file:g1:a', 'end:a', 'end:b', 'keep:c'])
    expect(out.map(o => o.result)).toEqual(['ended', 'ended', 'kept'])
  })
  it('a failed end is reported with the server sentence and does not stop the others', async () => {
    const f = fx({ end: async id => (id === 'a' ? { ok: false, message: 'not confirmed' } : { ok: true, message: 'ok' }) })
    const out = await runIdlePlan([item('a', 'file-end'), item('b', 'end')], f)
    expect(out[0]).toMatchObject({ result: 'failed', message: 'not confirmed' })
    expect(out[1]!.result).toBe('ended')
  })
  it('a session no longer idle is skipped, untouched', async () => {
    const f = fx({ stillIdle: async id => id !== 'a' })
    const out = await runIdlePlan([item('a', 'file-end')], f)
    expect(out[0]!.result).toBe('skipped')
    expect(f.log).toEqual([])
  })
  it('a group that cannot be made fails that session before ending it', async () => {
    const f = fx({ ensureGroup: () => null })
    const out = await runIdlePlan([item('a', 'file-end')], f)
    expect(out[0]!.result).toBe('failed')
    expect(f.log).toEqual([])
  })
})

describe('bannerVisible', () => {
  it('shows with candidates while the modal is closed and not snoozed', () => {
    expect(bannerVisible({ candidates: 2, modalOpen: false, snoozedUntil: null, now: 10 })).toBe(true)
    expect(bannerVisible({ candidates: 0, modalOpen: false, snoozedUntil: null, now: 10 })).toBe(false)
    expect(bannerVisible({ candidates: 2, modalOpen: true, snoozedUntil: null, now: 10 })).toBe(false)
    expect(bannerVisible({ candidates: 2, modalOpen: false, snoozedUntil: 20, now: 10 })).toBe(false)
    expect(bannerVisible({ candidates: 2, modalOpen: false, snoozedUntil: 5, now: 10 })).toBe(true)
  })
})

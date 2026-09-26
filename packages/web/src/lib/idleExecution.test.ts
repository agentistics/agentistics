import { describe, expect, it } from 'bun:test'
import {
  bannerVisible, idleBannerText, idleSessionNoun, idleSummaryText, resolveGroupSuggestion, runIdlePlan,
  type IdleEffects, type IdlePlanItem,
} from './idleExecution'

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

describe('resolveGroupSuggestion', () => {
  it('two items suggesting the same new-group name reuse the first creation, one creation only', () => {
    const created = new Map<string, string>()
    const first = resolveGroupSuggestion({ kind: 'new', name: 'Idle · 2026-09-26' }, [], created)
    expect(first).toEqual({ action: 'create', name: 'Idle · 2026-09-26' })
    created.set('Idle · 2026-09-26', 'g-run') // what `ensureGroup` does after creating.
    const second = resolveGroupSuggestion({ kind: 'new', name: 'Idle · 2026-09-26' }, [], created)
    expect(second).toEqual({ action: 'reuse', groupId: 'g-run' })
  })
  it('a new-group suggestion reuses an existing group with the exact name', () => {
    const existing = [{ id: 'g1', name: 'Idle · 2026-09-26' }]
    const r = resolveGroupSuggestion({ kind: 'new', name: 'Idle · 2026-09-26' }, existing, new Map())
    expect(r).toEqual({ action: 'reuse', groupId: 'g1' })
  })
  it('an existing suggestion reuses its own id when the group is still there', () => {
    const existing = [{ id: 'g1', name: 'Task X' }]
    const r = resolveGroupSuggestion({ kind: 'existing', groupId: 'g1', name: 'Task X' }, existing, new Map())
    expect(r).toEqual({ action: 'reuse', groupId: 'g1' })
  })
  it('an existing suggestion whose id vanished creates by its name', () => {
    const r = resolveGroupSuggestion({ kind: 'existing', groupId: 'gone', name: 'Task X' }, [], new Map())
    expect(r).toEqual({ action: 'create', name: 'Task X' })
  })
  it('an existing suggestion whose id vanished reuses a same-run creation by name first', () => {
    const created = new Map([['Task X', 'g-run']])
    const r = resolveGroupSuggestion({ kind: 'existing', groupId: 'gone', name: 'Task X' }, [], created)
    expect(r).toEqual({ action: 'reuse', groupId: 'g-run' })
  })
  it('an existing suggestion whose id vanished falls back to a same-named survivor', () => {
    const existing = [{ id: 'g2', name: 'Task X' }]
    const r = resolveGroupSuggestion({ kind: 'existing', groupId: 'gone', name: 'Task X' }, existing, new Map())
    expect(r).toEqual({ action: 'reuse', groupId: 'g2' })
  })
})

describe('idle-sessions plural copy', () => {
  it('idleSessionNoun picks the singular only at exactly 1', () => {
    expect(idleSessionNoun(1, 'en')).toBe('session')
    expect(idleSessionNoun(0, 'en')).toBe('sessions')
    expect(idleSessionNoun(2, 'en')).toBe('sessions')
    expect(idleSessionNoun(1, 'pt')).toBe('sessão')
    expect(idleSessionNoun(2, 'pt')).toBe('sessões')
  })
  it('idleBannerText agrees the PT verb and adjective, not only the noun', () => {
    expect(idleBannerText(1, 'en')).toBe('1 idle session could be ended')
    expect(idleBannerText(3, 'en')).toBe('3 idle sessions could be ended')
    expect(idleBannerText(1, 'pt')).toBe('1 sessão ociosa pode ser encerrada')
    expect(idleBannerText(3, 'pt')).toBe('3 sessões ociosas podem ser encerradas')
  })
  it('idleSummaryText never prints "session(s)"', () => {
    expect(idleSummaryText(1, null, 'en')).toBe('1 session')
    expect(idleSummaryText(2, null, 'en')).toBe('2 sessions')
    expect(idleSummaryText(1, '2.1 GB', 'en')).toBe('1 session · frees ~2.1 GB')
    expect(idleSummaryText(1, null, 'pt')).toBe('1 sessão')
    expect(idleSummaryText(2, '2.1 GB', 'pt')).toBe('2 sessões · libera ~2.1 GB')
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

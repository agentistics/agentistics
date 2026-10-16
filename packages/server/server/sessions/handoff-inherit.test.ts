import { describe, expect, it } from 'bun:test'
import { handoffCheckinPatch, handoffInheritPatch, handoffPinPatch, handoffTitle, inheritHandoffPrefs, nextHandoffSeq } from './handoff-inherit'
import type { Preferences } from '../preferences'

const parent = { id: 'p1', conversationId: 'conv-p' }
const child = { id: 'c1', conversationId: 'conv-c' }
const prefs = (p: Record<string, unknown>) => p as unknown as Preferences

describe('title rule', () => {
  it('keeps the predecessor title, ignoring the requested one', () => {
    expect(handoffTitle('[ LÍDER ] - Motor', '[ LÍDER ] - Motor (sessão 47)')).toBe('[ LÍDER ] - Motor')
  })
  it('falls back to the requested label when the predecessor has none', () => {
    expect(handoffTitle(undefined, 'x')).toBe('x')
    expect(handoffTitle('  ', 'x')).toBe('x')
  })
})

describe('generation counter', () => {
  it('is predecessor + 1, starting at 2', () => {
    expect(nextHandoffSeq(undefined)).toBe(2)
    expect(nextHandoffSeq(46)).toBe(47)
    expect(nextHandoffSeq(0)).toBe(2)
  })
})

describe('pin', () => {
  it('the successor takes the predecessor slot', () => {
    expect(handoffPinPatch(prefs({ pinnedSessions: ['a', 'conv-p', 'b'] }), parent, child)?.pinnedSessions).toEqual(['a', 'conv-c', 'b'])
  })
  it('finds a pin recorded under the managed id', () => {
    expect(handoffPinPatch(prefs({ pinnedSessions: ['p1'] }), parent, child)?.pinnedSessions).toEqual(['conv-c'])
  })
  it('does nothing for an unpinned predecessor or when already pinned', () => {
    expect(handoffPinPatch(prefs({ pinnedSessions: ['a'] }), parent, child)).toBeUndefined()
    expect(handoffPinPatch(prefs({}), parent, child)).toBeUndefined()
    expect(handoffPinPatch(prefs({ pinnedSessions: ['conv-p', 'conv-c'] }), parent, child)).toBeUndefined()
  })
})

describe('check-in', () => {
  const agenda = { session: 'conv-p', intervalMin: 60, paused: null, checklist: [], lastRunAt: 5, nextRunAt: 99, last: null, pending: true, fingerprint: 'f' }
  it('copies the agenda (schedule included) under the successor key, dropping transient fields', () => {
    const out = handoffCheckinPatch(prefs({ checkin: { 'conv-p': agenda } }), parent, child)?.checkin as Record<string, any>
    expect(out['conv-c']).toMatchObject({ session: 'conv-c', intervalMin: 60, lastRunAt: 5, nextRunAt: 99 })
    expect(out['conv-c'].pending).toBeUndefined()
    expect(out['conv-c'].fingerprint).toBeUndefined()
    expect(out['conv-p']).toBeDefined()
  })
  it('does nothing without an agenda, or when the successor already has one', () => {
    expect(handoffCheckinPatch(prefs({}), parent, child)).toBeUndefined()
    expect(handoffCheckinPatch(prefs({ checkin: { 'conv-p': agenda, 'conv-c': {} } }), parent, child)).toBeUndefined()
  })
})

describe('combined', () => {
  it('folder + pin + check-in land in one patch; an unpinned, folderless, agendaless leader changes nothing', () => {
    const full = handoffInheritPatch(prefs({
      sessionGroups: { groups: [{ id: 'g', name: 'Líderes', sessionKeys: ['conv-p'] }] },
      pinnedSessions: ['conv-p'], checkin: { 'conv-p': { session: 'conv-p', intervalMin: 30 } },
    }), parent, child)
    expect(full?.sessionGroups?.groups[0]?.sessionKeys).toEqual(['conv-p', 'conv-c'])
    expect(full?.pinnedSessions).toEqual(['conv-c'])
    expect((full?.checkin as Record<string, unknown>)['conv-c']).toBeDefined()
    expect(handoffInheritPatch(prefs({}), parent, child)).toBeUndefined()
  })
  it('writes through the mutator and never throws', async () => {
    let seen: Partial<Preferences> | undefined
    const ok = await inheritHandoffPrefs(parent, child, async m => { seen = m(prefs({ pinnedSessions: ['conv-p'] })) as Partial<Preferences> })
    expect(ok).toBe(true)
    expect(seen?.pinnedSessions).toEqual(['conv-c'])
    expect(await inheritHandoffPrefs(parent, child, async () => { throw new Error('x') })).toBe(false)
  })
})

import { describe, expect, it } from 'bun:test'
import { handoffCheckinPatch, handoffInheritPatch, handoffMutePatch, handoffSpawnDefaults, handoffPinPatch, handoffTitle, inheritHandoffPrefs, passPinToSuccessor, nextHandoffSeq, rekeyCheckinSession } from './handoff-inherit'
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
  it('keeps a Codex successor agenda when its conversation is linked after spawn', async () => {
    const codexChild = { id: 'codex-managed', harness: 'codex' }
    let current = prefs({ checkin: { 'conv-p': { ...agenda, paused: true, checklist: ['review'] } } })
    current = { ...current, ...handoffCheckinPatch(current, parent, codexChild) }
    const inherited = current.checkin![codexChild.id]
    // A concurrent poll may seed defaults at the conversation key before the migration.
    current.checkin!['codex-conversation'] = { intervalMin: 5 }
    await rekeyCheckinSession(codexChild.id, 'codex-conversation', async mutate => {
      current = { ...current, ...mutate(current) }
    })
    expect(current.checkin!['codex-conversation']).toEqual({ ...inherited as object, session: 'codex-conversation' })
    expect(current.checkin![codexChild.id]).toBeUndefined()
    expect(current.checkin!['conv-p']).toBeDefined()
  })
  it('both conversation-link paths migrate check-in alongside folder membership', async () => {
    const src = await Bun.file(new URL('../cli-start.ts', import.meta.url)).text()
    for (const id of ['id', 'sid']) {
      expect(src).toContain(`await rekeyCheckinSession(${id}, conversationId, updatePreferences)`)
    }
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

describe('CLI hand-off end to end (preferences)', () => {
  const mkPrefs = () => prefs({
    sessionGroups: { groups: [{ id: 'g1', name: 'Leaders', sessionKeys: ['conv-p'] }] },
    pinnedSessions: ['a', 'conv-p', 'b'],
    checkin: { 'conv-p': { intervalMin: 30, session: 'conv-p', pending: 'x' } },
  })
  const upd = (p: Preferences) => async (mutate: (c: Preferences) => Partial<Preferences> | undefined | void | Promise<Partial<Preferences> | undefined | void>) => {
    const patch = await mutate(p)
    if (patch) Object.assign(p, patch)
    return p
  }

  it('successor gets folder, pin at the same index and the check-in agenda', async () => {
    const p = mkPrefs()
    expect(await inheritHandoffPrefs(parent, child, upd(p))).toBe(true)
    expect(p.pinnedSessions).toEqual(['a', 'conv-c', 'b'])
    expect(p.sessionGroups?.groups[0]?.sessionKeys).toContain('conv-c')
    expect((p.checkin as Record<string, unknown>)['conv-c']).toMatchObject({ intervalMin: 30, session: 'conv-c' })
  })

  it('filing (moving) the predecessor afterwards leaves the successor pinned', async () => {
    const { fileInFolder } = await import('./cli-folder')
    const p = mkPrefs()
    ;(p as unknown as { sessionGroups: { groups: unknown[] } }).sessionGroups.groups.push({ id: 'fin', name: 'Finalizadas', sessionKeys: [] })
    await inheritHandoffPrefs(parent, child, upd(p))
    await passPinToSuccessor(parent, child, upd(p))
    await fileInFolder('fin', parent, { read: async () => p, update: upd(p) as never })
    expect(p.pinnedSessions).toEqual(['a', 'conv-c', 'b'])
  })

  it('a successor that did NOT take the pin gets it before the predecessor is filed', async () => {
    const { fileInFolder } = await import('./cli-folder')
    const p = mkPrefs()
    ;(p as unknown as { sessionGroups: { groups: unknown[] } }).sessionGroups.groups.push({ id: 'fin', name: 'Finalizadas', sessionKeys: [] })
    expect(await passPinToSuccessor(parent, child, upd(p))).toBe(true)
    await fileInFolder('fin', parent, { read: async () => p, update: upd(p) as never })
    expect(p.pinnedSessions).toEqual(['a', 'conv-c', 'b'])
  })

  it('no successor or no pin: nothing changes', async () => {
    const p = mkPrefs()
    expect(await passPinToSuccessor(parent, undefined, upd(p))).toBe(false)
    expect(await passPinToSuccessor({ id: 'zz' }, child, upd(p))).toBe(false)
    expect(p.pinnedSessions).toEqual(['a', 'conv-p', 'b'])
  })
})

describe('mute', () => {
  it('a muted predecessor hands over a muted successor (under either of its keys)', () => {
    expect(handoffMutePatch(prefs({ mutedSessions: ['x', 'conv-p'] }), parent, child)?.mutedSessions).toEqual(['x', 'conv-p', 'conv-c'])
    expect(handoffMutePatch(prefs({ mutedSessions: ['p1'] }), parent, child)?.mutedSessions).toEqual(['p1', 'conv-c'])
  })
  it('nothing to change when the predecessor is not muted, or the successor already is', () => {
    expect(handoffMutePatch(prefs({ mutedSessions: ['x'] }), parent, child)).toBeUndefined()
    expect(handoffMutePatch(prefs({}), parent, child)).toBeUndefined()
    expect(handoffMutePatch(prefs({ mutedSessions: ['conv-p', 'conv-c'] }), parent, child)).toBeUndefined()
  })
  it('is part of the one inherit patch, beside the pin', () => {
    const patch = handoffInheritPatch(prefs({ pinnedSessions: ['conv-p'], mutedSessions: ['conv-p'] }), parent, child)
    expect(patch?.pinnedSessions).toEqual(['conv-c'])
    expect(patch?.mutedSessions).toEqual(['conv-p', 'conv-c'])
  })
})

describe('launch flags', () => {
  const pred = { harness: 'claude', model: 'claude-opus-5-5', effort: 'high' }
  it('a hand-off that names nothing takes the predecessor model and effort', () => {
    expect(handoffSpawnDefaults(pred, 'claude', {})).toEqual({ model: 'claude-opus-5-5', effort: 'high' })
  })
  it('a flag that was given always wins, and an effort is not carried onto another model', () => {
    expect(handoffSpawnDefaults(pred, 'claude', { model: 'claude-sonnet-5-5' })).toEqual({ model: 'claude-sonnet-5-5' })
    expect(handoffSpawnDefaults(pred, 'claude', { effort: 'low' })).toEqual({ model: 'claude-opus-5-5', effort: 'low' })
  })
  it('another harness inherits no flag (a model id means nothing to another CLI)', () => {
    expect(handoffSpawnDefaults(pred, 'codex', {})).toEqual({})
    expect(handoffSpawnDefaults(pred, 'codex', { model: 'gpt-6.1-sol' })).toEqual({ model: 'gpt-6.1-sol' })
  })
  it('no predecessor: exactly what was given', () => {
    expect(handoffSpawnDefaults(undefined, 'claude', { model: 'm' })).toEqual({ model: 'm' })
  })
})

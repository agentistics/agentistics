import { describe, expect, it } from 'bun:test'
import { HARNESS_ORDER, type HarnessId } from '@agentistics/core'
import type { Conversation } from './conversations'
import { reopenTargetFor, resumableById } from './reopen-target'
import { SPAWN_SPECS } from './spawn-spec'

const conv = (sessionId: string, over: Partial<Conversation> = {}): Conversation => ({
  sessionId, harness: 'claude', cwd: '/repo/a', title: `t-${sessionId}`,
  lastActivityMs: 1, startedMs: 0, resumable: true, firstPrompt: '', ...over,
})

/** Every harness the session manager can reopen by id — read off the spec table, never listed. */
const RESUMABLE = HARNESS_ORDER.filter(h => SPAWN_SPECS[h]?.resume !== undefined)

describe('resumableById', () => {
  it('follows SPAWN_SPECS for every harness', () => {
    for (const h of HARNESS_ORDER) expect(resumableById(h)).toBe(SPAWN_SPECS[h]?.resume !== undefined)
    expect(resumableById(undefined)).toBe(false)
  })

  it('covers the five harnesses with an id-taking resume, and not gemini', () => {
    for (const h of ['claude', 'codex', 'copilot', 'kimi', 'antigravity'] as HarnessId[]) {
      expect(RESUMABLE).toContain(h)
    }
    expect(RESUMABLE).not.toContain('gemini')
  })
})

describe('reopenTargetFor — a row that knows its conversation', () => {
  it('takes it from the store when the store holds it', () => {
    const taken = new Set<string>()
    const t = reopenTargetFor({
      entry: { harness: 'claude', cwd: '/repo/a', conversationId: 'mine' },
      pool: [conv('older'), conv('mine')],
      taken,
    })
    expect(t).toEqual({ sessionId: 'mine', title: 't-mine', via: 'store' })
    expect(taken.has('mine')).toBe(true)
  })

  it('the harness\'s own statement outranks the registry record', () => {
    const t = reopenTargetFor({
      entry: { harness: 'claude', cwd: '/repo/a', conversationId: 'recorded' },
      exactId: 'stated',
      pool: [conv('recorded'), conv('stated')],
      taken: new Set(),
    })
    expect(t?.sessionId).toBe('stated')
  })

  it('refuses a stored conversation its harness cannot resume', () => {
    const t = reopenTargetFor({
      entry: { harness: 'gemini', cwd: '/repo/a', conversationId: 'g' },
      pool: [conv('g', { harness: 'gemini', resumable: false })],
      taken: new Set(),
    })
    expect(t).toBeNull()
  })

  for (const harness of RESUMABLE) {
    it(`${harness}: reopens from the EXACT link when the store lacks it and the transcript is on disk`, () => {
      const taken = new Set<string>()
      const t = reopenTargetFor({
        entry: { harness, cwd: '/repo/a', conversationId: 'exact', harnessName: 'my name' },
        // Same harness, same directory: exactly what the guess would hand out. It must not.
        pool: [conv('older', { harness })],
        onDisk: new Set(['exact']),
        taken,
      })
      expect(t).toEqual({ sessionId: 'exact', title: 'my name', via: 'exact-link' })
      expect(taken.has('exact')).toBe(true)
    })

    it(`${harness}: offers nothing when the transcript was never written (no guess either)`, () => {
      const t = reopenTargetFor({
        entry: { harness, cwd: '/repo/a', conversationId: 'never-written' },
        pool: [conv('older', { harness })],
        onDisk: new Set(),
        taken: new Set(),
      })
      expect(t).toBeNull()
    })

    it(`${harness}: offers nothing from the exact link with no directory to reopen in`, () => {
      const t = reopenTargetFor({
        entry: { harness, conversationId: 'exact' },
        pool: [],
        onDisk: new Set(['exact']),
        taken: new Set(),
      })
      expect(t).toBeNull()
    })
  }

  it('gemini: never reopens from the exact link — its resume takes no id', () => {
    const t = reopenTargetFor({
      entry: { harness: 'gemini', cwd: '/repo/a', conversationId: 'proj/chat' },
      pool: [],
      onDisk: new Set(['proj/chat']),
      taken: new Set(),
    })
    expect(t).toBeNull()
  })

  it('an exact-link target with no persisted name carries an empty title (the row keeps its own label)', () => {
    const t = reopenTargetFor({
      entry: { harness: 'antigravity', cwd: '/repo/a', conversationId: 'x' },
      pool: [], onDisk: new Set(['x']), taken: new Set(),
    })
    expect(t?.title).toBe('')
  })
})

describe('reopenTargetFor — a row that knows nothing', () => {
  it('falls back to the directory guess, one conversation per row', () => {
    const taken = new Set<string>()
    const pool = [conv('c1'), conv('c2')]
    const a = reopenTargetFor({ entry: { harness: 'claude', cwd: '/repo/a' }, pool, taken })
    const b = reopenTargetFor({ entry: { harness: 'claude', cwd: '/repo/a' }, pool, taken })
    const c = reopenTargetFor({ entry: { harness: 'claude', cwd: '/repo/a' }, pool, taken })
    expect([a?.sessionId, b?.sessionId, c]).toEqual(['c1', 'c2', null])
    expect(a?.via).toBe('directory')
  })

  it('never crosses harnesses or directories', () => {
    const pool = [conv('c1', { harness: 'codex' }), conv('c2', { cwd: '/repo/b' })]
    expect(reopenTargetFor({ entry: { harness: 'claude', cwd: '/repo/a' }, pool, taken: new Set() })).toBeNull()
  })

  it('the exact-link set never feeds the guess', () => {
    const t = reopenTargetFor({
      entry: { harness: 'antigravity', cwd: '/repo/a' },
      pool: [], onDisk: new Set(['x']), taken: new Set(),
    })
    expect(t).toBeNull()
  })
})

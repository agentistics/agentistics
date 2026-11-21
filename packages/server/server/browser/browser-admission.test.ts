import { describe, expect, test } from 'bun:test'
import { admissionSentence, decideAdmission, evictionCandidate, type LiveBrowserView } from './browser-admission'
import { EVICT_IDLE_MS, MIN_AVAILABLE_BYTES } from './browser-spec'

const GB = 1024 ** 3
const NOW = 10_000_000
const sess = (id: string, o: Partial<LiveBrowserView> = {}): LiveBrowserView =>
  ({ key: `s-${id}`, owner: { kind: 'session', managedId: id }, phase: 'live', viewers: 0, lastActivityMs: NOW, ...o })
const personal = (o: Partial<LiveBrowserView> = {}): LiveBrowserView =>
  ({ key: 'personal', owner: { kind: 'personal' }, phase: 'live', viewers: 0, lastActivityMs: NOW, ...o })
const S = (id: string) => ({ kind: 'session', managedId: id } as const)

describe('admission', () => {
  test('first browser with memory is admitted', () => {
    expect(decideAdmission({ owner: S('a'), live: [], memAvailable: 4 * GB, now: NOW })).toEqual({ ok: true, memory: 'ok' })
  })
  test('an owner with a browser gets it back, never a second one', () => {
    expect(decideAdmission({ owner: S('a'), live: [sess('a')], memAvailable: 0, now: NOW })).toEqual({ ok: true, reuse: 's-a' })
    expect(decideAdmission({ owner: S('a'), live: [sess('a', { phase: 'starting' })], memAvailable: 4 * GB, now: NOW })).toEqual({ ok: true, reuse: 's-a' })
  })
  test('memory: exactly 1.5 GB admits, one byte less refuses', () => {
    expect(decideAdmission({ owner: S('a'), live: [], memAvailable: MIN_AVAILABLE_BYTES, now: NOW }).ok).toBe(true)
    expect(decideAdmission({ owner: S('a'), live: [], memAvailable: MIN_AVAILABLE_BYTES - 1, now: NOW }))
      .toEqual({ ok: false, reason: 'low-memory', memAvailable: MIN_AVAILABLE_BYTES - 1 })
  })
  test('unmeasurable memory is admitted and SAYS so', () => {
    expect(decideAdmission({ owner: S('a'), live: [], memAvailable: null, now: NOW })).toEqual({ ok: true, memory: 'unmeasured' })
  })
  test('a third session is refused while both are watched or busy', () => {
    const live = [sess('a', { viewers: 1, lastActivityMs: 0 }), sess('b')]
    expect(decideAdmission({ owner: S('c'), live, memAvailable: 8 * GB, now: NOW })).toEqual({ ok: false, reason: 'session-ceiling' })
  })
  test('a STARTING browser counts against the ceiling and is never evicted', () => {
    const live = [sess('a', { phase: 'starting', lastActivityMs: 0 }), sess('b', { phase: 'starting', lastActivityMs: 0 })]
    expect(decideAdmission({ owner: S('c'), live, memAvailable: 8 * GB, now: NOW })).toEqual({ ok: false, reason: 'session-ceiling' })
  })
  test('a full session ceiling evicts the least recently active idle unwatched one', () => {
    const live = [sess('a', { lastActivityMs: NOW - EVICT_IDLE_MS - 10 }), sess('b', { lastActivityMs: NOW - EVICT_IDLE_MS - 99 })]
    expect(decideAdmission({ owner: S('c'), live, memAvailable: 8 * GB, now: NOW })).toEqual({ ok: true, evict: 's-b', memory: 'ok' })
  })
  test('idle exactly EVICT_IDLE_MS is not yet evictable', () => {
    expect(evictionCandidate([sess('a', { lastActivityMs: NOW - EVICT_IDLE_MS })], NOW)).toBeNull()
  })
  test('eviction does not lift a memory refusal', () => {
    const live = [sess('a', { lastActivityMs: 0 }), sess('b', { lastActivityMs: 0 })]
    expect(decideAdmission({ owner: S('c'), live, memAvailable: 1 * GB, now: NOW }).ok).toBe(false)
  })
  test('the personal browser does not take a session slot, and vice versa (2 + 1 = 3)', () => {
    expect(decideAdmission({ owner: { kind: 'personal' }, live: [sess('a'), sess('b')], memAvailable: 8 * GB, now: NOW }).ok).toBe(true)
    expect(decideAdmission({ owner: S('b'), live: [sess('a'), personal()], memAvailable: 8 * GB, now: NOW }).ok).toBe(true)
    expect(decideAdmission({ owner: { kind: 'personal' }, live: [personal()], memAvailable: 8 * GB, now: NOW })).toEqual({ ok: true, reuse: 'personal' })
  })
  test('the personal browser is never evicted for a session', () => {
    const live = [sess('a', { viewers: 1 }), sess('b', { viewers: 1 }), personal({ lastActivityMs: 0 })]
    expect(decideAdmission({ owner: S('c'), live, memAvailable: 8 * GB, now: NOW })).toEqual({ ok: false, reason: 'session-ceiling' })
  })
  test('refusals are sentences in both languages', () => {
    for (const r of ['session-ceiling', 'live-ceiling', 'low-memory'] as const) {
      expect(admissionSentence(r, 'en').length).toBeGreaterThan(20)
      expect(admissionSentence(r, 'pt').length).toBeGreaterThan(20)
    }
    expect(admissionSentence('low-memory', 'pt', 1.2 * GB)).toContain('1.2 GB')
  })
})

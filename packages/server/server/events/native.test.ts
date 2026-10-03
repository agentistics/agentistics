import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nativeEvent, recordNativeEvent, type NativeSessionEventInput } from './native'
import { createEventStore } from './event-store'
import { parseEvent } from './event-line'
import type { SessionEvent } from './event-types'
import type { Subscription } from './subscriptions'

const input = (p: Partial<NativeSessionEventInput> = {}): NativeSessionEventInput => ({
  sessionId: 'ses_abc', kind: 'waiting-approval', from: 'working', cwd: '/w/app', label: 'fix the build', taskId: 't-1', at: '2026-10-03T12:00:00.000Z', ...p,
})

describe('H17: a native session waiting for you, into the agentop events channel', () => {
  test('the event is facts only: which session, where, which task, from what to what', () => {
    const e = nativeEvent(input(), undefined)!
    expect(e).toMatchObject({ source: 'native', kind: 'waiting-approval', from: 'working', id: 'native:ses_abc', cwd: '/w/app', task: 't-1', label: 'fix the build' })
    expect(Object.keys(e).sort()).toEqual(['at', 'cwd', 'from', 'id', 'kind', 'label', 'seq', 'source', 'task', 'v'])
  })

  test('a kind nobody records is dropped; a non-change is not an event', () => {
    expect(nativeEvent(input({ kind: 'working' }), ['waiting', 'waiting-approval'])).toBeNull()
    expect(nativeEvent(input({ kind: 'waiting', from: 'waiting' }), undefined)).toBeNull()
  })

  test('written to the inbox (readable back by the channel\'s own parser) and delivered to the subscription', async () => {
    const store = createEventStore(join(mkdtempSync(join(tmpdir(), 'native-ev-')), 'events.jsonl'))
    const delivered: SessionEvent[] = []
    const sub = { id: 's1', kinds: ['waiting-approval'], desktop: true } as unknown as Subscription
    const written = await recordNativeEvent(input(), {
      readSubscriptions: async () => [sub], store, readMuted: async () => new Set(),
      deliver: async o => { delivered.push(...o.events); return { lines: [], peersReached: 0, peersFailed: 0, toastsShown: 1, toastsFailed: 0 } },
    })
    expect(written?.seq).toBe(1)
    expect(delivered.map(e => e.id)).toEqual(['native:ses_abc'])
    const back = (await store.recent(5)).events
    expect(back.map(e => [e.source, e.kind])).toEqual([['native', 'waiting-approval']])
  })

  test('recorded even with no subscription (the inbox is read by orchestrators); never throws', async () => {
    const store = createEventStore(join(mkdtempSync(join(tmpdir(), 'native-ev-')), 'events.jsonl'))
    const written = await recordNativeEvent(input(), { readSubscriptions: async () => [], store, readMuted: async () => new Set(), deliver: async () => { throw new Error('boom') } })
    expect(written?.kind).toBe('waiting-approval')
    const broken = await recordNativeEvent(input(), { readSubscriptions: async () => [], store: { append: async () => { throw new Error('disk') } } as never, readMuted: async () => new Set(), deliver: async () => ({}) as never })
    expect(broken).toBeNull()
  })

  test('the channel\'s parser reads a native line back', () => {
    const line = JSON.stringify({ ...nativeEvent(input(), undefined)!, seq: 3 })
    expect(parseEvent(line)?.source).toBe('native')
  })
})

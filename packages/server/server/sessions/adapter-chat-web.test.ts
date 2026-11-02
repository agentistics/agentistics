import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { featureOn } from '@agentistics/core'
import { adapterRowOf, searchAdapterChat } from './adapter-chat-web'
import type { SessionSnapshot } from './sessions-host'
import type { SessionView } from './session-view'

const view = (v: Partial<SessionView> & Pick<SessionView, 'id' | 'status'>): SessionView =>
  ({ cwd: '/w/repo', attached: false, approvalDetection: true, searchFields: {}, ...v }) as unknown as SessionView

const snap = (sessions: SessionView[]): SessionSnapshot => ({ sessions, attention: 0, rang: [], polledAtMs: 1 })

describe('adapterRowOf — the adapter stream reads ONE row off the hub snapshot, never the whole fleet', () => {
  test('maps the row the way host.sessions() does: state, conversation, cwd, link', () => {
    const s = snap([
      view({ id: 'a', status: 'running', harness: 'claude', activity: 'working', conversationId: '00000000-0000-4000-8000-000000000001', conversationLink: 'assigned' }),
      view({ id: 'b', status: 'running', harness: 'codex', activity: 'waiting' }),
    ])
    const a = adapterRowOf(s, 'a', 'en')!
    expect(a).toMatchObject({ id: 'a', harness: 'claude', cwd: '/w/repo', state: 'working', conversationId: '00000000-0000-4000-8000-000000000001' })
    expect(a.link).toMatchObject({ reason: 'assigned-id' })
    expect(adapterRowOf(s, 'b', 'pt')).toMatchObject({ id: 'b', state: 'waiting' })
  })

  test('a row the snapshot does not hold is gone (null), and so is everything before the first poll', () => {
    expect(adapterRowOf(snap([]), 'a', 'en')).toBeNull()
    expect(adapterRowOf(null, 'a', 'en')).toBeNull()
  })
})

describe('F4 fix2 — an open adapter stream follows the switch, not only new ones', () => {
  const src = readFileSync(join(import.meta.dir, 'adapter-chat-web.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  const stream = src.slice(src.indexOf('export async function openAdapterChatStream'), src.indexOf('export async function readAdapterChatPayload'))
  test('`current` answers false the moment adapter-chat is off (the next fleet tick closes the stream)', () => {
    const cur = stream.slice(stream.indexOf('current: async () => {'))
    expect(cur.indexOf("if (!featureOn('adapter-chat')) return false")).toBeGreaterThan(0)
    expect(cur.indexOf("if (!featureOn('adapter-chat')) return false")).toBeLessThan(cur.indexOf('findRow('))
  })
  test('the stream registers for the switch reset (closed at once when the switch moves)', () => {
    expect(stream).toContain('onReset: onChatStreamsReset')
  })
})

describe('chat-history-engine — its OWN opt-in, the engine history()/search() read never rides adapter-chat', () => {
  const src = readFileSync(join(import.meta.dir, 'adapter-chat-web.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  test('default OFF, ON only for an explicit 1', () => {
    expect(featureOn('chat-history-engine', {})).toBe(false)
    expect(featureOn('chat-history-engine', { AGENTISTICS_CHAT_HISTORY_ENGINE: '0' })).toBe(false)
    expect(featureOn('chat-history-engine', { AGENTISTICS_CHAT_HISTORY_ENGINE: '1' })).toBe(true)
  })
  test('the history-first branch is gated on it', () => {
    expect(src).toContain("featureOn('chat-history-engine') && historyOf(chat)")
  })
  test('with it OFF the engine search is never asked (null before any hub or engine call)', async () => {
    const prev = process.env.AGENTISTICS_CHAT_HISTORY_ENGINE
    delete process.env.AGENTISTICS_CHAT_HISTORY_ENGINE
    try { expect(await searchAdapterChat('en', 'x', 'q')).toBeNull() }
    finally { if (prev !== undefined) process.env.AGENTISTICS_CHAT_HISTORY_ENGINE = prev }
  })
})

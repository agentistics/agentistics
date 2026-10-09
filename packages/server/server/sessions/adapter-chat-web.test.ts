import { describe, expect, test } from 'bun:test'
import { adapterRowOf } from './adapter-chat-web'
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

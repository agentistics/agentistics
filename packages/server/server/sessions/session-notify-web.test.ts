import { describe, expect, test } from 'bun:test'
import type { GroupsDeps } from './session-groups-web'
import type { Preferences } from '../preferences'
import { notifyOp, notifyStatus } from './session-notify-web'

function deps(initial: string[] = []): { d: GroupsDeps; prefs: Preferences } {
  const prefs: Preferences = { mutedSessions: initial } as Preferences
  const d: GroupsDeps = {
    rows: async () => [
      { id: 'agentop-aaa', conversationId: 'conv-a', title: 'leader' },
      { id: 'agentop-bbb', title: 'worker' },
    ],
    read: async () => prefs,
    update: async mutate => { Object.assign(prefs, mutate(prefs) ?? {}); return prefs },
  }
  return { d, prefs }
}

describe('session-notify door', () => {
  test('mutes by the conversation key, so it survives a reopen', async () => {
    const { d, prefs } = deps()
    const out = await notifyOp({ ref: 'leader', notify: 'off' }, d)
    expect(out.ok).toBe(true)
    expect(prefs.mutedSessions).toEqual(['conv-a'])
  })
  test('falls back to the managed id when no conversation is linked', async () => {
    const { d, prefs } = deps()
    await notifyOp({ ref: 'agentop-bbb', notify: 'off' }, d)
    expect(prefs.mutedSessions).toEqual(['agentop-bbb'])
  })
  test('unmuting removes it; a bare ref reads', async () => {
    const { d, prefs } = deps(['conv-a'])
    const read = await notifyOp({ ref: 'leader' }, d)
    expect(read.ok && read.notify).toBe('off')
    await notifyOp({ ref: 'leader', notify: 'on' }, d)
    expect(prefs.mutedSessions).toEqual([])
    const again = await notifyOp({ ref: 'leader' }, d)
    expect(again.ok && again.notify).toBe('on')
  })
  test('refuses what it cannot resolve or understand, writing nothing', async () => {
    const { d, prefs } = deps()
    const none = await notifyOp({ ref: 'ghost', notify: 'off' }, d)
    expect(none.ok).toBe(false)
    expect(notifyStatus(none)).toBe(404)
    const bad = await notifyOp({ ref: 'leader', notify: 'maybe' as 'on' }, d)
    expect(notifyStatus(bad)).toBe(400)
    expect(notifyStatus(await notifyOp({ ref: '' }, d))).toBe(400)
    expect(prefs.mutedSessions).toEqual([])
  })
})

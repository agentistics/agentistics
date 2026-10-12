import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import * as preferences from '../preferences'
import * as roles from '../sessions/session-roles'
import * as desktop from './desktop'
import * as peer from './peer-client'
import * as mobile from './mobile-push'
import { deliver } from './notifier'
import type { SessionEvent } from './event-types'

const event = (id: string, kind: SessionEvent['kind'] = 'waiting-approval'): SessionEvent => ({
  v: 1, seq: 1, at: '2026-10-12T12:00:00.000Z', source: 'poll', kind,
  id, conversationId: `conversation-${id}`, label: id, cwd: '/tmp/project',
})
const subscriptions = [{
  id: 'all', createdAt: '', kinds: ['waiting-approval', 'exited'] as SessionEvent['kind'][],
  notify: 'test-peer', desktop: true,
}]

const restores: Array<() => void> = []
afterEach(() => { for (const restore of restores.splice(0)) restore() })

describe('worker mute across delivery channels', () => {
  for (const muteWorkers of [false, true]) {
    test(`desktop, peer and push ${muteWorkers ? 'exclude active workers' : 'include workers with the toggle off'}`, async () => {
      const prefs = spyOn(preferences, 'readPreferences').mockResolvedValue({ ui: { muteWorkers } })
      const roleStore = spyOn(roles, 'readRolesDoc').mockResolvedValue({ version: 1, migrated: true, roles: {
        'conversation-worker': 'worker',
        // The conversation's leader role takes priority over the managed id's worker role.
        'conversation-leader': 'leader', leader: 'worker',
      } })
      const mobileStore = spyOn(mobile, 'readMobileSubscriptions').mockResolvedValue([{
        id: 'phone', endpoint: 'https://push.example/test', keys: { p256dh: 'test', auth: 'test' },
        kind: 'mobile', enabled: true, createdAt: '',
      }])
      const toast = spyOn(desktop, 'notifyDesktop').mockResolvedValue({ ok: true, channel: 'notify-send' })
      const message = spyOn(peer, 'sendToPeer').mockResolvedValue({ ok: true, pid: 123, name: 'test-peer' })
      // Keep sendMobilePush real: observe the transport after its own mute-key filtering.
      const push = spyOn(mobile, 'webPushTransport').mockResolvedValue(undefined)
      for (const spy of [prefs, roleStore, mobileStore, toast, message, push]) restores.push(() => spy.mockRestore())

      const events = [event('worker'), event('leader'), event('untyped')]
      const report = await deliver({ events, subscriptions })
      const wanted = muteWorkers ? events.slice(1) : events
      expect(toast.mock.calls.map(([text]) => text.title)).toEqual(wanted.map(e => e.id))
      expect(report.toastsShown).toBe(wanted.length)
      expect(message).toHaveBeenCalledTimes(1)
      const body = message.mock.calls[0]![1]
      expect(body.includes('session "worker"')).toBe(!muteWorkers)
      expect(body).toContain('session "leader"')
      expect(body).toContain('session "untyped"')
      expect(push.mock.calls.map(([, payload]) => payload.sessionId)).toEqual(wanted.map(e => e.id))
      expect(report.lines).toContain(`mobile: ${wanted.length} notifications`)

      if (muteWorkers) {
        toast.mockClear(); message.mockClear(); push.mockClear()
        const quiet = await deliver({ events: [event('worker')], subscriptions })
        expect(toast).not.toHaveBeenCalled()
        expect(message).not.toHaveBeenCalled()
        expect(push).not.toHaveBeenCalled()
        expect(quiet.lines).toEqual([])

        const exited = await deliver({ events: [event('worker', 'exited')], subscriptions })
        expect(exited.toastsShown).toBe(1)
        expect(message).toHaveBeenCalledTimes(1)
        // Mobile only sends waiting/approval events, regardless of worker mute.
        expect(push).not.toHaveBeenCalled()
      }
    })
  }
})

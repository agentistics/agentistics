import { beforeEach, describe, expect, it } from 'bun:test'
import { alertKey, type NayAlert } from './nayNotify'
import {
  dismissAlert, observeFleet, pushAlert, readNayAlerts, releaseDue, resetNayNotifyStore, setOpenSession, snoozeAlert,
  waitingSince,
} from './nayNotifyStore'

const alert = (sessionId: string, kind: NayAlert['kind'] = 'turn', sinceMs = 1000): NayAlert => ({
  key: alertKey(kind, sessionId, sinceMs), kind, sessionId, name: sessionId, sinceMs, sinceKnown: true,
})

beforeEach(() => resetNayNotifyStore())

describe('the queue of cards', () => {
  it('holds ONE card per session — a newer one replaces the older', () => {
    pushAlert(alert('a', 'turn', 1))
    pushAlert(alert('a', 'approval', 2))
    pushAlert(alert('b'))
    expect(readNayAlerts().map(a => `${a.sessionId}:${a.kind}`)).toEqual(['a:approval', 'b:turn'])
  })

  it('never shows a card about the session that is open on screen', () => {
    setOpenSession('a')
    expect(pushAlert(alert('a'))).toBe(false)
    expect(readNayAlerts()).toHaveLength(0)
  })

  it('opening a session takes its card away', () => {
    pushAlert(alert('a'))
    setOpenSession('a')
    expect(readNayAlerts()).toHaveLength(0)
  })

  it('dismisses by key', () => {
    pushAlert(alert('a'))
    dismissAlert(alert('a').key)
    expect(readNayAlerts()).toHaveLength(0)
  })
})

describe('what the fleet says', () => {
  it('starts each waiting clock on the poll that first saw it, and says whether it saw the start', () => {
    observeFleet([{ id: 'a', state: 'working' }, { id: 'b', state: 'waiting' }], 0, 100)
    observeFleet([{ id: 'a', state: 'waiting' }, { id: 'b', state: 'waiting' }], 0, 200)
    expect(waitingSince('a')).toEqual({ sinceMs: 200, known: true })
    // b was ALREADY waiting when the page first looked: its clock is the first sighting, flagged.
    expect(waitingSince('b')).toEqual({ sinceMs: 100, known: false })
  })

  it('treats waiting and waiting-approval as ONE episode', () => {
    observeFleet([{ id: 'a', state: 'working' }], 0, 100)
    observeFleet([{ id: 'a', state: 'waiting' }], 0, 200)
    observeFleet([{ id: 'a', state: 'waiting-approval' }], 0, 300)
    expect(waitingSince('a')?.sinceMs).toBe(200)
  })

  it('raises "not opened" ONCE per episode, and again for the next one', () => {
    const min = 60_000
    observeFleet([{ id: 'a', state: 'working' }], 1, 0)
    observeFleet([{ id: 'a', state: 'waiting' }], 1, 10)
    expect(observeFleet([{ id: 'a', state: 'waiting' }], 1, 10 + min).map(c => c.id)).toEqual(['a'])
    expect(observeFleet([{ id: 'a', state: 'waiting' }], 1, 10 + 5 * min)).toEqual([])
    observeFleet([{ id: 'a', state: 'working' }], 1, 10 + 6 * min)
    observeFleet([{ id: 'a', state: 'waiting' }], 1, 10 + 7 * min)
    expect(observeFleet([{ id: 'a', state: 'waiting' }], 1, 10 + 8 * min).map(c => c.id)).toEqual(['a'])
  })

  it('drops a card that stopped being true — answered somewhere else', () => {
    observeFleet([{ id: 'a', state: 'waiting-approval' }], 0, 0)
    pushAlert(alert('a', 'approval'))
    observeFleet([{ id: 'a', state: 'working' }], 0, 10)
    expect(readNayAlerts()).toHaveLength(0)
  })
})

describe('the settings demo', () => {
  it('is not dropped by a fleet that has never heard of it', () => {
    pushAlert({ ...alert('demo'), demo: true })
    observeFleet([{ id: 'a', state: 'working' }], 0, 10)
    expect(readNayAlerts()).toHaveLength(1)
  })
})

describe('a snooze', () => {
  it('takes the card away and brings it back when due, if it is still true', async () => {
    observeFleet([{ id: 'a', state: 'waiting' }], 0, 0)
    pushAlert(alert('a'), 0)
    snoozeAlert(alert('a').key, 15 * 60_000, 0)
    expect(readNayAlerts()).toHaveLength(0)
    // Refused while snoozed, from any source.
    expect(pushAlert(alert('a', 'turn', 5), 60_000)).toBe(false)
    releaseDue(10 * 60_000)
    await Promise.resolve()
    expect(readNayAlerts()).toHaveLength(0)
    releaseDue(15 * 60_000)
    await Promise.resolve()
    expect(readNayAlerts().map(a => a.sessionId)).toEqual(['a'])
  })

  it('does not come back for a session that was answered meanwhile', async () => {
    observeFleet([{ id: 'a', state: 'waiting' }], 0, 0)
    pushAlert(alert('a'), 0)
    snoozeAlert(alert('a').key, 60_000, 0)
    observeFleet([{ id: 'a', state: 'working' }], 0, 30_000)
    releaseDue(60_000)
    await Promise.resolve()
    expect(readNayAlerts()).toHaveLength(0)
  })
})

import { describe, expect, test } from 'bun:test'
import { DEFAULT_NOTIFICATION_SETTINGS, readNotificationSettings, resolveSound } from './sessionNotifications'
import { DEFAULT_NAY_ANIMATION } from './nayNotify'
import { DEFAULT_NAY_FAB_PREFS, cardStyleOf, dockStyleOf, parseNayFabPrefs } from './nayFab'

describe('shipped defaults (owner, 2026-09-30) — what an ABSENT preference reads as', () => {
  test('drag = elastic trail; window and card follow "same as the button"', () => {
    const p = parseNayFabPrefs(null)
    expect(p.style).toBe('trail')
    expect(DEFAULT_NAY_FAB_PREFS.style).toBe('trail')
    expect(dockStyleOf(p)).toBe('trail')
    expect(cardStyleOf(p)).toBe('trail')
  })
  test('the card appears with Arremesso', () => { expect(DEFAULT_NAY_ANIMATION).toBe('launch') })
  test('sounds: Nay = Nay chama, needs you = Tríade, not opened = Brisa, approval unchanged', () => {
    const s = readNotificationSettings({})
    expect(s.eventSounds.nay).toBe('nay')
    expect(s.eventSounds.waiting).toBe('triad')
    expect(s.eventSounds.stale).toBe('breeze')
    expect(s.eventSounds['waiting-approval']).toBe('question')
  })
  test('a stored choice is kept, and an old document gains the Nay sound', () => {
    const s = readNotificationSettings({ eventSounds: { waiting: 'glass', 'waiting-approval': 'alert' } })
    expect(s.eventSounds.waiting).toBe('glass')
    expect(s.eventSounds['waiting-approval']).toBe('alert')
    expect(s.eventSounds.nay).toBe('nay')
  })
})

describe('sound routing', () => {
  const settings = { eventSounds: { ...DEFAULT_NOTIFICATION_SETTINGS.eventSounds, waiting: 'kalimba' as const, nay: 'harp' as const } }
  test('a Nay conversation always rings the Nay sound, whatever happened', () => {
    for (const ev of ['waiting', 'waiting-approval', 'stale', 'exited'] as const) expect(resolveSound(ev, true, settings)).toBe('harp')
  })
  test('other sessions ring their own event sound', () => {
    expect(resolveSound('waiting', false, settings)).toBe('kalimba')
    expect(resolveSound('waiting-approval', false, settings)).toBe('question')
  })
})

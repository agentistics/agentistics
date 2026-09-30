import { describe, expect, it } from 'bun:test'
import {
  alertStillTrue, cardPlacement, cardWidth, formatSpan, formatWaiting, NAY_ANIMATIONS, parseNayAnimation, parseSnooze,
  snoozeError, SNOOZE_PRESETS, staleDue, STALE_OPTIONS_MIN,
} from './nayNotify'

describe('the snooze a person types', () => {
  const ms = (s: string) => { const r = parseSnooze(s); return r.ok ? r.ms : r.reason }

  it('reads minutes and hours in the shapes people write them', () => {
    expect(ms('30')).toBe(30 * 60_000)
    expect(ms('30m')).toBe(30 * 60_000)
    expect(ms('30 min')).toBe(30 * 60_000)
    expect(ms('2h')).toBe(2 * 3_600_000)
    expect(ms('2 H')).toBe(2 * 3_600_000)
    expect(ms('1,5h')).toBe(90 * 60_000)
    expect(ms('1.5h')).toBe(90 * 60_000)
    expect(ms('1h30')).toBe(90 * 60_000)
    expect(ms('1h 30min')).toBe(90 * 60_000)
  })

  it('says WHY it refuses, one reason each', () => {
    expect(ms('')).toBe('empty')
    expect(ms('   ')).toBe('empty')
    expect(ms('amanhã')).toBe('format')
    expect(ms('2d')).toBe('format')
    expect(ms('-5m')).toBe('format')
    expect(ms('0')).toBe('range')
    expect(ms('25h')).toBe('range')
    expect(ms('24h')).toBe(24 * 3_600_000)
    for (const r of ['empty', 'format', 'range'] as const) {
      expect(snoozeError(r, 'pt').length).toBeGreaterThan(0)
      expect(snoozeError(r, 'en')).not.toBe(snoozeError(r, 'pt'))
    }
  })

  it('offers exactly the two presets the owner asked for, beside "enter a time"', () => {
    expect(SNOOZE_PRESETS.map(p => p.ms)).toEqual([15 * 60_000, 3_600_000])
  })

  it('says a span back the way it was meant', () => {
    expect(formatSpan(15 * 60_000)).toBe('15 min')
    expect(formatSpan(3_600_000)).toBe('1 h')
    expect(formatSpan(90 * 60_000)).toBe('1 h 30 min')
  })
})

describe('how long a session has waited', () => {
  const now = 1_000_000_000
  it('says "at least" when the page did not see the wait begin', () => {
    expect(formatWaiting(now - 3 * 60_000, now, true, 'pt')).toBe('há 3 min')
    expect(formatWaiting(now - 3 * 60_000, now, false, 'pt')).toBe('há pelo menos 3 min')
    expect(formatWaiting(now - 130 * 60_000, now, true, 'en')).toBe('2 h 10 min ago')
    expect(formatWaiting(now - 10_000, now, true, 'pt')).toBe('agora')
  })
})

describe('"not opened for a while"', () => {
  const base = { sinceMs: 0, nowMs: 61 * 60_000, thresholdMin: 60 }
  it('is due once a WAITING session crosses the line', () => {
    expect(staleDue({ ...base, state: 'waiting' })).toBe(true)
    expect(staleDue({ ...base, state: 'waiting-approval' })).toBe(true)
  })
  it('never for a session that is busy, gone or whose threshold is "never"', () => {
    expect(staleDue({ ...base, state: 'working' })).toBe(false)
    expect(staleDue({ ...base, state: 'exited' })).toBe(false)
    expect(staleDue({ ...base, state: 'waiting', thresholdMin: 0 })).toBe(false)
  })
  it('counts from the LATER of the wait and the last time somebody opened it', () => {
    expect(staleDue({ ...base, state: 'waiting', lastOpenedMs: 30 * 60_000 })).toBe(false)
    expect(staleDue({ ...base, state: 'waiting', lastOpenedMs: 30 * 60_000, nowMs: 91 * 60_000 })).toBe(true)
  })
  it('offers "never" among its thresholds', () => {
    expect(STALE_OPTIONS_MIN).toContain(0)
  })
})

describe('a card that is no longer true goes away', () => {
  it('an approval card lasts only while the dialog is open', () => {
    expect(alertStillTrue('approval', 'waiting-approval')).toBe(true)
    expect(alertStillTrue('approval', 'waiting')).toBe(false)
  })
  it('the others last while the session waits on a person in any way', () => {
    expect(alertStillTrue('turn', 'waiting')).toBe(true)
    expect(alertStillTrue('stale', 'waiting-approval')).toBe(true)
    expect(alertStillTrue('turn', 'working')).toBe(false)
    expect(alertStillTrue('turn', undefined)).toBe(false)
  })
})

describe('the animation choice', () => {
  it('defaults to Launch, the one the owner picked, and refuses anything else', () => {
    expect(NAY_ANIMATIONS[0]).toBe('launch')
    expect(parseNayAnimation(undefined)).toBe('launch')
    expect(parseNayAnimation('cartwheel')).toBe('launch')
    expect(parseNayAnimation('voice')).toBe('voice')
  })
})

describe('where the card opens', () => {
  const vp = { vpW: 1440, vpH: 900, cardW: 360, cardH: 280, bottomInset: 0 }

  it('stands ABOVE a button in the lower half, aligned to its side, and points at it', () => {
    const p = cardPlacement({ ...vp, fab: { x: 1360, y: 820, w: 56, h: 56 } })
    expect(p.top + 280).toBeLessThanOrEqual(820)
    expect(p.left + 360).toBe(1416)
    expect(p.tailSide).toBe('bottom')
    expect(p.originX).toBe(1388 - p.left)
  })

  it('stands BELOW a button in the upper half', () => {
    const p = cardPlacement({ ...vp, fab: { x: 20, y: 40, w: 56, h: 56 } })
    expect(p.top).toBeGreaterThanOrEqual(96)
    expect(p.left).toBe(20)
    expect(p.tailSide).toBe('top')
  })

  it('never runs off the screen or into the phone\'s bottom bar', () => {
    const phone = { vpW: 390, vpH: 780, cardW: cardWidth(390, true), cardH: 300, bottomInset: 72 }
    const p = cardPlacement({ ...phone, fab: { x: 316, y: 640, w: 56, h: 56 } })
    expect(p.left).toBeGreaterThanOrEqual(12)
    expect(p.left + phone.cardW).toBeLessThanOrEqual(378)
    expect(p.top + 300).toBeLessThanOrEqual(780 - 72)
  })

  it('with no button on screen, opens from the corner the button would have held', () => {
    const p = cardPlacement({ ...vp, fab: null })
    expect(p.left + 360).toBeGreaterThan(1300)
    expect(p.tailSide).toBe('bottom')
  })

  it('fills the phone width minus its gutters', () => {
    expect(cardWidth(390, true)).toBe(366)
    expect(cardWidth(1440, false)).toBe(360)
  })
})

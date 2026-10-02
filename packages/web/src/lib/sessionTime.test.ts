import { describe, expect, test } from 'bun:test'
import { sessionOpened, sessionTime } from './sessionTime'

const s = (wall: number, active?: number) => ({ duration_minutes: wall, active_minutes: active })

describe('sessionTime', () => {
  test('both figures are NAMED — a bare headline next to a labelled one is unreadable', () => {
    const t = sessionTime(s(6345, 5253), 'pt')
    expect(t.active).toBe('87h 33m')
    expect(t.elapsed).toBe('105h 45m')
    expect(t.activeLabel).toBe('ativo')
    expect(t.elapsedLabel).toBe('decorrido')
    expect(t.combined).toBe('87h 33m ativo · 105h 45m decorrido')
  })

  test('each figure carries a plain-language explanation for the card face', () => {
    const t = sessionTime(s(100, 40), 'pt')
    expect(t.activeExplain).toContain('turno')
    // Must say EVENT, not message: the first event is often an attachment minutes before the
    // first message, so calling it "first message" would be a false statement.
    expect(t.elapsedExplain).toContain('evento')
    expect(t.elapsedExplain).not.toContain('mensagem')
  })

  test('the English side makes the same distinction', () => {
    const t = sessionTime(s(100, 40), 'en')
    expect(t.elapsedExplain).toContain('event')
    expect(t.elapsedExplain).not.toContain('message')
  })

  test('a session with no measured active time says so instead of showing 0', () => {
    const t = sessionTime(s(57492, undefined), 'pt')
    expect(t.active).toBeNull()
    expect(t.combined).toBe('958h 12m decorrido')
    expect(t.tooltip).toContain('não está mais disponível')
  })

  test('the tooltip discloses that a turn spent waiting on the user still counts', () => {
    const t = sessionTime(s(6345, 5253), 'pt')
    expect(t.tooltip).toContain('esperando você')
  })
})

describe('sessionOpened', () => {
  test('formats the first turn the harness recorded, in each language', () => {
    expect(sessionOpened('2026-10-01T15:31:59.963', 'pt')).toBe('01/10/2026 15:31')
    expect(sessionOpened('2026-10-01T15:31:59.963', 'en')).toBe('Oct 1, 2026 15:31')
  })

  test('is null — not a dash, not a throw — for a record with no usable start', () => {
    expect(sessionOpened(undefined, 'pt')).toBeNull()
    expect(sessionOpened('', 'pt')).toBeNull()
    expect(sessionOpened('not a date', 'en')).toBeNull()
  })
})

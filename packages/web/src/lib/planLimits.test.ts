import { expect, test } from 'bun:test'
import { fmtSpan, forecastPhrase, limitNoticeMeta, limitNoticeText, limitTone, resetPhrase } from './planLimits'

const M = 60_000
test('spans', () => {
  expect(fmtSpan(12 * M, 'pt')).toBe('12 min')
  expect(fmtSpan(125 * M, 'pt')).toBe('2 h 05')
  expect(fmtSpan(50 * 60 * M, 'en')).toBe('2 d 2 h')
})
test('a renewed window says so instead of a zero', () => {
  expect(resetPhrase({ kind: '5h', usedPct: 80, resetsAt: 1000 }, 2000, 'pt')).toContain('renovado')
})
test('forecast words', () => {
  expect(forecastPhrase({ kind: 'lasts' }, 0, 'pt')).toBe('dura até depois da renovação')
  expect(forecastPhrase({ kind: 'runs-out', at: Date.parse('2026-10-09T15:30:00') }, Date.parse('2026-10-09T12:00:00'), 'pt')).toMatch(/^acaba ~15:30$/)
})
test('tone follows the notice thresholds', () => {
  expect(limitTone(10)).toBe('var(--accent-green)')
  expect(limitTone(80)).toBe('var(--anthropic-orange)')
  expect(limitTone(96)).toBe('var(--accent-red)')
})
test('notice meta round trip and text', () => {
  const now = Date.parse('2026-10-09T12:00:00')
  const meta = { harness: 'claude', window: '5h', threshold: 100, pct: 100, resetsAt: now + 90 * M, alt: 'codex' }
  const m = limitNoticeMeta(meta)!
  expect(m.alt).toBe('codex')
  const t = limitNoticeText(m, 'pt', now)
  expect(t.title).toBe('Claude Code: janela de 5 h esgotada')
  expect(t.message).toContain('em 1 h 30')
  expect(t.message).toContain('Codex')
  expect(limitNoticeText({ ...m, threshold: 85, pct: 86 }, 'en', now).title).toBe('Claude Code: 85% of the 5-hour window')
  expect(limitNoticeMeta({ harness: 'claude' })).toBeNull()
})

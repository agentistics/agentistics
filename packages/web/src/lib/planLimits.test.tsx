import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { LimitLevelIcon } from '../components/PlanLimitMeter'
import { limitLevel, limitLevelWord, subscriptionName, subscriptionRows, fmtSpan, forecastPhrase, limitNoticeMeta, limitNoticeText, limitTone, resetPhrase, windowLabel, windowShortLabel } from './planLimits'

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
test('window labels are explicit and short labels are mobile-only', () => {
  expect(windowLabel('5h', 'pt')).toBe('Sessão 5 h')
  expect(windowLabel('week', 'pt')).toBe('Semana')
  expect(windowLabel('5h', 'en')).toBe('5-h session')
  expect(windowShortLabel('5h', 'pt')).toBe('5 h')
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

test('level thresholds: nothing at 74, triangle at 75, octagon at 95', () => {
  expect([74, 75, 94, 95].map(p => limitLevel(p))).toEqual(['ok', 'attention', 'attention', 'critical'])
  expect(limitLevel(null)).toBe('ok')
  const html = (p: number) => renderToStaticMarkup(<LimitLevelIcon pct={p} />)
  expect(html(74)).toBe('')
  expect(html(75)).toContain('<polygon points="10,1 19,18 1,18"')
  expect(html(94)).toContain('<polygon points="10,1 19,18 1,18"')
  expect(html(95)).toContain('points="6,1 14,1')
})
test('the level in words: critical is never said as attention', () => {
  expect(limitLevelWord('critical', 'pt')).toBe('quase no fim')
  expect(limitLevelWord('attention', 'pt')).toBe('atenção')
  expect(limitLevelWord('critical', 'en')).toBe('almost exhausted')
})
test('a registered plan with no reading is a row with no limits (no ring, no zero)', () => {
  const reading = { harness: 'claude', account: 'a', plan: 'Max 5x', source: 'stream', updatedAt: 1, windows: [{ kind: '5h', usedPct: 10, resetsAt: 9e12 }] } as never
  const rows = subscriptionRows([reading], [{ harness: 'claude', plan: 'Max 5x' }, { harness: 'gemini', plan: 'Pro' }])
  expect(rows.map(r => [r.harness, r.limits === null])).toEqual([['claude', false], ['gemini', true]])
  expect(subscriptionRows(null, [{ harness: 'codex', plan: 'Plus' }])[0]!.limits).toBeNull()
})
test('an account label that is only the assistant name is not appended to it', () => {
  const rd = (account: string) => ({ harness: 'codex', account, plan: 'Plus', source: 'codex-rollout', updatedAt: 1, windows: [{ kind: '5h', usedPct: 10, resetsAt: 9e12 }] }) as never
  const rows = subscriptionRows([rd('default')], [{ harness: 'codex', account: 'acc_1', plan: 'Plus' }], { default: 'Codex CLI', acc_1: 'Codex CLI #1' })
  expect(rows.map(r => r.accountLabel)).toEqual([undefined, 'Codex CLI #1'])
  expect(rows.map(r => subscriptionName(r.harness, r.accountLabel))).toEqual(['Codex CLI', 'Codex CLI #1'])
  expect(subscriptionName('claude', 'Work')).toBe('Claude Code · Work')
})
test('two accounts of one harness are two rows, each named; a single account stays unlabelled', () => {
  const rd = (account: string) => ({ harness: 'claude', account, plan: 'Max', source: 'stream', updatedAt: 1, windows: [{ kind: '5h', usedPct: 10, resetsAt: 9e12 }] }) as never
  const labels = { a: 'Work', b: 'Claude Code #2' }
  expect(subscriptionRows([rd('a'), rd('b')], [], labels).map(r => r.accountLabel)).toEqual(['Work', 'Claude Code #2'])
  expect(subscriptionRows([rd('a')], [], labels)[0]!.accountLabel).toBeUndefined()
  // A registered plan of an account that has a reading is not listed twice; one without is.
  expect(subscriptionRows([rd('a')], [{ harness: 'claude', account: 'a', plan: 'Max' }, { harness: 'claude', account: 'b', plan: 'Max' }], labels)).toHaveLength(2)
})

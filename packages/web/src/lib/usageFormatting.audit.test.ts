import { expect, test } from 'bun:test'
import { fmtSpan, fmtWhen, resetPhrase, forecastPhrase } from './planLimits'

for (const lang of ['pt', 'en'] as const) {
  for (const [ms, result] of [[-1, '0 min'], [29_000, '0 min'], [30_000, '1 min'], [3_600_000, '1 h'], [3_660_000, '1 h 1 min'], [49 * 3_600_000, '2 d 1 h']] as const) {
    test(`duration ${ms} in ${lang}`, () => expect(fmtSpan(ms, lang)).toBe(result))
  }
  test(`renewal at the boundary is renewed, ${lang}`, () => {
    const now = Date.parse('2026-10-25T12:00:00Z')
    expect(resetPhrase({ kind: '5h', usedPct: 99, resetsAt: now }, now, lang)).toContain(lang === 'pt' ? 'renovado' : 'renewed')
    expect(forecastPhrase({ kind: 'runs-out', at: now + 3_600_000 }, now, lang)).toContain(fmtWhen(now + 3_600_000, now, lang))
  })
}

test('calendar labels follow local dates across DST while elapsed durations stay absolute', () => {
  const before = process.env.TZ
  try {
    process.env.TZ = 'America/New_York'
    const now = Date.parse('2026-11-01T05:30:00Z')
    const after = now + 3_600_000
    expect(fmtSpan(after - now, 'en')).toBe('1 h')
    expect(fmtWhen(after, now, 'en')).toBe(fmtWhen(now, now, 'en')) // repeated 01:30
    expect(fmtWhen(after + 86_400_000, now, 'en')).toContain('Mon')
  } finally {
    if (before === undefined) delete process.env.TZ
    else process.env.TZ = before
  }
})

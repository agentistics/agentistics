import { expect, test } from 'bun:test'
import { validComposerTask } from './composerTask'
import { awayBriefingLines, type AwayState } from './awayMode'

test('task options require an explicit priority and real optional ISO date', () => {
  for (const priority of ['urgent', 'high', 'medium', 'low']) expect(validComposerTask({ priority })).toBe(true)
  for (const value of [null, true, {}, { priority: 'none' }, { priority: 'medium', dueDate: '2026-02-31' }, { priority: 'medium', dueDate: 'tomorrow' }]) expect(validComposerTask(value)).toBe(false)
  expect(validComposerTask({ priority: 'medium', dueDate: '2028-02-29' })).toBe(true)
})

test('autonomous registration paragraph appears once, for active leaders only, in both languages', () => {
  const state = { on: true, until: null, authorised: ['workers'], maxWorkers: 1, topCaps: {}, note: '' } as AwayState
  for (const lang of ['pt', 'en'] as const) {
    const text = awayBriefingLines(state, 'leader', Date.now(), { lang }).join('\n')
    const marker = lang === 'pt' ? 'Registro autônomo:' : 'Autonomous registration:'
    expect(text.split(marker)).toHaveLength(2)
    expect(text).toContain('in_progress → in_review')
    expect(text).toContain('Benchmark')
    expect(awayBriefingLines(state, 'worker', Date.now(), { lang }).join('\n')).not.toContain(marker)
    expect(awayBriefingLines({ ...state, on: false }, 'leader', Date.now(), { lang })).toEqual([])
  }
})

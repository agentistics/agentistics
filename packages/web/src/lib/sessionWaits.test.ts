import { expect, test } from 'bun:test'
import { parseWaitLines, waitLineText } from './sessionWaits'

test('parseWaitLines keeps well-formed lines by owner and drops the rest', () => {
  const m = parseWaitLines({ waits: [{ sessionId: 'L1', waitId: 'w-1', describe: 'handback de W', deadlineAt: '2030-01-01T10:00:00Z' }, { sessionId: 3 }, null] })
  expect([...m.keys()]).toEqual(['L1'])
  expect(parseWaitLines(null).size).toBe(0)
})

test('waitLineText says "aguardando X até Y", with the date only when it is not today', () => {
  const now = new Date('2030-01-01T08:00:00')
  const today = { sessionId: 'L1', waitId: 'w', describe: 'handback de W', deadlineAt: new Date('2030-01-01T14:30:00').toISOString() }
  expect(waitLineText(today, 'pt', now)).toMatch(/^aguardando handback de W até 14:30$/)
  expect(waitLineText(today, 'en', now)).toMatch(/^waiting for handback de W until /)
  const later = { ...today, deadlineAt: new Date('2030-01-03T14:30:00').toISOString() }
  expect(waitLineText(later, 'pt', now)).toContain('03/01')
})

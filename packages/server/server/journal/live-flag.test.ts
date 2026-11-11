import { test, expect } from 'bun:test'
import { journalLiveEnabled } from './live-flag'

test('live journal feeds every install by default, with explicit off and journal master gate', () => {
  for (const raw of [undefined, '', '1', 'true', 'yes', 'on']) expect(journalLiveEnabled(true, raw)).toBe(true)
  for (const raw of ['0', 'false', ' OFF ', 'no']) expect(journalLiveEnabled(true, raw)).toBe(false)
  expect(journalLiveEnabled(false, '1')).toBe(false)
})

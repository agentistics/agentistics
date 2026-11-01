import { expect, test } from 'bun:test'
import { recordChipMode } from './chip-mode-record'
import { inheritedLaunch } from './reopen-inherit'
import type { ManagedSession } from './types'

test('the chip mode is written to the row, so a reopen inherits it', async () => {
  const row = { id: 'a', harness: 'opencode', cwd: '/tmp', mode: 'default' } as unknown as ManagedSession
  await recordChipMode('a', { modeOf: () => ({ canonical: 'accept-edits' }) }, async (_id, p) => { Object.assign(row, p); return true })
  expect(row.mode).toBe('accept-edits')
  expect(inheritedLaunch(row, 'opencode').mode).toBe('accept-edits')
})

test('no-questions is restored the same way', async () => {
  const row = { id: 'a', harness: 'opencode', cwd: '/tmp' } as unknown as ManagedSession
  await recordChipMode('a', { modeOf: () => ({ canonical: 'no-questions' }) }, async (_id, p) => { Object.assign(row, p); return true })
  expect(inheritedLaunch(row, 'opencode').mode).toBe('no-questions')
})

test('a mode with no canonical twin leaves the row alone', async () => {
  let called = false
  await recordChipMode('a', { modeOf: () => ({}) }, async () => { called = true; return true })
  expect(called).toBe(false)
})

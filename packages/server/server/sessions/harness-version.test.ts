import { expect, test } from 'bun:test'
import { readHarnessVersion } from './harness-version'

test('a binary that is not on PATH reads as no version and never throws', async () => {
  expect(await readHarnessVersion('definitely-not-a-real-binary-xyz', 1)).toBeUndefined()
})

test('a real binary that prints a version is parsed, and the answer is cached briefly', async () => {
  const first = await readHarnessVersion('bun', 10)
  expect(first).toMatch(/^\d+\.\d+/)
  expect(await readHarnessVersion('bun', 20)).toBe(first)
})

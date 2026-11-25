import { expect, test } from 'bun:test'
import { RELEASES } from './releases'

test('2.228.1 announces the Mac vault setup fix in both languages', () => {
  const r = RELEASES['2.228.1']
  expect(r).toBeDefined()
  expect(r!.fixes.length).toBeGreaterThan(0)
  for (const l of r!.fixes) { expect(l.pt).toContain('Mac'); expect(l.en).toContain('Mac') }
})

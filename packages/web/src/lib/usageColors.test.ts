import { expect, test } from 'bun:test'
import { usageColors } from './usageColors'

test('unique account colors are deterministic across input order and repeated identities', () => {
  const ids = ['codex:principal', 'claude:nayara', 'claude:work', 'gemini:default']
  const forward = usageColors(ids), reverse = usageColors([...ids].reverse())
  expect(new Set(forward.values()).size).toBe(ids.length)
  for (const id of ids) expect(forward.get(id)).toBe(reverse.get(id))
  expect(usageColors([...ids, ids[0]!])).toEqual(forward)
})

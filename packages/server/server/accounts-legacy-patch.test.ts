import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

// The legacy PATCH /api/accounts/:harness/:key must go through the manual-override path.
test('legacy availability route toggles through toggleAccountAgentUse for accounts with an id', () => {
  const src = readFileSync(new URL('./accounts-web.ts', import.meta.url), 'utf8')
  const legacy = src.slice(src.indexOf('/^\\/api\\/accounts\\/([^/]+)\\/([^/]+)$/'))
  expect(legacy).toContain('toggleAccountAgentUse(found.id, desired)')
})

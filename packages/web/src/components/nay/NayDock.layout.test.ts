import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Match the source layout contracts used by NayNotifyCard.layout.test.ts;
// real 390px/400px screenshots remain part of independent live QA.
const source = readFileSync(join(import.meta.dir, 'NayDock.tsx'), 'utf8')
test('Nay tabs get a full wrapping row and 44px targets without clipped labels', () => {
  const tabs = source.slice(source.indexOf('<div role="tablist"'), source.indexOf('<DockSettings pt='))
  expect(tabs).toContain("flex: '1 1 100%'")
  expect(tabs).toContain("flexWrap: 'wrap'")
  expect(tabs).toContain("flex: '1 0 auto'")
  expect(tabs).toContain('minWidth: 44')
  expect(tabs).toContain('minHeight: 44')
  expect(tabs).toContain("whiteSpace: 'normal'")
  expect(tabs).not.toContain('ellipsis')
  expect(tabs).toContain("pt ? 'Sessões' : 'Sessions'")
  expect(tabs).toContain("pt ? 'Limites' : 'Limits'")
})

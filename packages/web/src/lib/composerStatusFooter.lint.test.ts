import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const css = readFileSync(join(import.meta.dir, '..', 'index.css'), 'utf8')

test('390px footer: the character count is never clipped, the left group (model, mode) gives way instead', () => {
  const rules = [...css.matchAll(/\.ag-composer-status-count\s*\{([^}]*)\}/g)].map(m => m[1]!)
  expect(rules.length).toBeGreaterThan(0)
  for (const body of rules) {
    expect(body).not.toMatch(/max-width/)
    expect(body).not.toMatch(/text-overflow:\s*ellipsis/)
  }
  expect(css).toMatch(/\.ag-composer-status-right\s*\{\s*flex-shrink:\s*0;?\s*\}/)
  expect(css).toMatch(/\.ag-composer-status-left\s*\{[^}]*overflow:\s*hidden/)
})

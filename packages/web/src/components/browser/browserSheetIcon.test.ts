/**
 * F7 of the S10 QA: the area sheet's "Navegador" entry wears the SAME globe+magnifier as the rail and the
 * header, never the plain globe (which is the language row's). A source check, like the repo's other lints:
 * App.tsx is not renderable in a unit test.
 */
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

test('the sheet entry for the browser uses GlobeSearchIcon', () => {
  const src = readFileSync(join(import.meta.dir, '../../App.tsx'), 'utf8')
  const line = src.split('\n').find(l => l.includes("key: 'browser'"))
  expect(line).toBeDefined()
  expect(line).toContain('icon: GlobeSearchIcon')
  expect(line).not.toContain('icon: Globe,')
})

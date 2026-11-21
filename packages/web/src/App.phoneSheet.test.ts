/**
 * The phone area sheet's action list lives inline in App.tsx (no jsdom here, so it cannot be clicked).
 * The 2.222.0 junction merged two additions into the same list — "Uso dos planos" (main) and
 * "Navegador" (the browser lot) — and a junction QA mutant that dropped the browser entry left every
 * suite green. These source-level checks guard both entries and their order.
 */
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = readFileSync(join(import.meta.dir, 'App.tsx'), 'utf8')

const entry = (key: string): number => src.indexOf(`{ key: '${key}', label:`)

test('the phone sheet lists "Uso dos planos" and opens the plan usage popup', () => {
  const at = entry('plan-usage')
  expect(at).toBeGreaterThan(-1)
  expect(src.slice(at, src.indexOf('\n', at))).toContain('onClick: requestPlanUsagePopup')
})

test('the phone sheet lists "Navegador" and opens the browser drawer', () => {
  const at = entry('browser')
  expect(at).toBeGreaterThan(-1)
  const line = src.slice(at, src.indexOf('\n', at))
  expect(line).toContain("'Navegador'")
  expect(line).toContain('setBrowserDrawerOpen(true)')
})

test('"Navegador" comes right after "Uso dos planos" and before "Hardware"', () => {
  const plan = entry('plan-usage')
  const browser = entry('browser')
  const hardware = entry('hardware')
  expect(plan).toBeLessThan(browser)
  expect(browser).toBeLessThan(hardware)
})

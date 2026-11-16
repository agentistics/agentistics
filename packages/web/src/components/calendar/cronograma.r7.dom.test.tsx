import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const dir = (f: string) => readFileSync(new URL(f, import.meta.url), 'utf8')
const css = dir('./cronograma.css')
const tsx = dir('./CronogramaTree.tsx')
const rule = (selector: string) => {
  const i = css.indexOf(selector + '{')
  expect(i).toBeGreaterThanOrEqual(0)
  return css.slice(i, css.indexOf('}', i))
}

test('r7: phase chip text is mostly --text-primary (≤10% of the stage colour), in both themes', () => {
  expect(rule('.crono-ph')).toContain('color:color-mix(in srgb,var(--c) 10%,var(--text-primary))')
})

test('r7: "sem horário/sem data" text is 80% --text-primary over the card, not --text-secondary', () => {
  const sem = rule('.crono-sem')
  expect(sem).toContain('color:color-mix(in srgb,var(--text-primary) 80%,var(--bg-card))')
  expect(sem).not.toContain('var(--text-secondary)')
})

test('r7: a sub bar hint is solid --text-primary (no transparency over the tinted bar)', () => {
  const r = rule('.crono-bar[data-kind="sub"] .crono-hint')
  expect(r).toContain('color:var(--text-primary)')
  expect(r).toContain('background:color-mix(in srgb,var(--bg-card) 85%,transparent)') // backing so the bright progress fill cannot drop it below 4.5
})

test('r7: the "sem horário" chip is rendered inside the .crono-semw wrapper (it carries the positioning)', () => {
  expect(tsx).toMatch(/<span className="crono-semw"[^>]*><span className="crono-sem"/)
  expect(rule('.crono-semw')).toContain('position:absolute')
})

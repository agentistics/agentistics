import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const css = readFileSync(new URL('./cronograma.css', import.meta.url), 'utf8')
const rule = (selector: string) => {
  const i = css.indexOf(selector + '{')
  expect(i).toBeGreaterThanOrEqual(0)
  return css.slice(i, css.indexOf('}', i))
}
const lum = (hex: string) => {
  const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!
}
const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05) }

test('light theme: the navy parent bars pin their OWN light text tokens (≥4.5:1 on navy), independent of the theme', () => {
  const r = rule('.crono-bar[data-kind="task"],.crono-bar[data-kind="group"]')
  const fg = /color:(#[0-9a-f]{6})/.exec(r)?.[1]
  expect(fg).toBeTruthy()
  expect(ratio(fg!, '#1b2447')).toBeGreaterThanOrEqual(4.5)
  expect(r).toContain('--text-primary:' + fg)
  expect(r).toContain('--text-tertiary:') // the hint
  expect(r).toContain('--ag-tint-3:') // the ring track
})

test('"sem horário" chip is sticky at the title column edge, like the phase stack', () => {
  const sem = rule('.crono-sem')
  expect(sem).toContain('position:sticky')
  expect(sem).toContain('left:calc(var(--LW) + 8px)')
  expect(rule('.crono-bar>.crono-phw>.crono-stk')).toContain('left:calc(var(--LW) + 8px)')
})

test('light theme: a sub bar hint is not the faint tertiary token (it sits on a tinted bar)', () => {
  expect(rule('.crono-bar[data-kind="sub"] .crono-hint')).toContain('--text-primary')
})

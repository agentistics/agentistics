import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { everyOptions, firstAfterOptions } from './AwayDigestScheduleSection'

test('offers the closed option lists, with off last and the defaults among them', () => {
  expect(firstAfterOptions(true).map(o => o.label)).toEqual(['1 h', '2 h', '5 h', '12 h', 'Desligado'])
  expect(firstAfterOptions(false).at(-1)).toEqual({ value: 'off', label: 'Off' })
  expect(everyOptions().map(o => o.label)).toEqual(['15 min', '30 min', '1 h', '3 h'])
})

test('renders both rows with the shared settings primitives, in each language', () => {
  // `Select` measures the window, so this pins the source rather than a server render.
  const source = readFileSync(new URL('./AwayDigestScheduleSection.tsx', import.meta.url), 'utf8')
  for (const label of ['Resumo da ausência: primeiro depois de', 'Depois, a cada', 'Away summary: first after', 'Then every']) expect(source).toContain(label)
  expect(source).toContain("import { PrefRow, Select } from './primitives'")
  expect(source).not.toContain('<select')
})

test('the away section mounts it', () => {
  expect(readFileSync(new URL('./AwaySection.tsx', import.meta.url), 'utf8')).toContain('<AwayDigestScheduleSection pt={pt} />')
})

import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { CleanScanState } from '@agentistics/core'
import { CleanScanView } from './CleanDialog'
const scan: CleanScanState = { id: 'scan', state: 'scanning', step: 2, label: 'measuring', progress: .46, etaMs: 40_000, startedAt: 1000, elapsedMs: 10_000,
  foundBytes: 1.5 * 1024 ** 3, itemCount: 37, projectCount: 2, projectTotal: 5, background: false,
  log: [{ at: 1000, state: 'done', name: 'completed-name', bytes: 1024 }, { at: 1100, state: 'running', name: 'running-name' }, { at: 1200, state: 'queued', name: 'queued-project' }] }
test('live scan shows localized bytes, counters, step, ETA, progress and all three log states', () => {
  const html = renderToStaticMarkup(<CleanScanView scan={scan} lang="pt" />)
  for (const label of ['Encontrado até agora', '1,5 GB', 'Etapa', '46%', 'cerca de 40 s', 'O que está acontecendo', 'completed-name', 'medindo ', 'na fila: ', 'role="log"', 'value="0.46"']) expect(html).toContain(label)
})
test('the same state is readable in English, and first render has no stale progress', () => {
  const html = renderToStaticMarkup(<CleanScanView scan={scan} lang="en" />)
  for (const label of ['Found so far', '1.5 GB', 'Step', 'about 40 s', 'queued: ']) expect(html).toContain(label)
  const initial = renderToStaticMarkup(<CleanScanView scan={null} lang="en" />)
  expect(initial).toContain('0 B')
  expect(initial).toContain('estimating time')
  expect(initial).not.toContain('completed-name')
})

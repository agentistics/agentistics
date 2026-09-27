/**
 * sessionsTabsRight.lint.test.ts — "Filtros" and the session-metrics tab hang off the TOP RIGHT of
 * the sessions workspace strip, anchored to the artifacts aside, never the top left.
 *
 * Owner: "você vai mover os dois itens 'Filtros' e os stats da sessão pra direita, quando o aside
 * da direita abrir eles devem vir mais pra esquerda junto, eles nunca vao ficar por cima dele." The
 * two tabs used to hang off the FLEET aside's own right edge (`left: filtrosBounds.left` /
 * `left: metricsBounds.left`); they now hang off the ARTIFACTS aside's own left edge instead
 * (`right: filtrosBounds.right` / `right: metricsBounds.right`, plus a fixed
 * `SESSIONS_TAB_CORNER_CLEARANCE` added on top since the 2026-09-26 rounded-card follow-up — see
 * that constant's own comment in `App.tsx`), computed by the right-anchored mirror of the same
 * clamp (`filtrosPanelBoundsRight`/`metricsTabBoundsRight`, `lib/sessionsFiltersPanel.ts`).
 *
 * Not reachable by rendering — `App.tsx` needs a fleet host and a team-session gate, and
 * `packages/web` has no jsdom. The SHAPE is what changed, so the shape is what is asserted, over
 * comment-free source, with the old shape planted back in to prove the scan still catches it.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stripComments } from './lib/stripComments'

const RAW = readFileSync(join(import.meta.dir, 'App.tsx'), 'utf-8')
const SRC = stripComments(RAW)

describe('the Filtros tab is anchored to the artifacts aside, on the right', () => {
  test('the bounds are computed by the right-anchored function', () => {
    expect(SRC).toContain('const filtrosBounds = filtrosPanelBoundsRight(')
  })

  test('the trigger/panel column is positioned with `right`, never `left`', () => {
    // `+ SESSIONS_TAB_CORNER_CLEARANCE` (owner-approved visual, 2026-09-26 follow-up: the tabs hang
    // from the central pane's own rounded top border now, and need the extra clearance to clear its
    // curve) rides on top of the same right-anchored base this test was written to pin — the base
    // itself, `filtrosBounds.right`, is untouched.
    expect(SRC).toContain('right: filtrosBounds.right + SESSIONS_TAB_CORNER_CLEARANCE,')
    expect(SRC).not.toMatch(/left: filtrosBounds\.left/)
  })

  test('the column aligns its content to the right edge, flush against the aside', () => {
    expect(SRC).toContain("alignItems: 'flex-end', pointerEvents: 'auto'")
  })

  test('the scan still sees the old left-anchored shape reintroduced', () => {
    const planted = SRC
      .replace('const filtrosBounds = filtrosPanelBoundsRight(', 'const filtrosBounds = filtrosPanelBounds(')
      .replace('right: filtrosBounds.right + SESSIONS_TAB_CORNER_CLEARANCE,', 'left: filtrosBounds.left,')
    expect(planted).toMatch(/left: filtrosBounds\.left/)
  })
})

describe('the session-metrics tab is anchored the same way, beside Filtros', () => {
  test('the bounds are computed by the right-anchored function', () => {
    expect(SRC).toContain('const metricsBounds = metricsTabBoundsRight(filtrosBounds, filtrosTabW, METRICS_TAB_GAP)')
  })

  test('its own wrapper is positioned with `right`, never `left`', () => {
    expect(SRC).toContain('right: metricsBounds.right + SESSIONS_TAB_CORNER_CLEARANCE,')
    expect(SRC).not.toMatch(/left: metricsBounds\.left/)
  })

  test('the scan still sees the old left-anchored shape reintroduced', () => {
    const planted = SRC.replace('right: metricsBounds.right + SESSIONS_TAB_CORNER_CLEARANCE,', 'left: metricsBounds.left,')
    expect(planted).toMatch(/left: metricsBounds\.left/)
  })
})

describe('the names this pins still exist in the file', () => {
  test('the pure right-anchored functions are imported from sessionsFiltersPanel', () => {
    expect(SRC).toMatch(/filtrosPanelBoundsRight/)
    expect(SRC).toMatch(/metricsTabBoundsRight/)
  })
})

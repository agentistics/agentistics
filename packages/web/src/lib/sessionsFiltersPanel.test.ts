import { describe, test, expect } from 'bun:test'
import {
  filtrosPanelInert, filtrosPanelOverflow, sessionsFiltersShouldReturnFocus,
  filtrosPanelBounds, FILTROS_PANEL_PREFERRED_WIDTH, FILTROS_PANEL_MIN_WIDTH,
  metricsTabBounds, METRICS_PANEL_PREFERRED_WIDTH, METRICS_PANEL_MIN_WIDTH,
  filtrosPanelBoundsRight, metricsTabBoundsRight, VIEWPORT_EDGE_MARGIN,
} from './sessionsFiltersPanel'

describe('filtrosPanelInert', () => {
  test('collapsed panel is inert', () => {
    expect(filtrosPanelInert(false)).toBe(true)
  })

  test('open panel is NOT inert — the attribute is absent, not false', () => {
    expect(filtrosPanelInert(true)).toBeUndefined()
  })
})

describe('sessionsFiltersShouldReturnFocus', () => {
  test('collapsing while focus is inside the panel returns it to the trigger', () => {
    expect(sessionsFiltersShouldReturnFocus(false, true)).toBe(true)
  })

  test('collapsing while focus is elsewhere leaves it alone', () => {
    expect(sessionsFiltersShouldReturnFocus(false, false)).toBe(false)
  })

  test('opening never moves focus, whatever it is doing right now', () => {
    expect(sessionsFiltersShouldReturnFocus(true, true)).toBe(false)
    expect(sessionsFiltersShouldReturnFocus(true, false)).toBe(false)
  })
})

describe('filtrosPanelBounds', () => {
  // Figures verbatim from the review's re-review, §1: at 1440 the fleet aside puts the left edge
  // at x:320 and the artifacts aside at its DEFAULT (620px) width starts at x:820 — 500px of room,
  // more than the panel wants, so it gets its full preferred width.
  test('1440×900, artifacts aside at its default width — full preferred width, no clamp', () => {
    const bounds = filtrosPanelBounds({ left: 0, right: 320 }, { left: 820, right: 1440 }, 1440)
    expect(bounds).toEqual({ left: 320, width: FILTROS_PANEL_PREFERRED_WIDTH })
  })

  // The residual defect this function exists to close: at 1024×768 the SAME default-width aside
  // renders at 439px, not 620px, so it starts at x:585 (reproduced live, review §1) — 265px of
  // room. A fixed 440px cap overlapped it by 15px, painting over the "Studio" and "Live" tabs
  // (measured centres at x:628 and x:694). The clamped width must not cross the aside's left edge.
  test('1024×768, artifacts aside at its ACTUAL default width — clamped to the room, no overlap', () => {
    const bounds = filtrosPanelBounds({ left: 0, right: 320 }, { left: 585, right: 1024 }, 1024)
    expect(bounds).toEqual({ left: 320, width: 265 })
    expect(bounds.left + bounds.width).toBeLessThanOrEqual(585)
    // The two tabs the review found occluded are both now clear of the panel's right edge.
    expect(bounds.left + bounds.width).toBeLessThan(593) // "Studio" tab's own left edge
  })

  test('artifacts aside CLOSED — the viewport is the right edge, not the aside', () => {
    const bounds = filtrosPanelBounds({ left: 0, right: 320 }, null, 1440)
    expect(bounds).toEqual({ left: 320, width: FILTROS_PANEL_PREFERRED_WIDTH })
  })

  test('a closed aside and a present aside agree when the room is the same either way', () => {
    const withAside = filtrosPanelBounds({ left: 0, right: 200 }, { left: 500, right: 900 }, 900)
    const closedAtSameEdge = filtrosPanelBounds({ left: 0, right: 200 }, null, 500)
    expect(withAside.width).toBe(closedAtSameEdge.width)
  })

  test('room narrower than the floor still returns the floor, not a negative or zero width', () => {
    const bounds = filtrosPanelBounds({ left: 0, right: 1000 }, { left: 1050, right: 1440 }, 1440)
    expect(bounds).toEqual({ left: 1000, width: FILTROS_PANEL_MIN_WIDTH })
  })

  test('an aside crossing the left edge entirely (no room at all) still floors rather than going negative', () => {
    const bounds = filtrosPanelBounds({ left: 0, right: 800 }, { left: 700, right: 1440 }, 1440)
    expect(bounds.width).toBe(FILTROS_PANEL_MIN_WIDTH)
  })
})

describe('metricsTabBounds — the session-metrics tab beside Filtros (design item 4)', () => {
  test('plenty of room: the tab sits right after Filtros, dropdown gets its preferred width', () => {
    const filtros = filtrosPanelBounds({ left: 0, right: 320 }, { left: 820, right: 1440 }, 1440)
    const bounds = metricsTabBounds(filtros, 100, 6)
    expect(bounds.left).toBe(320 + 100 + 6)
    expect(bounds.panelMaxWidth).toBe(METRICS_PANEL_PREFERRED_WIDTH)
  })

  test('a narrower gap between the asides clamps the dropdown, never past the right aside', () => {
    // 360px between the asides — enough for the Filtros panel to want its full room, but once the
    // metrics tab's own width is subtracted there is less than the metrics dropdown's preferred
    // 300px left, and MORE than its floor: a real, non-degenerate clamp.
    const filtros = filtrosPanelBounds({ left: 0, right: 320 }, { left: 680, right: 1440 }, 1440)
    const bounds = metricsTabBounds(filtros, 100, 6)
    expect(bounds.panelMaxWidth).toBeLessThan(METRICS_PANEL_PREFERRED_WIDTH)
    expect(bounds.panelMaxWidth).toBeGreaterThan(METRICS_PANEL_MIN_WIDTH)
    expect(bounds.left + bounds.panelMaxWidth).toBeLessThanOrEqual(680)
  })

  test('room narrower than the floor still returns the floor, not a negative width', () => {
    const filtros = { left: 320, width: FILTROS_PANEL_MIN_WIDTH } // 320..560, 240px of room total
    const bounds = metricsTabBounds(filtros, 200, 6) // tab alone eats 206 of the 240
    expect(bounds.panelMaxWidth).toBe(METRICS_PANEL_MIN_WIDTH)
  })

  // The residual tradeoff `filtrosPanelBounds` itself already documents and accepts: once even the
  // FLOOR cannot fit in what is left, the floor is returned anyway rather than a panel squeezed to
  // nothing — which can still cross the right aside's edge. Stated here rather than hidden by a
  // looser assertion, the same way `filtrosPanelBounds`'s own last two tests state it for the panel.
  test('when the room is narrower than even the floor, the floor may still cross the right edge', () => {
    const filtros = filtrosPanelBounds({ left: 0, right: 320 }, { left: 585, right: 1024 }, 1024)
    const bounds = metricsTabBounds(filtros, 90, 6)
    expect(bounds.panelMaxWidth).toBe(METRICS_PANEL_MIN_WIDTH)
    expect(bounds.left + bounds.panelMaxWidth).toBeGreaterThan(585)
  })

  test('the tab never lands to the LEFT of the Filtros tab, whatever the gap', () => {
    const filtros = filtrosPanelBounds({ left: 0, right: 320 }, null, 1440)
    const bounds = metricsTabBounds(filtros, 0, 0)
    expect(bounds.left).toBeGreaterThanOrEqual(filtros.left)
  })
})

describe('filtrosPanelBoundsRight — the same clamp, anchored to the artifacts aside instead', () => {
  test('1440×900, artifacts aside at its default width — full preferred width, no clamp', () => {
    // Same figures `filtrosPanelBounds`' own first test uses — the room between the two asides is
    // identical either way, only the returned offset changes shape (a `right` CSS value: 1440-820).
    const bounds = filtrosPanelBoundsRight({ left: 0, right: 320 }, { left: 820, right: 1440 }, 1440)
    expect(bounds).toEqual({ right: 620, width: FILTROS_PANEL_PREFERRED_WIDTH })
  })

  test('1024×768, artifacts aside at its ACTUAL default width — clamped to the room, no overlap', () => {
    const bounds = filtrosPanelBoundsRight({ left: 0, right: 320 }, { left: 585, right: 1024 }, 1024)
    expect(bounds).toEqual({ right: 439, width: 265 })
    // The box's own LEFT edge, worked back out from the CSS `right` offset, never crosses the
    // fleet aside's own right edge (320).
    expect(1024 - bounds.right - bounds.width).toBeGreaterThanOrEqual(320)
  })

  // Owner complaint (2026-09-21): "os 2 itens ficaram muito grudados a direita" — with the aside
  // closed, `rightEdge` fell back to the bare `viewportWidth`, so `right` came out to exactly `0`
  // and the Filtros trigger sat flush against the true browser edge (reproduced live at 1440px: its
  // own measured right edge landed AT x:1441). `VIEWPORT_EDGE_MARGIN` is the fix — see its own
  // comment for why it reuses `PAGE_INSET`'s figure.
  test('artifacts aside CLOSED — kept off the true viewport edge by a small margin, not flush', () => {
    const bounds = filtrosPanelBoundsRight({ left: 0, right: 320 }, null, 1440)
    expect(bounds).toEqual({ right: VIEWPORT_EDGE_MARGIN, width: FILTROS_PANEL_PREFERRED_WIDTH })
    expect(bounds.right).toBeGreaterThan(0)
  })

  test('a closed aside and a present aside agree on WIDTH when the room is the same either way', () => {
    const withAside = filtrosPanelBoundsRight({ left: 0, right: 200 }, { left: 500, right: 900 }, 900)
    // The closed fallback now measures its edge `VIEWPORT_EDGE_MARGIN` short of the raw viewport —
    // so to compare against the SAME 500px edge as `withAside`, the bare viewport passed in must be
    // that much wider, or the two would legitimately disagree by exactly the margin.
    const closedAtSameEdge = filtrosPanelBoundsRight({ left: 0, right: 200 }, null, 500 + VIEWPORT_EDGE_MARGIN)
    expect(withAside.width).toBe(closedAtSameEdge.width)
  })

  test('room narrower than the floor still returns the floor, not a negative or zero width', () => {
    const bounds = filtrosPanelBoundsRight({ left: 0, right: 1000 }, { left: 1050, right: 1440 }, 1440)
    expect(bounds).toEqual({ right: 390, width: FILTROS_PANEL_MIN_WIDTH })
  })

  test('the aside MINIMIZED (reported as null) — the same viewport now falls back to the edge margin, never zero', () => {
    // The reactive half of change #3: minimizing the artifacts aside is a NEW measurement
    // (`rightAsideEdge` going back to `null`), never a second code path — this is the same function
    // called again with a different `rightAside`, exactly as `fullscreenInsetRight` is.
    const open = filtrosPanelBoundsRight({ left: 0, right: 320 }, { left: 820, right: 1440 }, 1440)
    const minimized = filtrosPanelBoundsRight({ left: 0, right: 320 }, null, 1440)
    expect(open.right).toBeGreaterThan(VIEWPORT_EDGE_MARGIN)
    expect(minimized.right).toBe(VIEWPORT_EDGE_MARGIN)
  })
})

describe('metricsTabBoundsRight — the session-metrics tab beside Filtros, anchored to the right', () => {
  test('plenty of room: the tab sits right BEFORE Filtros, dropdown gets its preferred width', () => {
    const filtros = filtrosPanelBoundsRight({ left: 0, right: 320 }, { left: 820, right: 1440 }, 1440)
    const bounds = metricsTabBoundsRight(filtros, 100, 6)
    expect(bounds.right).toBe(620 + 100 + 6)
    expect(bounds.panelMaxWidth).toBe(METRICS_PANEL_PREFERRED_WIDTH)
  })

  test('a narrower gap between the asides clamps the dropdown, never past the fleet aside', () => {
    const filtros = filtrosPanelBoundsRight({ left: 0, right: 320 }, { left: 680, right: 1440 }, 1440)
    const bounds = metricsTabBoundsRight(filtros, 100, 6)
    expect(bounds.panelMaxWidth).toBeLessThan(METRICS_PANEL_PREFERRED_WIDTH)
    expect(bounds.panelMaxWidth).toBeGreaterThan(METRICS_PANEL_MIN_WIDTH)
    // Worked back to the box's own left edge — never crosses the fleet aside's own right edge (320).
    expect(1440 - bounds.right - bounds.panelMaxWidth).toBeGreaterThanOrEqual(320)
  })

  test('room narrower than the floor still returns the floor, not a negative width', () => {
    const filtros = { right: 320, width: FILTROS_PANEL_MIN_WIDTH } // mirrors the left-anchored test
    const bounds = metricsTabBoundsRight(filtros, 200, 6)
    expect(bounds.panelMaxWidth).toBe(METRICS_PANEL_MIN_WIDTH)
  })

  test('when the room is narrower than even the floor, the floor may still cross the fleet aside', () => {
    const filtros = filtrosPanelBoundsRight({ left: 0, right: 320 }, { left: 585, right: 1024 }, 1024)
    const bounds = metricsTabBoundsRight(filtros, 90, 6)
    expect(bounds.panelMaxWidth).toBe(METRICS_PANEL_MIN_WIDTH)
    expect(1024 - bounds.right - bounds.panelMaxWidth).toBeLessThan(320)
  })

  test('the tab never lands to the RIGHT of the Filtros tab, whatever the gap', () => {
    const filtros = filtrosPanelBoundsRight({ left: 0, right: 320 }, null, 1440)
    const bounds = metricsTabBoundsRight(filtros, 0, 0)
    expect(bounds.right).toBeGreaterThanOrEqual(filtros.right)
  })
})

describe('filtrosPanelOverflow — a popover inside the panel is never clipped by it', () => {
  test('settled and fitting is VISIBLE, so the "+ Filtro" menu escapes the panel', () => {
    // The reported defect: `auto` made the panel a scroll container, and the menu opened inside
    // it behind two scrollbars.
    expect(filtrosPanelOverflow({ open: true, animating: false, contentHeight: 120, maxHeight: 600 })).toBe('visible')
  })
  test('a card taller than the room scrolls — the lesser evil', () => {
    expect(filtrosPanelOverflow({ open: true, animating: false, contentHeight: 700, maxHeight: 600 })).toBe('auto')
  })
  test('collapsed or mid-animation is hidden, which the grid-rows collapse needs', () => {
    expect(filtrosPanelOverflow({ open: false, animating: false, contentHeight: 120, maxHeight: 600 })).toBe('hidden')
    expect(filtrosPanelOverflow({ open: true, animating: true, contentHeight: 120, maxHeight: 600 })).toBe('hidden')
  })
  test('not measured yet reads as fitting', () => {
    expect(filtrosPanelOverflow({ open: true, animating: false, contentHeight: null, maxHeight: 600 })).toBe('visible')
    expect(filtrosPanelOverflow({ open: true, animating: false, contentHeight: 120, maxHeight: null })).toBe('visible')
  })
})

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ASIDE_DRAWER_Z, ASIDE_Z, TOPBAR_Z, DIALOG_FLOOR_Z, MOBILE_PILL_BAR_Z, NAY_FAB_EFFECTS_Z, NAY_FAB_Z, NAY_NOTIFY_CARD_Z, PANEL_FULLSCREEN_Z } from './zLayers'
import { WINDOW_Z_BASE } from './nayDock'

const read = (rel: string) => readFileSync(join(import.meta.dir, '..', rel), 'utf8')

describe('the floating Nay button stays above full-screen surfaces and below dialogs', () => {
  test('tier order', () => {
    expect(NAY_FAB_Z).toBeGreaterThan(PANEL_FULLSCREEN_Z)
    expect(NAY_FAB_Z).toBeGreaterThan(MOBILE_PILL_BAR_Z)
    expect(NAY_FAB_Z).toBeLessThan(DIALOG_FLOOR_Z)
    expect(NAY_FAB_EFFECTS_Z).toBeGreaterThan(PANEL_FULLSCREEN_Z)
    expect(NAY_FAB_EFFECTS_Z).toBeLessThan(NAY_FAB_Z)
    expect(NAY_NOTIFY_CARD_Z).toBeGreaterThan(NAY_FAB_Z)
    expect(NAY_NOTIFY_CARD_Z).toBeLessThan(DIALOG_FLOOR_Z)
    // The chat window the button opens is already above every one of these.
    expect(WINDOW_Z_BASE).toBeGreaterThan(DIALOG_FLOOR_Z)
  })

  test('the components take their tier from the scale, not a literal', () => {
    const fab = read('components/nay/NayFab.tsx')
    expect(fab).toContain('zIndex: NAY_FAB_Z')
    expect(fab).toContain('zIndex: NAY_FAB_EFFECTS_Z')
    expect(fab).not.toMatch(/zIndex: (299|300),/)
    expect(read('components/nay/NayNotifyCard.tsx')).toContain('zIndex: NAY_NOTIFY_CARD_Z')
  })

  test('no dialog tier sits between the full-screen panels and the first dialog floor without being accounted for', () => {
    // Every literal z-index in 321..349 outside the scale module would be a surface the button now covers.
    const hits: string[] = []
    const walk = (dir: string) => {
      for (const f of require('node:fs').readdirSync(join(import.meta.dir, '..', dir), { withFileTypes: true })) {
        const rel = `${dir}/${f.name}`
        if (f.isDirectory()) walk(rel)
        else if (/\.tsx$/.test(f.name) && !/\.test\./.test(f.name)) {
          for (const m of read(rel).matchAll(/position: 'fixed'[^\n]*zIndex: (3[2-4]\d)\b/g)) hits.push(`${rel}: ${m[1]}`)
        }
      }
    }
    walk('components'); walk('pages')
    // The mobile "More" sheet (App.tsx, 320) is the one known surface in this band; see the module header.
    expect(hits.filter(h => !h.startsWith('components/nav/MobilePillBar') && !h.includes('App.tsx'))).toEqual([])
  })
})

describe('the area-tree drawer covers the whole top bar (MENU.LATERAL-ATRAS)', () => {
  test('tier order: drawer above the top bar and panels, below the pill bar, the button and dialogs', () => {
    expect(ASIDE_Z).toBeLessThan(TOPBAR_Z)
    expect(ASIDE_DRAWER_Z).toBeGreaterThan(TOPBAR_Z)
    expect(ASIDE_DRAWER_Z).toBeGreaterThan(PANEL_FULLSCREEN_Z)
    expect(ASIDE_DRAWER_Z).toBeLessThan(MOBILE_PILL_BAR_Z)
    expect(ASIDE_DRAWER_Z).toBeLessThan(NAY_FAB_Z)
  })

  test('the stylesheet token equals the scale and the open aside takes it, with a scrim on touch devices', () => {
    const css = read('index.css')
    expect(css).toContain(`--ag-z-drawer: ${ASIDE_DRAWER_Z};`)
    expect(css).toMatch(/\[data-app-aside\]:has\(\[data-area-rail\]\[data-open="true"\]\) \{ z-index: var\(--ag-z-drawer\) !important; \}/)
    expect(css).toMatch(/@media \(hover: none\) and \(pointer: coarse\) \{\s*\[data-app-aside\]:has\([^)]*\)::before \{[^}]*background: var\(--ag-scrim\)/)
  })

  test('the top bar and the aside take their tiers from the scale', () => {
    expect(read('components/nav/TopBar.tsx')).toContain('zIndex: TOPBAR_Z')
    const app = read('App.tsx')
    expect(app).toContain('zIndex: ASIDE_Z')
    expect(app).toContain('<aside data-app-aside')
  })
})

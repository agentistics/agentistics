import { afterAll, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Filters } from '@agentistics/core'
import { FiltersBar } from './FiltersBar'

const root = globalThis as unknown as { window?: unknown }
const had = root.window
function at<T>(width: number, f: () => T): T {
  root.window = { innerWidth: width, matchMedia: () => ({ matches: width < 768, addEventListener() {}, removeEventListener() {} }), addEventListener() {}, removeEventListener() {} }
  try { return f() } finally { root.window = had }
}
afterAll(() => { root.window = had })

const filters: Filters = { dateRange: 'all', customStart: '', customEnd: '', projects: [], models: ['claude-opus-5'], harnesses: ['claude', 'codex'] }
const render = (lang: 'pt' | 'en', width: number, hideClearAll?: boolean) => at(width, () => renderToStaticMarkup(
  <FiltersBar compact filters={filters} onChange={() => {}} projects={[]} sessionCountByProject={{}} models={['claude-opus-5']} harnesses={['claude', 'codex']}
    users={[]} lang={lang} hideClearAll={hideClearAll} />,
))

describe('FiltersBar inside the filters sheet', () => {
  for (const lang of ['pt', 'en'] as const) {
    const clear = lang === 'pt' ? 'Limpar filtros' : 'Clear filters'
    test(`the sheet's footer owns "clear", so the bar's own is not drawn (${lang})`, () => {
      expect(render(lang, 390, true)).not.toContain(clear)
      expect(render(lang, 390)).toContain(clear)
    })
    test(`chip ✕ projects a touch target and the date row is 44px on a phone (${lang})`, () => {
      const phone = render(lang, 390, true)
      expect(phone).toContain('class="ag-tap-icon"')
      expect(phone).toContain('height:44px')
      const desk = render(lang, 1440, true)
      expect(desk).toContain('height:30px')
    })
  }
})

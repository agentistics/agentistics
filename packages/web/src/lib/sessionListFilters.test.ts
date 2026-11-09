import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8')
const app = read('../App.tsx')
const page = read('../pages/SessionsPage.tsx')
const overview = read('../components/sessions/FleetOverview.tsx')

test('the session list owns its filters: state starts from the empty scope, separate from the metric ones', () => {
  expect(app).toContain('useState<Filters>(SESSION_LIST_FILTERS)')
  expect(app).toContain('const sessionsFilters = listFilters')
  expect(app).toContain('setSessionsFilters: setListFilters')
})

test('the Filtros panel in the strip edits the list filters, not the metric ones', () => {
  const panel = app.slice(app.indexOf('only={SESSIONS_FILTER_DIMS}'), app.indexOf('only={SESSIONS_FILTER_DIMS}') + 400)
  expect(panel).toContain('filters={sessionsFilters}')
  expect(panel).toContain('onChange={setListFilters}')
  expect(panel).toContain('activeOnly={sessionsActiveOnly}')
  expect(app).toContain('countActiveFilters(sessionsFilters, sessionsActiveOnly, leadersOnly)')
})

test('the mobile Filtros sheet and its badge read and write the list filters', () => {
  expect(page).toContain('setSessionsFilters, setSessionsActiveOnly')
  expect(page).toContain('(sessionsFilters.harnesses?.length ?? 0) > 0')
  const sheet = page.slice(page.indexOf('const filtersSheet'), page.indexOf('const filtersSheet') + 1600)
  expect(sheet).toContain('filters={sessionsFilters}')
  expect(sheet).toContain('onChange={setSessionsFilters}')
  expect(sheet).not.toContain('setFilters')
})

test('the overview says what it still follows from the top bar: the calendar', () => {
  expect(overview).not.toContain('Segue os filtros do topo')
  expect(overview).not.toContain('this calendar follows the filters above')
})

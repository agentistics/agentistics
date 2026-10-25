import React from 'react'
import { afterAll, expect, test } from 'bun:test'
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom'
import { renderToStaticMarkup } from 'react-dom/server'
import SettingsPage from './SettingsPage'

const g = globalThis as { window?: unknown }
const savedWindow = g.window
afterAll(() => { if (savedWindow) g.window = savedWindow; else delete g.window })
for (const width of [1440, 390]) test(`settings sections fit their scrolling slot at ${width}px`, () => {
  g.window = { innerWidth: width }
  const h = renderToStaticMarkup(<MemoryRouter initialEntries={['/settings/preferences']}><Routes>
    <Route element={<Outlet context={{ lang: 'pt', isCentral: false }} />}>
      <Route path="/settings" element={<SettingsPage />}><Route path="preferences" element={<div>Billing content</div>} /></Route>
    </Route>
  </Routes></MemoryRouter>)
  expect(h).toContain('Billing content')
  if (width === 390) {
    expect(h).toContain('scroll-snap-type:x mandatory')
    expect(h).toContain('flex:0 0 100%')
    expect(h).toContain('scroll-snap-stop:always')
    expect(h).toContain('min-height:44px')
    expect(h).toContain('aria-current="page"')
  } else expect(h).not.toContain('scroll-snap-type')
})

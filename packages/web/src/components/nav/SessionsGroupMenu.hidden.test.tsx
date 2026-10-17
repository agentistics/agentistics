import { expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { groupMenuLayout, HiddenFoldersSection } from './SessionsGroupMenu'

for (const isMobile of [false, true]) test(`hidden folders are a collapsed, counted section (${isMobile ? '390px' : '1280px'})`, () => {
  const html = renderToStaticMarkup(<HiddenFoldersSection lang="en" isMobile={isMobile} hiddenFolders={[{ id: 'hidden', name: 'A very long folder name '.repeat(10) }]} onShowFolder={() => {}} />)
  expect(html).not.toContain('<details')
  expect(html).toMatch(/aria-expanded="false"/)
  expect(html).toMatch(/<button[^>]*>.*Hidden folders.*<span[^>]*>1<\/span><\/button>/)
  expect(html).toContain('grid-column:1 / -1')
  const layout = groupMenuLayout(isMobile ? 390 : 1280, isMobile)
  expect(layout.width).toBeLessThanOrEqual(isMobile ? 366 : 1256)
  if (isMobile) expect(html).toMatch(/<button[^>]*min-height:44px/)
  // The folder rows only exist once the disclosure is opened (see SessionsGroupMenu.dom.test.tsx).
})

test('hidden folders summary precedes the menu’s long ordering controls', () => {
  const src = readFileSync(new URL('./SessionsGroupMenu.tsx', import.meta.url), 'utf8')
  expect(src.indexOf('<HiddenFoldersSection')).toBeLessThan(src.indexOf('{/* ORDERING'))
  const html = renderToStaticMarkup(<HiddenFoldersSection lang="pt" isMobile={false} hiddenFolders={[]} onShowFolder={() => {}} />)
  expect(html).toContain('Pastas ocultas')
})

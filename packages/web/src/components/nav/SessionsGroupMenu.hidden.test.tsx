import { expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { groupMenuLayout, HiddenFoldersSection } from './SessionsGroupMenu'

for (const isMobile of [false, true]) test(`hidden folders are a collapsed, counted section (${isMobile ? '390px' : '1280px'})`, () => {
  let restored = ''
  const tree = HiddenFoldersSection({ lang: 'en', isMobile, hiddenFolders: [{ id: 'hidden', name: 'A very long folder name '.repeat(10) }], onShowFolder: id => { restored = id } })
  const html = renderToStaticMarkup(tree)
  expect(html).toContain('<details')
  expect(tree.props.open).toBeUndefined()
  expect(html).toMatch(/<summary[^>]*>Hidden folders<span[^>]*>1<\/span><\/summary>/)
  expect(html).toContain('text-overflow:ellipsis')
  expect(html).toContain('grid-column:1 / -1')
  const layout = groupMenuLayout(isMobile ? 390 : 1280, isMobile)
  expect(layout.width).toBeLessThanOrEqual(isMobile ? 366 : 1256)
  if (isMobile) expect(html).toMatch(/<button[^>]*min-height:44px/)
  const visit = (node: React.ReactNode): void => React.Children.forEach(node, c => {
    if (!React.isValidElement<{ children?: React.ReactNode; onClick?: () => void }>(c)) return
    if (c.type === 'button') c.props.onClick!()
    else visit(c.props.children)
  })
  visit(tree.props.children)
  expect(restored).toBe('hidden')
})

test('hidden folders summary precedes the menu’s long ordering controls', () => {
  const src = readFileSync(new URL('./SessionsGroupMenu.tsx', import.meta.url), 'utf8')
  expect(src.indexOf('<HiddenFoldersSection')).toBeLessThan(src.indexOf('{/* ORDERING'))
  const html = renderToStaticMarkup(<HiddenFoldersSection lang="pt" isMobile={false} hiddenFolders={[]} onShowFolder={() => {}} />)
  expect(html).toContain('Pastas ocultas')
  expect(html).toContain('Nenhuma.')
})

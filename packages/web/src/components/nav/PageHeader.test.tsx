import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { PageHeader } from './PageHeader'

test('crumb comes from the registry, title defaults to the page label', () => {
  const html = renderToStaticMarkup(<PageHeader lang="pt" areaId="usage" pageId="now" status="2 de 3 planos acima do ritmo." />)
  expect(html).toContain('Uso')
  expect(html).toContain('Agora')
  expect(html).toContain('2 de 3 planos acima do ritmo.')
})

test('no status sentence renders no empty paragraph', () => {
  const html = renderToStaticMarkup(<PageHeader lang="en" areaId="usage" pageId="now" />)
  expect(html).not.toContain('<p')
})

test('at most two actions are drawn', () => {
  const a = { label: 'x', onClick: () => {} }
  const html = renderToStaticMarkup(<PageHeader lang="en" areaId="usage" pageId="now" actions={[a, a, a]} />)
  expect(html.match(/<button/g)?.length).toBe(2)
})

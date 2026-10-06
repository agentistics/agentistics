import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'bun:test'
import { AgentisticsLoader, AGENTISTICS_LOGO_PATHS } from './AgentisticsLoader'

const logoFile = new URL('../../branding/logo-no-background.svg', import.meta.url)

describe('AgentisticsLoader', () => {
  test('keeps every logo path and stroke width identical to the canonical brand SVG', async () => {
    const source = await Bun.file(logoFile).text()
    const paths = [...source.matchAll(/<path d="([^"]+)"(?: fill="[^"]+")?(?: stroke="[^"]+" stroke-width="(\d+)")?\/>/g)]
    expect(paths.map(path => path[1])).toEqual([
      AGENTISTICS_LOGO_PATHS.shell,
      AGENTISTICS_LOGO_PATHS.earRight,
      AGENTISTICS_LOGO_PATHS.earLeft,
      AGENTISTICS_LOGO_PATHS.eyeLeft,
      AGENTISTICS_LOGO_PATHS.eyeRight,
    ])
    expect(paths.map(path => path[2] ?? null)).toEqual(['3', null, null, '2', '2'])
  })

  test('renders an accessible status with the supplied label', () => {
    const html = renderToStaticMarkup(<AgentisticsLoader size={16} label="Carregando" />)
    expect(html).toContain('role="status"')
    expect(html).toContain('aria-label="Carregando"')
  })
})


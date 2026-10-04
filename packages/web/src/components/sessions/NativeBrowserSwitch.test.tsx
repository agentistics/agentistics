import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { NativeBrowserSwitch } from './NativeBrowserSwitch'

describe('B6.4: the browser switch in the native chat', () => {
  test('off by default; disabled while a run is in flight', () => {
    const off = renderToStaticMarkup(<NativeBrowserSwitch on={false} running={false} lang="pt" onSet={async () => null} />)
    expect(off).not.toContain('checked=""')
    expect(off).toContain('Navegador')
    expect(renderToStaticMarkup(<NativeBrowserSwitch on running lang="en" onSet={async () => null} />)).toContain('disabled=""')
  })
})

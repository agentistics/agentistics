import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { BottomSheet } from './BottomSheet'
import { FiltersSheet } from './sessions/FiltersSheet'

const noop = () => {}

describe('BottomSheet', () => {
  test('closed sheets leave no dialog or hidden focus targets', () => {
    expect(renderToStaticMarkup(<BottomSheet open={false} onClose={noop} title="Areas" lang="en"><button>Hidden</button></BottomSheet>)).toBe('')
  })
  test('the shared frame has a named modal, close target, safe inset and optional footer', () => {
    const html = renderToStaticMarkup(<BottomSheet open onClose={noop} title="Areas" lang="en" footer={<footer>Footer</footer>}><p>Tree</p></BottomSheet>)
    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-modal="true"')
    expect(html).toContain('aria-label="Areas"')
    expect(html).toContain('aria-label="Close"')
    expect(html).toContain('width:44px;height:44px')
    expect(html).toContain('padding-bottom:var(--mobile-nav-inset)')
    expect(html).toContain('<p>Tree</p>')
    expect(html).toContain('<footer>Footer</footer>')
  })
  test('the filters wrapper retains its child and immediate Done/Clear controls', () => {
    const html = renderToStaticMarkup(<FiltersSheet open onClose={noop} onClear={noop} lang="pt"><p>FiltersBar</p></FiltersSheet>)
    expect(html).toContain('aria-label="Filtros"')
    expect(html).toContain('FiltersBar')
    expect(html).toContain('Limpar')
    expect(html).toContain('Pronto')
    expect(html.match(/role="dialog"/g)).toHaveLength(1)
    expect(renderToStaticMarkup(<FiltersSheet open onClose={noop} lang="en">FiltersBar</FiltersSheet>)).not.toContain('Clear')
  })
})

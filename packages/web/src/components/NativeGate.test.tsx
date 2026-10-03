import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { NativeGate } from './NativeGate'

describe('NativeGate — a native route is experimental', () => {
  test('off: the notice naming the command (PT/EN), never the page; unknown: the fallback; on: the page', () => {
    const off = renderToStaticMarkup(<NativeGate lang="pt" shown={false}><p>PAGE</p></NativeGate>)
    expect(off).not.toContain('PAGE')
    expect(off).toContain('agentop experimental enable')
    expect(off).toContain('experimentais')
    expect(renderToStaticMarkup(<NativeGate lang="en" shown={false}><p>PAGE</p></NativeGate>)).toContain('experimental')
    expect(renderToStaticMarkup(<NativeGate lang="en" shown={null} fallback={<i>wait</i>}><p>PAGE</p></NativeGate>)).toBe('<i>wait</i>')
    expect(renderToStaticMarkup(<NativeGate lang="en" shown><p>PAGE</p></NativeGate>)).toBe('<p>PAGE</p>')
  })
})

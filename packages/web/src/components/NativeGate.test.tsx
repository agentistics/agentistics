import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { NativeGate } from './NativeGate'

describe('NativeGate — a native route is unavailable', () => {
  test('off: the notice names development and unavailability, never a page or command; unknown: the fallback; on: the page', () => {
    const off = renderToStaticMarkup(<NativeGate lang="pt" shown={false}><p>PAGE</p></NativeGate>)
    expect(off).not.toContain('PAGE')
    expect(off).toContain('não está disponível nesta versão')
    expect(off).not.toContain('agentop')
    expect(renderToStaticMarkup(<NativeGate lang="en" shown={false}><p>PAGE</p></NativeGate>)).toContain('not available in this version')
    expect(renderToStaticMarkup(<NativeGate lang="en" shown={null} fallback={<i>wait</i>}><p>PAGE</p></NativeGate>)).toBe('<i>wait</i>')
    expect(renderToStaticMarkup(<NativeGate lang="en" shown><p>PAGE</p></NativeGate>)).toBe('<p>PAGE</p>')
  })
})

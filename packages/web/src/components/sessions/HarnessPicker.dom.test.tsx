/**
 * HARNESS.PICKER-VOLTA in a real DOM (happy-dom): the new-session picker is the card grid again
 * (no table); installed harnesses are selectable cards, every OTHER compatible harness is a dimmed
 * card with an Install affordance (or "How to install" when there is no integrated installer).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement } from 'react'

let createRoot: typeof import('react-dom/client').createRoot
let mod: typeof import('./HarnessPicker')

beforeAll(async () => {
  GlobalRegistrator.register({ width: 1200, height: 800 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as never
  createRoot = (await import('react-dom/client')).createRoot
  mod = await import('./HarnessPicker')
})
afterAll(async () => { await GlobalRegistrator.unregister() })

describe('HarnessPicker + withMissingHarnesses', () => {
  test('installed cards select, missing ones are dimmed with Install, no table', async () => {
    const list = mod.withMissingHarnesses(
      [{ id: 'claude', label: 'Claude Code', installed: true }],
      [
        { id: 'claude', label: 'Claude Code', installed: true },
        { id: 'codex', label: 'Codex', installed: false, canInstall: true },
        { id: 'gemini', label: 'Gemini', installed: false, canInstall: false, setup: { docUrl: 'https://example.com/gemini' } },
      ],
    )
    expect(list?.map(h => h.id)).toEqual(['claude', 'codex', 'gemini'])
    const picked: string[] = []
    const installs: string[] = []
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(createElement(mod.HarnessPicker, { lang: 'en', harnesses: list, value: '', onChange: id => picked.push(id), onInstall: id => installs.push(id) }))
    })
    expect(host.querySelector('table, [data-harness-catalog]')).toBeNull()
    const claude = host.querySelector('[data-harness-card="claude"]') as HTMLElement
    const codex = host.querySelector('[data-harness-card="codex"]') as HTMLElement
    const gemini = host.querySelector('[data-harness-card="gemini"]') as HTMLAnchorElement
    expect(claude.style.opacity).toBe('1')
    expect(codex.style.opacity).not.toBe('1')
    expect(codex.textContent).toContain('Install')
    expect(gemini.tagName).toBe('A')
    expect(gemini.textContent).toContain('How to install')
    await act(async () => { claude.click(); codex.click() })
    expect(picked).toEqual(['claude'])
    expect(installs).toEqual(['codex'])
    await act(async () => { root.unmount() })
  })
})

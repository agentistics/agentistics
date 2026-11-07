/**
 * The right-click pop of the Nay button, in a real DOM (happy-dom): the "call Nay" button sits to the LEFT of
 * the vault icon, wears the same round style, is absent when there is no voice call to place, starts the call
 * through the callback it is given, and sinks with Escape like the vault does.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement } from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let createRoot: typeof import('react-dom/client').createRoot
let mod: typeof import('./VaultFabPop')
const roots: Array<{ unmount(): void }> = []

beforeAll(async () => {
  GlobalRegistrator.register({ width: 1280, height: 800 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as never
  createRoot = (await import('react-dom/client')).createRoot
  mod = await import('./VaultFabPop')
})
afterAll(async () => { await act(async () => { for (const r of roots) r.unmount() }); await GlobalRegistrator.unregister() })

async function mount(call: import('./VaultFabPop').FabCallButton | null, lang: 'pt' | 'en' = 'pt') {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  roots.push(root)
  await act(async () => { root.render(createElement(mod.VaultFabPop, { lang, isMobile: false, suppressed: false, call, children: createElement('button', { 'data-fab': true }, 'Nay') })) })
  return host
}
const rightClick = (host: HTMLElement) => act(async () => { host.querySelector('[data-vault-fab]')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })) })
const margin = (el: Element) => parseFloat((el as HTMLElement).style.marginLeft)

describe('the Nay button pop — Call Nay', () => {
  test('with a voice call: both icons rise, the call one to the LEFT of the vault, same round style', async () => {
    let pressed = 0
    const host = await mount({ label: 'Ligar para a Nay', active: false, onPress: () => { pressed++ } })
    expect(host.querySelector('[data-nay-call-fab]')).toBeNull() // nothing before the right click
    await rightClick(host)
    const callBtn = host.querySelector('[data-nay-call-fab]') as HTMLButtonElement
    const vault = host.querySelector('[data-vault-fab-icon]') as HTMLButtonElement
    expect(callBtn).not.toBeNull()
    expect(vault).not.toBeNull()
    expect(callBtn.getAttribute('aria-label')).toBe('Ligar para a Nay')
    expect(callBtn.title).toBe('Ligar para a Nay')
    expect(callBtn.disabled).toBe(false)
    // Same button as the vault's: size, radius, border, shadow, and the same row.
    for (const prop of ['width', 'height', 'borderRadius', 'bottom', 'boxShadow', 'position'] as const) {
      expect(callBtn.style[prop]).toBe(vault.style[prop])
    }
    expect(callBtn.style.border).toBe(vault.style.border)
    // Left of the vault: it ends before the vault begins.
    expect(margin(callBtn) + parseFloat(callBtn.style.width)).toBeLessThanOrEqual(margin(vault))
    expect(margin(callBtn)).toBeLessThan(margin(vault))
    await act(async () => { callBtn.click() })
    expect(pressed).toBe(1)
    expect(host.querySelector('[data-nay-call-fab]')?.getAttribute('data-phase')).toBe('leaving') // the pop sinks after the press
  })

  test('during a call the button is the filled "back to the call" face', async () => {
    const host = await mount({ label: 'Voltar à ligação', active: true, onPress: () => {} })
    await rightClick(host)
    const callBtn = host.querySelector('[data-nay-call-fab]') as HTMLButtonElement
    expect(callBtn.getAttribute('data-active')).toBe('true')
    expect(callBtn.getAttribute('aria-label')).toBe('Voltar à ligação')
  })

  test('no voice call to place: the pop has the vault icon alone', async () => {
    const host = await mount(null)
    await rightClick(host)
    expect(host.querySelector('[data-vault-fab-icon]')).not.toBeNull()
    expect(host.querySelector('[data-nay-call-fab]')).toBeNull()
  })

  test('Escape sinks the call button together with the vault icon', async () => {
    const host = await mount({ label: 'Call Nay', active: false, onPress: () => {} }, 'en')
    await rightClick(host)
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
    expect(host.querySelector('[data-nay-call-fab]')?.getAttribute('data-phase')).toBe('leaving')
    expect(host.querySelector('[data-vault-fab-icon]')?.getAttribute('data-phase')).toBe('leaving')
    expect((host.querySelector('[data-nay-call-fab]') as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('NayDock wiring', () => {
  const src = readFileSync(join(import.meta.dir, 'NayDock.tsx'), 'utf8')
  test('the pop gets a call button only when the engine announced the voice surface, and it uses the host opener', () => {
    expect(src).toContain('call={callSurface ? {')
    expect(src).toContain(': null}')
    expect(src).toContain('openEngineSurface(callSurface, { sessionId: sid, sessionKind: \'nay\', lang })')
    // No voice logic of its own: no microphone, no audio, no websocket.
    expect(src).not.toMatch(/getUserMedia|RTCPeerConnection|new WebSocket/)
  })
  test('an agent start request presses the button for an idle OR a parked call, never for one already on screen', () => {
    expect(src).toContain('() => { if (!callState.active || callState.parked) void placeCall() }')
  })
})

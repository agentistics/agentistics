/**
 * The two things that rise from the Nay button never stand open together (re-QA N2), in a real DOM (happy-dom):
 * the hover "Minimizadas" list and the right-click pop. Both are the REAL components, wired through the same
 * `useFabMenusExclusion` hook NayDock uses.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement } from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let createRoot: typeof import('react-dom/client').createRoot
let pop: typeof import('./VaultFabPop')
let menu: typeof import('./MinimizedMenu')
let hook: typeof import('../../lib/nayFabMenus')
const roots: Array<{ unmount(): void }> = []

beforeAll(async () => {
  GlobalRegistrator.register({ width: 1280, height: 800 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as never
  createRoot = (await import('react-dom/client')).createRoot
  pop = await import('./VaultFabPop')
  menu = await import('./MinimizedMenu')
  hook = await import('../../lib/nayFabMenus')
})
afterAll(async () => { await act(async () => { for (const r of roots) r.unmount() }); await GlobalRegistrator.unregister() })

function Both() {
  const x = hook.useFabMenusExclusion()
  return createElement(pop.VaultFabPop, {
    lang: 'pt', isMobile: false, suppressed: false, ...x.pop,
    call: { label: 'Ligar para a Nay', active: false, onPress: () => {} },
    children: createElement(menu.MinimizedMenu, {
      ...x.menu, pt: true, longPress: false, items: [], anchorStyle: { position: 'relative', width: 56, height: 56 },
      surfaceItems: [{ id: '1', label: 'Voltar à ligação', onResume() {}, endLabel: 'Encerrar', onEnd() {} }],
      onRestore() {}, onClose() {}, renderButton: ({ onClickCapture, onKeyDown }) => createElement('button', { 'data-fab': true, onClickCapture, onKeyDown }, 'Nay'),
    }),
  })
}

async function mount() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  roots.push(root)
  await act(async () => { root.render(createElement(Both)) })
  return host
}
const sleep = (ms: number) => act(async () => { await new Promise(r => setTimeout(r, ms)) })
const hover = (host: HTMLElement) => act(async () => {
  host.querySelector('[data-fab]')!.parentElement!.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }))
  host.querySelector('[data-fab]')!.parentElement!.dispatchEvent(new PointerEvent('pointerenter', { bubbles: false, pointerType: 'mouse' }))
})
const rightClick = (host: HTMLElement) => act(async () => { host.querySelector('[data-fab]')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })) })
const listOpen = (h: HTMLElement) => h.querySelector('[role="menu"]') !== null
const popShown = (h: HTMLElement) => h.querySelector('[data-vault-fab-icon]')?.getAttribute('data-phase') === 'shown'

describe('Nay button: the hover list and the right-click pop are never open together', () => {
  test('hover opens the list; right-click then closes it and shows the pop', async () => {
    const host = await mount()
    await hover(host); await sleep(200)
    expect(listOpen(host)).toBe(true)
    expect(popShown(host)).toBe(false)
    await rightClick(host)
    expect(popShown(host)).toBe(true)
    expect(listOpen(host)).toBe(false)
  })

  test('with the pop up, opening the list (badge / hover) sinks the pop', async () => {
    const host = await mount()
    await rightClick(host)
    expect(popShown(host)).toBe(true)
    expect(listOpen(host)).toBe(false)
    await hover(host); await sleep(200)
    expect(listOpen(host)).toBe(true)
    expect(host.querySelector('[data-vault-fab-icon]')?.getAttribute('data-phase')).toBe('leaving')
    expect(popShown(host)).toBe(false)
  })

  test('NayDock wires both through the one hook', () => {
    const src = readFileSync(join(import.meta.dir, 'NayDock.tsx'), 'utf8')
    expect(src).toContain('const fabMenus = useFabMenusExclusion()')
    expect(src).toContain('{...fabMenus.pop}')
    expect(src).toContain('{...fabMenus.menu}')
  })
})

import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'

let createRoot: typeof import('react-dom/client').createRoot
let LeaveChangesDialog: typeof import('./LeaveChangesDialog').LeaveChangesDialog
let host: HTMLDivElement
let root: Root

beforeAll(async () => {
  GlobalRegistrator.register({ width: 1280, height: 800 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as never
  createRoot = (await import('react-dom/client')).createRoot
  LeaveChangesDialog = (await import('./LeaveChangesDialog')).LeaveChangesDialog
})
afterAll(async () => { await GlobalRegistrator.unregister() })
afterEach(async () => { await act(async () => { root.unmount() }); host.remove() })

async function mount(width: number) {
  ;(window as { innerWidth: number }).innerWidth = width
  host = document.createElement('div'); document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root.render(createElement(LeaveChangesDialog, {
      open: true, lang: 'pt', who: 'Claude Code · Pessoal', changes: ['Sábado entrou na agenda'],
      onKeep() {}, onDiscard() {}, onSave() {},
    }))
  })
  const panel = document.querySelector('[data-leave-changes]')!.closest('[role="dialog"]') as HTMLElement
  return { panel, backdrop: panel.parentElement as HTMLElement }
}

test('at 1280 the dialog sits at the TOP of the screen (prototype r3), not centred vertically', async () => {
  const { panel, backdrop } = await mount(1280)
  expect(panel.getAttribute('data-confirm-placement')).toBe('top')
  expect(backdrop.style.alignItems).toBe('flex-start')
  expect(backdrop.style.justifyContent).toBe('center') // still centred horizontally
})

test('at 390 it is a bottom sheet and the placement option does not move it', async () => {
  const { panel, backdrop } = await mount(390)
  expect(panel.getAttribute('data-confirm-placement')).toBe('sheet')
  expect(backdrop.style.alignItems).toBe('flex-end')
})

test('at 390 the footer stacks Salvar ABOVE Descartar (column-reverse); at 1280 Descartar then Salvar in a row', async () => {
  const phone = await mount(390)
  const footerOf = (p: HTMLElement) => p.querySelector('[data-leave-discard]')!.parentElement as HTMLElement
  expect(footerOf(phone.panel).style.flexDirection).toBe('column-reverse')
  await act(async () => { root.unmount() }); host.remove()
  const desk = await mount(1280)
  expect(footerOf(desk.panel).style.flexDirection).toBe('row')
  const labels = Array.from(footerOf(desk.panel).querySelectorAll('button')).map(b => b.textContent)
  expect(labels).toEqual(['Descartar', 'Salvar'])
})

test('N4: the dialog is 440px wide at 1280, like the prototype', async () => {
  const { panel } = await mount(1280)
  expect(panel.style.maxWidth).toBe('440px')
})

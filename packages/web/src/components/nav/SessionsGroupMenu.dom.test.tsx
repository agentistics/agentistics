/** The view-options menu in a real DOM (happy-dom): Escape closes it, and the hidden-folders disclosure toggles. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'

let createRoot: typeof import('react-dom/client').createRoot
let SessionsGroupMenu: typeof import('./SessionsGroupMenu').SessionsGroupMenu

beforeAll(async () => {
  GlobalRegistrator.register({ width: 1000, height: 800 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as never
  createRoot = (await import('react-dom/client')).createRoot
  SessionsGroupMenu = (await import('./SessionsGroupMenu')).SessionsGroupMenu
})
afterAll(async () => { await new Promise(r => setTimeout(r, 50)); await GlobalRegistrator.unregister() })

let host: HTMLDivElement
let root: Root
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove() })

const shown: string[] = []
const mount = () => act(() => {
  root.render(createElement(SessionsGroupMenu, {
    lang: 'en', groupBy: 'project', onGroupBy: () => {}, groups: [], onReorder: () => {},
    cardColor: 'wash', onCardColor: () => {}, sort: { by: 'state', dir: 'desc' }, onSort: () => {},
    onCollapseAll: () => {}, onExpandAll: () => {},
    hiddenFolders: [{ id: 'f1', name: 'Old folder' }], onShowFolder: id => { shown.push(id) }, changed: 0,
  }))
})
const open = () => act(() => { (host.querySelector('button[aria-label="List view options"]') as HTMLButtonElement).click() })
const esc = () => act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })

describe('SessionsGroupMenu', () => {
  test('Escape closes the open menu', () => {
    mount(); open()
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull()
    esc()
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
  })

  test('hidden folders is a button disclosure, collapsed until opened', () => {
    mount(); open()
    const dialog = document.body.querySelector('[role="dialog"]')!
    expect(dialog.querySelector('details')).toBeNull()
    const toggle = Array.from(dialog.querySelectorAll('button[aria-expanded]')).find(b => b.textContent?.includes('Hidden folders')) as HTMLButtonElement
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(dialog.textContent).not.toContain('Old folder')
    act(() => { toggle.click() })
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(dialog.textContent).toContain('Old folder')
    act(() => { (dialog.querySelector('button[aria-label="Show folder Old folder"]') as HTMLButtonElement).click() })
    expect(shown).toEqual(['f1'])
  })
})

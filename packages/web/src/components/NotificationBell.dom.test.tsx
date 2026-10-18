import { afterAll, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'

let createRoot: typeof import('react-dom/client').createRoot
let MemoryRouter: typeof import('react-router-dom').MemoryRouter
let NotificationBell: typeof import('./NotificationBell').NotificationBell
let originalFetch: typeof fetch
let originalEventSource: typeof EventSource
let originalAct: boolean | undefined
beforeAll(async () => {
  originalFetch = globalThis.fetch
  originalEventSource = globalThis.EventSource
  originalAct = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT
  GlobalRegistrator.register({ width: 1280, height: 900 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  globalThis.EventSource = class { close() {} addEventListener() {} removeEventListener() {} } as never
  globalThis.fetch = (async () => Response.json({ notifications: [], rows: [] })) as unknown as typeof fetch
  createRoot = (await import('react-dom/client')).createRoot
  MemoryRouter = (await import('react-router-dom')).MemoryRouter
  NotificationBell = (await import('./NotificationBell')).NotificationBell
})
afterAll(async () => {
  await new Promise(resolve => setTimeout(resolve, 50))
  globalThis.fetch = originalFetch
  globalThis.EventSource = originalEventSource
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = originalAct
  await GlobalRegistrator.unregister()
})
for (const width of [1280, 390]) test(`title, clear and mute switch stay in a single sticky header (${width}px)`, async () => {
  (window as unknown as { happyDOM: { setViewport(v: { width: number; height: number }): void } }).happyDOM.setViewport({ width, height: 900 })
  window.matchMedia = ((q: string) => ({ matches: q.includes('max-width') && width < 768, addEventListener() {}, removeEventListener() {} })) as never
  const host = document.createElement('div'); document.body.appendChild(host)
  const root = createRoot(host)
  const { pushLocalNotification, clearNotifications } = await import('../lib/notifications')
  try {
    await act(async () => {
      for (let i = 0; i < 12; i++) pushLocalNotification({ type: 'info', title: `Notification ${i}`, message: 'A complete notification message' })
      root.render(<MemoryRouter><NotificationBell lang="pt" /></MemoryRouter>)
    })
    await act(async () => host.querySelector<HTMLButtonElement>('button[title="Notificações"]')!.click())
    const header = host.querySelector<HTMLElement>('[data-bell-sticky-header]')!
    expect(header.style.position).toBe('sticky')
    expect(header.style.top).toBe('0px')
    expect(header.style.zIndex).toBe('1')
    expect(header.textContent).toContain('Notificações')
    expect(header.textContent).toContain('Limpar tudo')
    expect(header.querySelector('[aria-label="Silenciar workers ativos"]')).not.toBeNull()
    const scroller = header.parentElement!
    expect(scroller.style.overflowY).toBe('auto')
    scroller.scrollTop = 200
    expect(header.parentElement).toBe(scroller)
    expect(header.textContent).toContain('Silenciar workers ativos')
    const toggle = header.querySelector<HTMLButtonElement>('[aria-label="Silenciar workers ativos"]')!
    const previous = toggle.getAttribute('aria-checked')
    await act(async () => toggle.click())
    expect(toggle.getAttribute('aria-checked')).not.toBe(previous)
  } finally {
    await act(async () => { root.unmount(); clearNotifications() })
    host.remove()
  }
})

test('completion supersedes its progress row and Escape closes the bell', async () => {
  const { pushLocalNotification, clearNotifications } = await import('../lib/notifications')
  const host = document.createElement('div'); document.body.appendChild(host)
  const root = createRoot(host)
  try {
    await act(async () => {
      pushLocalNotification({ type: 'info', code: 'clean.started' })
      pushLocalNotification({ type: 'success', code: 'clean.done', meta: { freed: '100 MB', worktrees: 2, nodeModules: 0 } })
      root.render(<MemoryRouter><NotificationBell lang="pt" /></MemoryRouter>)
    })
    await act(async () => host.querySelector<HTMLButtonElement>('button[title="Notificações"]')!.click())
    expect(host.textContent).toContain('Limpeza concluída')
    expect(host.textContent).not.toContain('Limpeza em andamento')
    expect(host.textContent).toContain('2 worktrees')
    expect(host.textContent).not.toContain('0 pasta')
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(host.querySelector('[data-bell-sticky-header]')).toBeNull()
  } finally {
    await act(async () => { root.unmount(); clearNotifications() }); host.remove()
  }
})

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom'

let createRoot: typeof import('react-dom/client').createRoot
let HarnessesSettings: typeof import('../pages/settings/HarnessesSettings').default
const realFetch = globalThis.fetch
let oldAct: boolean | undefined
let posted: string[] = []
let removed = false

const row = (id: string, over: Record<string, unknown>) => ({ id, label: id, installed: true, canInstall: true, authReady: true, ready: true, models: [], defaultModel: '', setup: {}, ...over })

beforeAll(async () => {
  GlobalRegistrator.register({ width: 1280, height: 900 })
  oldAct = (globalThis as any).IS_REACT_ACT_ENVIRONMENT
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  // happy-dom rejects a cancelled animation with an unhandled AbortError; without `animate` the loader skips them.
  ;(Element.prototype as unknown as { animate: unknown }).animate = undefined
  createRoot = (await import('react-dom/client')).createRoot
  HarnessesSettings = (await import('../pages/settings/HarnessesSettings')).default
  globalThis.fetch = (async (url: string, init?: { method?: string }) => {
    if (url.startsWith('/api/chat-harnesses')) return Response.json([
      row('codex', {}),
      row('gemini', removed ? { installed: false, authReady: false, ready: false } : {}),
      row('copilot', { installed: false, authReady: false, ready: false }),
      row('kimi', { canInstall: false }),
    ])
    if (url.startsWith('/api/harnesses/gemini/uninstall')) {
      if (init?.method !== 'POST') return Response.json({ reason: 'ok', removes: ['/h/.local/bin/gemini'], keeps: ['~/.gemini'] })
      posted.push(url); removed = true
      return new Response('data: {"type":"done","message":"Uninstall complete."}\n\n')
    }
    return Response.json(null)
  }) as unknown as typeof fetch
})
afterAll(async () => { await new Promise(r => setTimeout(r, 50)); globalThis.fetch = realFetch; (globalThis as any).IS_REACT_ACT_ENVIRONMENT = oldAct; await GlobalRegistrator.unregister() })

const settle = () => act(async () => { await new Promise(r => setTimeout(r, 20)) })

test('Uninstall appears only for installed harnesses that have an installer, and removes only after confirming', async () => {
  const host = document.createElement('div'); document.body.appendChild(host); const root = createRoot(host)
  await act(async () => root.render(
    <MemoryRouter>
      <Routes><Route element={<Outlet context={{ lang: 'en' }} />}><Route path="/" element={<HarnessesSettings />} /></Route></Routes>
    </MemoryRouter>,
  ))
  await settle()
  const labels = () => Array.from(host.querySelectorAll('[data-harness-uninstall]')).map(b => b.getAttribute('aria-label'))
  expect(labels()).toEqual(['Uninstall codex', 'Uninstall gemini'])

  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Uninstall gemini"]')!.click())
  await settle()
  expect(host.textContent).toContain('Your sessions, settings and sign-in are kept.')
  expect(host.querySelector('[data-testid="harness-uninstall-plan"]')!.textContent).toContain('~/.gemini')
  expect(posted).toEqual([])

  const confirm = Array.from(host.querySelectorAll<HTMLButtonElement>('[data-dialog-footer] button')).find(b => b.textContent === 'Uninstall')!
  await act(async () => confirm.click())
  await settle(); await settle()
  expect(posted).toHaveLength(1)
  expect(host.textContent).toContain('Uninstalled')
  expect(labels()).toEqual(['Uninstall codex'])
  await act(async () => root.unmount()); host.remove()
})

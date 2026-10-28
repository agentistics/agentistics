import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'

let createRoot: typeof import('react-dom/client').createRoot
let HarnessInstallDialog: typeof import('./HarnessInstallDialog').HarnessInstallDialog
const realFetch = globalThis.fetch
let oldAct: boolean | undefined
let authReady = false
let loginAnswer: { ok: boolean; id?: string; message?: string } = { ok: true, id: 's1' }
let loginCalls: string[] = []

beforeAll(async () => {
  GlobalRegistrator.register({ width: 1280, height: 900 })
  oldAct = (globalThis as any).IS_REACT_ACT_ENVIRONMENT
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  createRoot = (await import('react-dom/client')).createRoot
  HarnessInstallDialog = (await import('./HarnessInstallDialog')).HarnessInstallDialog
})
afterAll(async () => { await new Promise(r => setTimeout(r, 50)); globalThis.fetch = realFetch; (globalThis as any).IS_REACT_ACT_ENVIRONMENT = oldAct; await GlobalRegistrator.unregister() })
beforeEach(() => {
  loginCalls = []
  globalThis.fetch = (async (url: string, init?: { body?: string }) => {
    if (url.includes('/install')) return new Response('data: {"type":"done","version":"1.0"}\n\n')
    if (url.startsWith('/api/chat-harnesses')) return Response.json([{ id: 'codex', label: 'Codex', installed: true, authReady, ready: authReady, models: [], defaultModel: '', setup: {} }])
    if (url.startsWith('/api/fleet/harness-login')) { loginCalls.push(init?.body ?? ''); return Response.json(loginAnswer) }
    return Response.json(null)
  }) as unknown as typeof fetch
})

async function install(lang: 'pt' | 'en', signed: string[], closed: string[]) {
  const host = document.createElement('div'); document.body.appendChild(host); const root = createRoot(host)
  await act(async () => { root.render(<HarnessInstallDialog target={{ id: 'codex', label: 'Codex' }} pt={lang === 'pt'} onClose={() => closed.push('x')} onDone={() => {}} onSignedIn={id => signed.push(id)} />) })
  const button = (label: string) => Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(b => b.textContent === label)
  await act(async () => button(lang === 'pt' ? 'Instalar' : 'Install')!.click())
  await act(async () => { await new Promise(r => setTimeout(r, 20)) })
  return { host, button, cleanup: async () => { await act(async () => root.unmount()); host.remove() } }
}

for (const lang of ['pt', 'en'] as const) {
  test(`installed without login offers sign-in and calls loginHarness (${lang})`, async () => {
    authReady = false; loginAnswer = { ok: true, id: 's1' }
    const signed: string[] = []; const closed: string[] = []
    const { button, cleanup } = await install(lang, signed, closed)
    expect(button(lang === 'pt' ? 'Entrar agora' : 'Sign in now')).toBeTruthy()
    expect(button(lang === 'pt' ? 'Depois' : 'Later')).toBeTruthy()
    await act(async () => button(lang === 'pt' ? 'Entrar agora' : 'Sign in now')!.click())
    expect(loginCalls).toHaveLength(1); expect(loginCalls[0]).toContain('codex')
    expect(signed).toEqual(['s1']); expect(closed).toHaveLength(1)
    await cleanup()
  })
  test(`installed with login keeps the plain done state (${lang})`, async () => {
    authReady = true
    const { host, button, cleanup } = await install(lang, [], [])
    expect(button(lang === 'pt' ? 'Entrar agora' : 'Sign in now')).toBeUndefined()
    expect(host.textContent).toContain(lang === 'pt' ? 'Pronto!' : 'Done!')
    await cleanup()
  })
  test(`a failed sign-in shows its message and stays open (${lang})`, async () => {
    authReady = false; loginAnswer = { ok: false, message: 'boom-login' }
    const signed: string[] = []; const closed: string[] = []
    const { host, button, cleanup } = await install(lang, signed, closed)
    await act(async () => button(lang === 'pt' ? 'Entrar agora' : 'Sign in now')!.click())
    expect(host.textContent).toContain('boom-login')
    expect(signed).toHaveLength(0); expect(closed).toHaveLength(0)
    expect(button(lang === 'pt' ? 'Entrar agora' : 'Sign in now')).toBeTruthy()
    await cleanup()
  })
}

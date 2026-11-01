import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'

let createRoot: typeof import('react-dom/client').createRoot
let HarnessInstallDialog: typeof import('./HarnessInstallDialog').HarnessInstallDialog
const realFetch = globalThis.fetch
let oldAct: boolean | undefined
let authReady = false
let loginCalls: string[] = []
let accountSignInStore: typeof import('../lib/accountSignIn').accountSignInStore

beforeAll(async () => {
  GlobalRegistrator.register({ width: 1280, height: 900 })
  oldAct = (globalThis as any).IS_REACT_ACT_ENVIRONMENT
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  createRoot = (await import('react-dom/client')).createRoot
  HarnessInstallDialog = (await import('./HarnessInstallDialog')).HarnessInstallDialog
  accountSignInStore = (await import('../lib/accountSignIn')).accountSignInStore
})
afterAll(async () => { await new Promise(r => setTimeout(r, 50)); globalThis.fetch = realFetch; (globalThis as any).IS_REACT_ACT_ENVIRONMENT = oldAct; await GlobalRegistrator.unregister() })
beforeEach(() => {
  loginCalls = []
  globalThis.fetch = (async (url: string, init?: { body?: string }) => {
    if (url.includes('/install')) return new Response('data: {"type":"progress","message":"Verificando a versão…"}\n\ndata: {"type":"done","version":"1.0"}\n\n')
    if (url.startsWith('/api/chat-harnesses')) return Response.json([{ id: 'codex', label: 'Codex', installed: true, authReady, ready: authReady, models: [], defaultModel: '', setup: {} }])
    if (url.startsWith('/api/fleet')) { loginCalls.push(url + (init?.body ?? '')); return Response.json({ ok: true, id: 's1' }) }
    return Response.json(null)
  }) as unknown as typeof fetch
})

async function install(lang: 'pt' | 'en', signed: string[], closed: string[]) {
  const host = document.createElement('div'); document.body.appendChild(host); const root = createRoot(host)
  await act(async () => { root.render(<HarnessInstallDialog target={{ id: 'codex', label: 'Codex' }} pt={lang === 'pt'} onClose={() => closed.push('x')} onDone={() => {}} onSignIn={() => signed.push('sign-in')} />) })
  const button = (label: string) => Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(b => b.textContent === label)
  await act(async () => button(lang === 'pt' ? 'Instalar' : 'Install')!.click())
  await act(async () => { await new Promise(r => setTimeout(r, 20)) })
  return { host, button, cleanup: async () => { await act(async () => root.unmount()); host.remove() } }
}

for (const lang of ['pt', 'en'] as const) {
  test(`CONTAS.LOGIN r4: "Sign in now" asks for the account sign-in dialog and never starts a session (${lang})`, async () => {
    authReady = false
    const signed: string[] = []; const closed: string[] = []
    const { button, cleanup } = await install(lang, signed, closed)
    expect(button(lang === 'pt' ? 'Depois' : 'Later')).toBeTruthy()
    await act(async () => button(lang === 'pt' ? 'Entrar agora' : 'Sign in now')!.click())
    expect(loginCalls).toEqual([])
    expect(accountSignInStore.get()?.harness).toBe('codex')
    expect(signed).toEqual(['sign-in']); expect(closed).toHaveLength(1)
    accountSignInStore.take(accountSignInStore.get()!.nonce)
    await cleanup()
  })
  test(`installed with login keeps the plain done state (${lang})`, async () => {
    authReady = true
    const { host, button, cleanup } = await install(lang, [], [])
    expect(button(lang === 'pt' ? 'Entrar agora' : 'Sign in now')).toBeUndefined()
    expect(host.textContent).toContain(lang === 'pt' ? 'Pronto!' : 'Done!')
    // QA F4 (OPENCODE.CORREÇÕES): the installer's last progress line does not stand beside "Done".
    expect(host.textContent).not.toContain('Verificando a versão')
    await cleanup()
  })
}

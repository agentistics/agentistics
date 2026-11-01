/**
 * HOTFIX.LOGIN-EXPIRADO in a real DOM (happy-dom): the bar above the composer appears when the
 * session's account cannot work, offers "Sign in again" + "Switch account", has NO dismiss, and is
 * absent when the account works or the session moved to another account.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement } from 'react'
import type { SwitchInfo } from '../../lib/accountSwitch'

let createRoot: typeof import('react-dom/client').createRoot
let mod: typeof import('./AccountSwitch')
let originalFetch: typeof globalThis.fetch
let getBody: SwitchInfo
const reloginPosts: string[] = []

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } })

beforeAll(async () => {
  originalFetch = globalThis.fetch
  GlobalRegistrator.register({ width: 1280, height: 800 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as never
  ;(globalThis as { EventSource?: unknown }).EventSource = class { addEventListener() {} removeEventListener() {} close() {} }
  ;(globalThis as { fetch?: unknown }).fetch = async (url: string, init?: RequestInit) => {
    const u = String(url)
    if (u.startsWith('/api/accounts/roots/relogin/') && init?.method === 'POST') {
      reloginPosts.push(u)
      return json({ ok: true, pendingId: 'l_1', kind: 'paste', url: 'https://claude.ai/oauth/authorize?x=1', expiresAt: Date.now() + 600_000 })
    }
    if (u.startsWith('/api/accounts/roots/relogin/')) return json({ status: 'pending', accountId: 'acc_nay' })
    if (u.startsWith('/api/fleet/switch-account')) return json(getBody)
    return json({})
  }
  createRoot = (await import('react-dom/client')).createRoot
  mod = await import('./AccountSwitch')
})
afterAll(async () => {
  globalThis.fetch = originalFetch
  await GlobalRegistrator.unregister()
})

const base: SwitchInfo = {
  ok: true, supported: true, current: { id: 'acc_nay', label: 'Nayara', harness: 'claude' },
  options: [{ id: 'acc_main', harness: 'claude', label: 'Principal' }], limit: null, auth: null,
}

async function mount() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(createElement(mod.AccountLoginBand, { sessionId: 'm1', lang: 'pt', onSwitched: () => {} })) })
  await act(async () => { await new Promise(r => setTimeout(r, 20)) })
  return { host, root }
}
const band = () => document.querySelector('[data-account-login-band]') as HTMLElement

describe('AccountLoginBand', () => {
  test('expired account: plain words, "Refazer login" + "Trocar de conta", and no dismiss', async () => {
    getBody = { ...base, auth: { accountId: 'acc_nay', label: 'Nayara', state: 'expired', relogin: true, pending: 'faça X' } }
    const { root } = await mount()
    expect(band().getAttribute('data-account-login-band')).toBe('blocked')
    expect(band().className).toContain('visible')
    expect(band().textContent).toContain('O login da conta Nayara expirou')
    expect(band().querySelector('[data-account-relogin]')?.textContent).toBe('Refazer login')
    expect(band().querySelector('[data-account-login-switch]')?.textContent).toBe('Trocar de conta')
    expect(band().querySelector('[aria-label="Dispensar"]')).toBeNull()
    // "Refazer login" opens the Add-account steps for THIS account (link + code field), never a terminal.
    await act(async () => { (band().querySelector('[data-account-relogin]') as HTMLButtonElement).click() })
    await act(async () => { await new Promise(r => setTimeout(r, 30)) })
    expect(reloginPosts).toEqual(['/api/accounts/roots/relogin/acc_nay'])
    expect(document.querySelector('[data-login-url]')?.getAttribute('href')).toContain('claude.ai/oauth/authorize')
    await act(async () => { root.unmount() })
    document.body.innerHTML = ''
  })

  test('absent while the account works', async () => {
    getBody = { ...base, auth: null }
    const { root } = await mount()
    expect(band().getAttribute('data-account-login-band')).toBe('none')
    expect(band().className).not.toContain('visible')
    await act(async () => { root.unmount() })
    document.body.innerHTML = ''
  })

  test('absent once the session moved to another account', async () => {
    getBody = { ...base, current: { id: 'acc_main', label: 'Principal', harness: 'claude' }, auth: { accountId: 'acc_nay', state: 'expired', relogin: true } }
    const { root } = await mount()
    expect(band().getAttribute('data-account-login-band')).toBe('none')
    await act(async () => { root.unmount() })
    document.body.innerHTML = ''
  })

  test('an assistant that cannot sign in from here says so and still offers the switch', async () => {
    getBody = { ...base, auth: { accountId: 'acc_nay', label: 'Nayara', state: 'signed_out', relogin: false } }
    const { root } = await mount()
    expect(band().textContent).toContain('A conta Nayara não está conectada')
    expect(band().querySelector('[data-account-relogin]')).toBeNull()
    expect(band().querySelector('[data-account-login-switch]')).not.toBeNull()
    await act(async () => { root.unmount() })
    document.body.innerHTML = ''
  })
})

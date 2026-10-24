/**
 * CONTA.TROCA in a real DOM (happy-dom): the limit notice appears only with somewhere to go, the
 * dialog posts the chosen account and the re-send flag ONCE, and the new id is followed.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement } from 'react'
import type { SwitchInfo } from '../../lib/accountSwitch'

let createRoot: typeof import('react-dom/client').createRoot
let mod: typeof import('./AccountSwitch')
let lib: typeof import('../../lib/accountSwitch')
let originalFetch: typeof globalThis.fetch
const posts: unknown[] = []
let getBody: SwitchInfo

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } })

beforeAll(async () => {
  originalFetch = globalThis.fetch
  GlobalRegistrator.register({ width: 1200, height: 800 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as never
  ;(globalThis as { fetch?: unknown }).fetch = async (url: string, init?: RequestInit) => {
    if (String(url).startsWith('/api/fleet/switch-account') && init?.method === 'POST') {
      posts.push(JSON.parse(String(init.body)))
      return json({ ok: true, message: 'Session continued on the other account.', id: 'm2' })
    }
    if (String(url).startsWith('/api/fleet/switch-account')) return json(getBody)
    return json({})
  }
  createRoot = (await import('react-dom/client')).createRoot
  mod = await import('./AccountSwitch')
  lib = await import('../../lib/accountSwitch')
})
afterAll(async () => {
  globalThis.fetch = originalFetch
  await GlobalRegistrator.unregister()
})

const limited: SwitchInfo = {
  ok: true, supported: true, current: { id: 'acc_a', label: 'a@x.com' },
  options: [{ id: 'acc_b', label: 'b@x.com', recommended: true }, { id: 'acc_c', label: 'c@x.com' }],
  limit: { resetsAt: Date.now() + 3_600_000, pendingPreview: 'fix the bug' },
}

async function mount(el: ReturnType<typeof createElement>) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(el) })
  await act(async () => { await new Promise(r => setTimeout(r, 20)) })
  return { host, root }
}

describe('lib/accountSwitch', () => {
  test('notice and menu only with somewhere to go', () => {
    expect(lib.showLimitNotice(limited)).toBe(true)
    expect(lib.showLimitNotice({ ...limited, options: [] })).toBe(false)
    expect(lib.showLimitNotice({ ...limited, limit: null })).toBe(false)
    expect(lib.showLimitNotice({ ...limited, supported: false })).toBe(false)
    expect(lib.canSwitch({ ...limited, limit: null })).toBe(true)
    expect(lib.canSwitch(null)).toBe(false)
  })
  test('the router pick is the default target; the title names a single option', () => {
    expect(lib.defaultTarget(limited.options)).toBe('acc_b')
    expect(lib.noticeTitle({ ...limited, options: [limited.options[1]!] }, true)).toBe('Esta conta bateu o limite — continuar na c@x.com?')
    expect(lib.noticeTitle(limited, false)).toBe('This account hit its limit — continue on another account?')
  })
})

describe('AccountLimitBand', () => {
  test('hidden without a limit', async () => {
    getBody = { ...limited, limit: null }
    const { host, root } = await mount(createElement(mod.AccountLimitBand, { sessionId: 'm1', lang: 'en', onSwitched: () => {} }))
    expect(host.querySelector('[data-account-limit-band]')?.className).not.toContain('visible')
    await act(async () => { root.unmount() })
  })

  test('visible on a limit; the dialog posts the pick with the re-send flag, once, and follows the new id', async () => {
    getBody = limited
    posts.length = 0
    let followed = ''
    const { host, root } = await mount(createElement(mod.AccountLimitBand, { sessionId: 'm1', lang: 'pt', onSwitched: (id: string) => { followed = id } }))
    const band = host.querySelector('[data-account-limit-band]')!
    expect(band.className).toContain('visible')
    expect(band.textContent).toContain('Esta conta bateu o limite')
    const open = Array.from(band.querySelectorAll('button')).find(b => b.textContent?.includes('Continuar na outra conta'))!
    await act(async () => { open.click() })
    const dialog = document.querySelector('[data-account-switch]')!
    expect(dialog.textContent).toContain('fix the bug')
    const confirm = Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Trocar conta')!
    await act(async () => { confirm.click(); await new Promise(r => setTimeout(r, 20)) })
    expect(posts).toEqual([{ id: 'm1', accountId: 'acc_b', resendPending: true }])
    expect(followed).toBe('m2')
    await act(async () => { root.unmount() })
  })
})

describe('AccountLimitBand dismissal', () => {
  test('the X is remembered for this limit after the session is opened again', async () => {
    getBody = limited
    localStorage.clear()
    const band = (h: HTMLElement) => h.querySelector('[data-account-limit-band]') as HTMLElement
    const first = await mount(createElement(mod.AccountLimitBand, { sessionId: 'mX', lang: 'pt', onSwitched: () => {} }))
    expect(band(first.host).classList.contains('visible')).toBe(true)
    const x = band(first.host).querySelector('button[aria-label="Dispensar"]') as HTMLButtonElement
    await act(async () => { x.click() })
    expect(band(first.host).classList.contains('visible')).toBe(false)
    await act(async () => { first.root.unmount() })
    const again = await mount(createElement(mod.AccountLimitBand, { sessionId: 'mX', lang: 'pt', onSwitched: () => {} }))
    expect(band(again.host).classList.contains('visible')).toBe(false)
    // A NEW limit (another reset time) shows again.
    getBody = { ...limited, limit: { ...limited.limit!, resetsAt: limited.limit!.resetsAt! + 60_000 } }
    const next = await mount(createElement(mod.AccountLimitBand, { sessionId: 'mX', lang: 'pt', onSwitched: () => {} }))
    expect(band(next.host).classList.contains('visible')).toBe(true)
  })
})

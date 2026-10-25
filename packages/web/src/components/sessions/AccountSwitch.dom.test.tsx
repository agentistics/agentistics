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
const acts: unknown[] = []
let getBody: SwitchInfo
let postReply: unknown = { ok: true, message: 'Session continued on the other account.', id: 'm2' }

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } })

beforeAll(async () => {
  originalFetch = globalThis.fetch
  GlobalRegistrator.register({ width: 1200, height: 800 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as never
  // The plan-limits store follows the shared SSE stream; nothing streams here.
  ;(globalThis as { EventSource?: unknown }).EventSource = class { addEventListener() {} removeEventListener() {} close() {} }
  ;(globalThis as { fetch?: unknown }).fetch = async (url: string, init?: RequestInit) => {
    if (String(url).startsWith('/api/fleet/switch-account') && init?.method === 'POST') {
      posts.push(JSON.parse(String(init.body)))
      return json(postReply)
    }
    if (String(url).startsWith('/api/fleet/switch-account')) return json(getBody)
    if (String(url).startsWith('/api/fleet/act')) { acts.push(JSON.parse(String(init?.body))); return json({ ok: true, message: 'reopened', id: 'm9' }) }
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
  ok: true, supported: true, current: { id: 'acc_a', label: 'a@x.com', harness: 'claude' },
  options: [{ id: 'acc_b', harness: 'claude', label: 'b@x.com', recommended: true }, { id: 'acc_c', harness: 'claude', label: 'c@x.com' }],
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
    const confirm = Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Confirmar troca')!
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
    await act(async () => { again.root.unmount() })
    // A NEW limit (another reset time) shows again.
    getBody = { ...limited, limit: { ...limited.limit!, resetsAt: limited.limit!.resetsAt! + 60_000 } }
    const next = await mount(createElement(mod.AccountLimitBand, { sessionId: 'mX', lang: 'pt', onSwitched: () => {} }))
    expect(band(next.host).classList.contains('visible')).toBe(true)
    // Unmount: a mounted picker keeps the shared plan-limits store subscribed for later files.
    await act(async () => { next.root.unmount() })
  })
})

describe('AccountSwitchDialog — every harness (v2)', () => {
  const multi: SwitchInfo = {
    ...limited,
    options: [...limited.options, { id: 'acc_k', harness: 'codex', label: 'k@x.com', plan: 'Plus', recommended: true }, { id: 'acc_g', harness: 'gemini', label: 'g@x.com' }],
  }
  test('lists harnesses grouped (own first) and says what each means', () => {
    expect(lib.switchHarnesses(multi)).toEqual(['claude', 'codex', 'gemini'])
    expect(lib.switchHarnesses({ ...multi, options: multi.options.filter(o => o.harness !== 'claude') })).toEqual(['codex', 'gemini'])
    expect(lib.isHandoff(multi, 'codex')).toBe(true)
    expect(lib.isHandoff(multi, 'claude')).toBe(false)
    expect(lib.noticeTitle({ ...multi, options: [multi.options[2]!] }, true)).toBe('Esta conta bateu o limite — continuar na k@x.com (Codex CLI)?')
  })

  test('every account is a row: the current one marked and not pickable, the others pickable', async () => {
    const { root } = await mount(createElement(mod.AccountSwitchDialog, {
      open: true, sessionId: 'm1', info: { ...multi, options: [multi.options[0]!, multi.options[2]!] }, lang: 'pt', fromLimit: false, onClose: () => {}, onSwitched: () => {},
    }))
    const dialog = Array.from(document.querySelectorAll('[data-account-switch]')).at(-1)!
    const current = dialog.querySelector('[data-account-switch-current]')!
    expect(current.textContent).toContain('a@x.com')
    expect(current.textContent).toContain('Agora')
    expect(current.tagName).not.toBe('BUTTON')
    expect(dialog.querySelectorAll('[role="radio"]').length).toBe(2)
    await act(async () => { root.unmount() })
  })

  test('at 390 px the dialog footer sticks to the sheet floor; at 1200 it does not', async () => {
    const open = async () => mount(createElement(mod.AccountSwitchDialog, {
      open: true, sessionId: 'm1', info: multi, lang: 'en', fromLimit: false, onClose: () => {}, onSwitched: () => {},
    }))
    window.innerWidth = 390
    const narrow = await open()
    const footer = document.querySelector('[data-dialog-footer]') as HTMLElement
    expect(footer.style.position).toBe('sticky')
    expect(footer.style.bottom).toBe('0px')
    await act(async () => { narrow.root.unmount() })
    window.innerWidth = 1200
    const wide = await open()
    expect((document.querySelector('[data-dialog-footer]') as HTMLElement).style.position).toBe('')
    await act(async () => { wide.root.unmount() })
  })

  test('the Usage limits card is one component: plan list + the switch button, EN and PT', async () => {
    const card = await import('./SessionLimitsCard')
    for (const lang of ['en', 'pt'] as const) {
      getBody = limited
      const { host, root } = await mount(createElement(card.SessionLimitsCard, { sessionId: 'm1', lang, onSwitched: () => {}, onOpenAll: () => {} }))
      const summary = host.querySelector<HTMLElement>('[data-plan-usage-summary]')
      expect(summary).not.toBeNull()
      // The card already carries the "Usage limits" title: no second title, and the list fills the card.
      expect(host.querySelector('#plan-usage-summary-title')).toBeNull()
      expect(summary!.style.maxWidth).toBe('')
      expect(host.querySelector('[data-account-switch-open]')?.textContent).toContain(lang === 'pt' ? 'Trocar de conta' : 'Switch account')
      await act(async () => { root.unmount() })
    }
  })

  test('a handoff target changes the words and posts the harness', async () => {
    posts.length = 0
    const only = { ...multi, options: [multi.options[2]!] }
    const { root } = await mount(createElement(mod.AccountSwitchDialog, {
      open: true, sessionId: 'm1', info: only, lang: 'pt', fromLimit: false, onClose: () => {}, onSwitched: () => {},
    }))
    expect(document.body.textContent).toContain('conversa NOVA em Codex')
    const confirm = Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Continuar em Codex CLI')!
    await act(async () => { confirm.click(); await new Promise(r => setTimeout(r, 20)) })
    expect(posts).toEqual([{ id: 'm1', accountId: 'acc_k', harness: 'codex', resendPending: false }])
    await act(async () => { root.unmount() })
  })

  test('a poll that returns the same options as a NEW array keeps the person\'s pick', async () => {
    posts.length = 0
    const host = document.createElement('div'); document.body.appendChild(host)
    const root = createRoot(host)
    const props = (info: SwitchInfo) => ({ open: true, sessionId: 'm1', info, lang: 'pt', fromLimit: false, onClose: () => {}, onSwitched: () => {} })
    await act(async () => { root.render(createElement(mod.AccountSwitchDialog, props(multi))) })
    const dialog = () => Array.from(document.querySelectorAll('[data-account-switch]')).at(-1)!
    const codex = dialog().querySelector('[data-account-row="codex:acc_k"]') as HTMLButtonElement
    await act(async () => { codex.click() })
    expect(codex.getAttribute('aria-checked')).toBe('true')
    // The 15 s poll: equal content, new identity.
    await act(async () => { root.render(createElement(mod.AccountSwitchDialog, props({ ...multi, options: multi.options.map(o => ({ ...o })) }))) })
    expect((dialog().querySelector('[data-account-row="codex:acc_k"]') as HTMLElement).getAttribute('aria-checked')).toBe('true')
    expect(document.body.textContent).toContain('conversa NOVA em Codex')
    await act(async () => { root.unmount() })
  })
})

describe('AccountSwitchInline (the "Usage limits" card)', () => {
  const info: SwitchInfo = {
    ...limited, limit: null,
    options: [limited.options[0]!, { id: 'acc_k', harness: 'codex', label: 'k@x.com' }],
    unavailable: [{ id: 'acc_h', harness: 'claude', label: 'h@x.com', reason: 'not_agentic' }],
  }
  test('the button turns the list into the picker; disabled rows say why; confirm posts and follows', async () => {
    getBody = info
    posts.length = 0
    let followed = ''
    const { host, root } = await mount(createElement(mod.AccountSwitchInline, {
      sessionId: 'm1', lang: 'en', onSwitched: (id: string) => { followed = id }, children: createElement('p', { 'data-summary': '' }, 'summary'),
    }))
    expect(host.querySelector('[data-summary]')).not.toBeNull()
    const open = host.querySelector('[data-account-switch-open]') as HTMLButtonElement
    expect(open.textContent).toContain('Switch account in this session')
    await act(async () => { open.click() })
    expect(host.querySelector('[data-summary]')).toBeNull()
    const hidden = host.querySelector('[data-account-row="claude:acc_h"]')!
    expect(hidden.getAttribute('data-account-row-kind')).toBe('disabled')
    expect(hidden.textContent).toContain('Not available for agent use')
    const codex = host.querySelector('[data-account-row="codex:acc_k"]') as HTMLButtonElement
    await act(async () => { codex.click() })
    const confirm = host.querySelector('[data-account-switch-confirm]') as HTMLButtonElement
    expect(confirm.textContent).toBe('Continue on Codex CLI')
    await act(async () => { confirm.click(); await new Promise(r => setTimeout(r, 20)) })
    expect(posts).toEqual([{ id: 'm1', accountId: 'acc_k', harness: 'codex', resendPending: false }])
    expect(followed).toBe('m2')
    await act(async () => { root.unmount() })
  })
  test('a refused target that came back on the old account under a new row: the page follows it', async () => {
    getBody = info
    postReply = { ok: false, message: 'The session did not start on the other account; it continues on its previous account.', id: 'm3' }
    let followed = ''
    const { host, root } = await mount(createElement(mod.AccountSwitchInline, { sessionId: 'm1', lang: 'en', onSwitched: (id: string) => { followed = id }, children: null }))
    await act(async () => { (host.querySelector('[data-account-switch-open]') as HTMLButtonElement).click() })
    await act(async () => { (host.querySelector('[data-account-switch-confirm]') as HTMLButtonElement).click(); await new Promise(r => setTimeout(r, 20)) })
    expect(followed).toBe('m3')
    postReply = { ok: true, message: 'Session continued on the other account.', id: 'm2' }
    await act(async () => { root.unmount() })
  })
  test('cancel puts the list back', async () => {
    getBody = info
    const { host, root } = await mount(createElement(mod.AccountSwitchInline, { sessionId: 'm1', lang: 'pt', onSwitched: () => {}, children: createElement('p', { 'data-summary': '' }, 's') }))
    await act(async () => { (host.querySelector('[data-account-switch-open]') as HTMLButtonElement).click() })
    const cancel = Array.from(host.querySelectorAll('button')).find(b => b.textContent === 'Cancelar')!
    await act(async () => { cancel.click() })
    expect(host.querySelector('[data-summary]')).not.toBeNull()
    await act(async () => { root.unmount() })
  })
  test('no button when there is nowhere to go', async () => {
    getBody = { ...info, options: [] }
    const { host, root } = await mount(createElement(mod.AccountSwitchInline, { sessionId: 'm1', lang: 'pt', onSwitched: () => {}, children: null }))
    expect(host.querySelector('[data-account-switch-open]')).toBeNull()
    await act(async () => { root.unmount() })
  })
})

describe('AccountSwitchDialog — the session was ended (double failure)', () => {
  for (const [lang, width, lost, reopen] of [
    ['en', 1280, 'The session was ended: it did not start.', 'Reopen'],
    ['pt', 390, 'A sessão foi encerrada: ela não iniciou.', 'Reabrir'],
  ] as const) {
    test(`${lang} at ${width}px: the message plus a Reopen button that runs the app's own reopen and follows the new row`, async () => {
      window.innerWidth = width
      posts.length = 0; acts.length = 0
      postReply = { ok: false, message: lost, ended: true, endedId: 'm1' }
      let followed = ''
      const { root } = await mount(createElement(mod.AccountSwitchDialog, {
        open: true, sessionId: 'm1', info: limited, lang, fromLimit: false, onClose: () => {}, onSwitched: (id: string) => { followed = id },
      }))
      const confirm = Array.from(document.querySelectorAll('button')).find(b => b.textContent === (lang === 'pt' ? 'Confirmar troca' : 'Confirm switch'))!
      await act(async () => { confirm.click(); await new Promise(r => setTimeout(r, 20)) })
      expect(document.querySelector('[role="alert"]')?.textContent).toBe(lost)
      const btn = document.querySelector('[data-account-switch-reopen]') as HTMLButtonElement
      expect(btn.textContent).toBe(reopen)
      if (width === 390) expect(btn.style.width).toBe('100%')
      await act(async () => { btn.click(); await new Promise(r => setTimeout(r, 20)) })
      expect(acts).toEqual([{ id: 'm1', action: 'resume' }])
      expect(followed).toBe('m9')
      await act(async () => { root.unmount() })
      postReply = { ok: true, message: 'Session continued on the other account.', id: 'm2' }
      window.innerWidth = 1200
    })
  }

  test('a plain refusal shows no Reopen button', async () => {
    postReply = { ok: false, message: 'Nothing was ended.' }
    const { root } = await mount(createElement(mod.AccountSwitchDialog, {
      open: true, sessionId: 'm1', info: limited, lang: 'en', fromLimit: false, onClose: () => {}, onSwitched: () => {},
    }))
    const confirm = Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Confirm switch')!
    await act(async () => { confirm.click(); await new Promise(r => setTimeout(r, 20)) })
    expect(document.querySelector('[role="alert"]')).not.toBeNull()
    expect(document.querySelector('[data-account-switch-reopen]')).toBeNull()
    await act(async () => { root.unmount() })
    postReply = { ok: true, message: 'Session continued on the other account.', id: 'm2' }
  })
})

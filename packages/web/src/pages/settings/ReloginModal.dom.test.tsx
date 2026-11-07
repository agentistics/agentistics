import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import React, { act } from 'react'
import type { Root } from 'react-dom/client'

let createRoot: typeof import('react-dom/client').createRoot
let ReloginModal: typeof import('./ReloginModal').ReloginModal
const originalFetch = globalThis.fetch
const originalInterval = globalThis.setInterval, originalClear = globalThis.clearInterval
let root: Root, host: HTMLDivElement
let poll: (() => void) | undefined
let latePoll: (() => void) | undefined
let reads: number, starts: number, cancels: number
let status: 'pending' | 'failed' | 'done'
let refuse: boolean
let readWait: Promise<void> | undefined
const login = { kind: 'paste', url: 'https://claude.ai/oauth/authorize?state=TEST', expiresAt: Date.now() + 600000 }

beforeAll(async () => {
  GlobalRegistrator.register({ width: 1280, height: 900 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as never
  createRoot = (await import('react-dom/client')).createRoot
  ReloginModal = (await import('./ReloginModal')).ReloginModal
})
afterAll(async () => { await GlobalRegistrator.unregister() })
beforeEach(() => {
  reads = starts = cancels = 0; status = 'pending'; refuse = false; poll = undefined; latePoll = undefined; readWait = undefined
  globalThis.setInterval = ((fn: () => void, ms: number, ...args: unknown[]) => {
    if (ms === 2000) { poll = fn; return -9876 }
    if (ms === 4000) { latePoll = fn; return -9877 }
    return originalInterval(fn, ms, ...args)
  }) as typeof setInterval
  globalThis.clearInterval = ((id: ReturnType<typeof setInterval>) => {
    if (Number(id) === -9876) { poll = undefined; return }
    if (Number(id) === -9877) { latePoll = undefined; return }
    originalClear(id)
  }) as typeof clearInterval
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    if (init?.method === 'DELETE') { cancels++; return Response.json({ ok: true }) }
    if (init?.method === 'POST') {
      starts++
      return refuse ? Response.json({ error: 'login_unavailable' }, { status: 502 }) : Response.json({ ok: true, pendingId: 'l_test', ...login })
    }
    reads++
    await readWait
    // Bound the broken implementation so a regression reports an assertion instead of hanging.
    if (reads > 8) return Response.json({}, { status: 429 })
    return Response.json(status === 'pending' ? { status, accountId: 'acc_test', login }
      : status === 'failed' ? { status, accountId: 'acc_test', error: 'login_failed' }
      : { status, accountId: 'acc_test', boundId: 'acc_test', same: true })
  }) as typeof fetch
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => {
  await act(async () => { root.unmount() })
  host.remove(); globalThis.fetch = originalFetch
  globalThis.setInterval = originalInterval; globalThis.clearInterval = originalClear
})
const flush = async () => { for (let i = 0; i < 4; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }
const mount = async (onDone = (_out: { same: boolean; boundId: string }) => {}) => {
  await act(async () => { root.render(<ReloginModal accountId="acc_test" harness="claude" who="Disconnected account" lang="en" onClose={() => {}} onDone={onDone} />) })
  await flush()
}
const tick = async () => { await act(async () => { poll?.() }); await flush() }

test('pending login metadata refreshes only on the polling cadence and can finish', async () => {
  const completed: unknown[] = []
  await mount(out => { completed.push(out) })
  expect(starts).toBe(1)
  expect(host.querySelector('[data-login-url]')).not.toBeNull()
  expect(reads).toBe(1)
  await tick(); expect(reads).toBe(2)
  await tick(); expect(reads).toBe(3)
  status = 'done'; await tick()
  expect(completed).toEqual([{ same: true, boundId: 'acc_test' }])
  expect(host.querySelector('[data-login-step="done"]')).not.toBeNull()
  expect(poll).toBeUndefined()
})

test('a failed pending login shows a clear error and retry starts one new attempt', async () => {
  await mount()
  status = 'failed'; await tick()
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Sign-in did not finish')
  expect(poll).toBeUndefined()
  status = 'pending'
  await act(async () => { (host.querySelector('[data-login-retry]') as HTMLButtonElement).click() })
  await flush()
  expect(starts).toBe(2)
  expect(cancels).toBe(1)
  expect(reads).toBe(3)
  expect(host.querySelector('[data-login-url]')).not.toBeNull()
})

test('a login launch refusal stays inside the dialog with a retry action', async () => {
  refuse = true; await mount()
  expect(reads).toBe(0)
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Could not open this assistant')
  expect(host.querySelector('[data-login-retry]')).not.toBeNull()
})

test('slow status responses never overlap when the polling timer ticks', async () => {
  let release!: () => void
  readWait = new Promise<void>(resolve => { release = resolve })
  await mount()
  expect(reads).toBe(1)
  await tick(); await tick()
  expect(reads).toBe(1)
  release(); await flush()
  expect(reads).toBe(1)
  await tick()
  expect(reads).toBe(2)
})

test('a login that shows up after the server declared failure still finishes, and clears the error (RELOGIN.NAYARA)', async () => {
  const completed: unknown[] = []
  await mount(out => { completed.push(out) })
  status = 'failed'; await tick()
  expect(host.querySelector('[role="alert"]')).not.toBeNull()
  expect(host.querySelector('[data-login-retry]')).not.toBeNull()
  expect(latePoll).toBeDefined()
  // The credential lands; the server flips the very same attempt to done.
  status = 'done'
  await act(async () => { latePoll?.() }); await flush()
  expect(completed).toEqual([{ same: true, boundId: 'acc_test' }])
  expect(host.querySelector('[role="alert"]')).toBeNull()
  expect(host.querySelector('[data-login-retry]')).toBeNull()
  expect(host.querySelector('[data-login-step="done"]')).not.toBeNull()
  expect(latePoll).toBeUndefined()
})

test('a real failure stays failed while the late look finds nothing', async () => {
  await mount()
  status = 'failed'; await tick()
  await act(async () => { latePoll?.() }); await flush()
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Sign-in did not finish')
  expect(host.querySelector('[data-login-retry]')).not.toBeNull()
})

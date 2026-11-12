import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement } from 'react'

let createRoot: typeof import('react-dom/client').createRoot
let root: import('react-dom/client').Root | undefined
let host: HTMLDivElement | undefined
let SessionStatsMenu: typeof import('./SessionStatsMenu').SessionStatsMenu
let resetSessionStatsPopoverState: typeof import('./SessionStatsMenu').resetSessionStatsPopoverState

const stats = {
  sessionId: 'conversation-1', harness: 'claude', tokens: null, conversation: null, costUSD: null,
  context: { fraction: 0.4, used: 400, window: 1000 }, contextUsed: null, messages: null,
  subagents: null, git: null, activeMinutes: null, model: null,
} as const

beforeAll(async () => {
  GlobalRegistrator.register({ width: 1200, height: 800 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as never
  ;(globalThis as { EventSource?: unknown }).EventSource = class { addEventListener() {} removeEventListener() {} close() {} }
  globalThis.fetch = (async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
  createRoot = (await import('react-dom/client')).createRoot
  const mod = await import('./SessionStatsMenu')
  SessionStatsMenu = mod.SessionStatsMenu
  resetSessionStatsPopoverState = mod.resetSessionStatsPopoverState
})

beforeEach(async () => {
  resetSessionStatsPopoverState?.()
  host =document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterAll(async () => {
  await act(async () => { root?.unmount() })
  await GlobalRegistrator.unregister()
})

const element = (key?: string, sessionId = 'conversation-1') => createElement(SessionStatsMenu, {
  key, harness: 'claude', sessionId, meta: undefined, stats, lang: 'en', currency: 'USD', brlRate: 1,
  variant: 'button',
})

test('the usage popup survives a session panel remount caused by an update', async () => {
  await act(async () => { root!.render(element('snapshot-1')) })
  await act(async () => { host!.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click() })
  expect(host!.querySelector('button[aria-expanded="true"]')).not.toBeNull()

  await act(async () => { root!.render(element('snapshot-2')) })
  expect(host!.querySelector('button[aria-expanded="true"]')).not.toBeNull()
  expect(host!.querySelector<HTMLButtonElement>('button[aria-expanded="true"]')).not.toBeNull()
})

test('Escape still closes the popup after a remount restored it', async () => {
  await act(async () => { root!.render(element('esc-1')) })
  await act(async () => { host!.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click() })
  await act(async () => { root!.render(element('esc-2')) })
  expect(host!.querySelector('button[aria-expanded="true"]')).not.toBeNull()

  await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
  expect(host!.querySelector('button[aria-expanded="true"]')).toBeNull()
  // a closed popup stays closed across the next remount
  await act(async () => { root!.render(element('esc-3')) })
  expect(host!.querySelector('button[aria-expanded="true"]')).toBeNull()
})

test('two different sessions do not share the open state', async () => {
  await act(async () => { root!.render(element('a', 'conversation-A')) })
  await act(async () => { host!.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click() })
  expect(host!.querySelector('button[aria-expanded="true"]')).not.toBeNull()

  await act(async () => { root!.render(element('b', 'conversation-B')) })
  expect(host!.querySelector('button[aria-expanded="true"]')).toBeNull()
})

test('gauge: a chat scroll that does not move the trigger keeps it open; one that moves it closes', async () => {
  const gauge = createElement(SessionStatsMenu, {
    harness: 'claude', sessionId: 'conversation-g', meta: undefined, stats, lang: 'en', currency: 'USD', brlRate: 1, variant: 'gauge',
  })
  await act(async () => { root!.render(gauge) })
  await act(async () => { host!.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click() })
  expect(host!.querySelector('button[aria-expanded="true"]')).not.toBeNull()

  const chat = document.createElement('div')
  document.body.appendChild(chat)
  await act(async () => { chat.dispatchEvent(new Event('scroll', { bubbles: false })) })
  expect(host!.querySelector('button[aria-expanded="true"]')).not.toBeNull()

  const box = host!.querySelector('button[aria-expanded]')!.parentElement!
  box.getBoundingClientRect = () => ({ top: 100, left: 50, bottom: 130, right: 80, width: 30, height: 30, x: 50, y: 100, toJSON() {} })
  await act(async () => { chat.dispatchEvent(new Event('scroll')) })
  expect(host!.querySelector('button[aria-expanded="true"]')).toBeNull()
})

test('an outside click still closes the usage popup', async () => {
  await act(async () => { root!.render(element('outside-click')) })
  await act(async () => { host!.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click() })
  expect(host!.querySelector('button[aria-expanded="true"]')).not.toBeNull()

  await act(async () => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
  expect(host!.querySelector('button[aria-expanded="true"]')).toBeNull()
})

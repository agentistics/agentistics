import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'
import type { Root } from 'react-dom/client'

let createRoot: typeof import('react-dom/client').createRoot
let ActionNotice: typeof import('./ActionNotice').ActionNotice
let NOTICE_MS: number
let host: HTMLDivElement
let root: Root
let dismissed: number

beforeAll(async () => {
  GlobalRegistrator.register({ width: 1280, height: 900 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  createRoot = (await import('react-dom/client')).createRoot
  ;({ ActionNotice, NOTICE_MS } = await import('./ActionNotice'))
})
afterAll(async () => { await GlobalRegistrator.unregister() })
beforeEach(() => { dismissed = 0; host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(async () => { await act(async () => root.unmount()); host.remove() })
const sleep = (ms: number) => act(async () => { await new Promise(r => setTimeout(r, ms)) })
const show = (message: string) => act(async () => root.render(<ActionNotice message={message} lang="pt" onDismiss={() => { dismissed++ }} />))
const toast = () => document.body.querySelector<HTMLElement>('[data-action-notice]')

test('a short confirmation leaves by itself after NOTICE_MS, and not before', async () => {
  await show('Jarvis encerrada.')
  expect(toast()?.parentElement).toBe(document.body)
  await sleep(NOTICE_MS - 600)
  expect(dismissed).toBe(0)
  await sleep(900)
  expect(dismissed).toBe(1)
})

test('hovering pauses the clock and the bar; leaving resumes it', async () => {
  await show('Jarvis encerrada.')
  const el = toast()!
  await sleep(1000)
  await act(async () => { el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body })) })
  await sleep(NOTICE_MS + 300)
  expect(dismissed).toBe(0)
  expect(el.querySelector<HTMLElement>('[data-notice-progress]')!.style.animationPlayState).toBe('paused')
  await act(async () => { el.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body })) })
  expect(el.querySelector<HTMLElement>('[data-notice-progress]')!.style.animationPlayState).toBe('running')
  await sleep(1200) // ~1 s was left
  expect(dismissed).toBe(1)
}, 15000)

test('a diagnostic with Details never auto-dismisses', async () => {
  await show('diagnóstico '.repeat(30))
  expect(toast()?.hasAttribute('data-transient')).toBe(false)
  await sleep(NOTICE_MS + 400)
  expect(dismissed).toBe(0)
}, 10000)

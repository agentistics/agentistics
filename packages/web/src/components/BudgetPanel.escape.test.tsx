/** The budget editor owns Escape only while it is actually on screen. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import type { StatsCache } from '@agentistics/core'

let createRoot: typeof import('react-dom/client').createRoot
let BudgetPanel: typeof import('./BudgetPanel').BudgetPanel
let overlayDepth: typeof import('../lib/overlayStack').overlayDepth

beforeAll(async () => {
  GlobalRegistrator.register({ width: 390, height: 800 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  createRoot = (await import('react-dom/client')).createRoot
  BudgetPanel = (await import('./BudgetPanel')).BudgetPanel
  overlayDepth = (await import('../lib/overlayStack')).overlayDepth
})
afterAll(async () => { await new Promise(r => setTimeout(r, 50)); await GlobalRegistrator.unregister() })

let host: HTMLDivElement
let root: Root
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove() })

const render = (harness: 'claude' | 'codex') => act(() => {
  root.render(createElement(BudgetPanel, {
    statsCache: { dailyModelTokens: [], modelUsage: {} } as unknown as StatsCache,
    budgetUSD: 100, onBudgetChange() {}, currency: 'USD', brlRate: 5, lang: 'en', harness,
  }))
})

describe('BudgetPanel Escape ownership', () => {
  test('editing registers an overlay; switching to a non-Claude harness releases it', () => {
    render('claude')
    expect(overlayDepth()).toBe(0)
    act(() => { host.querySelector<HTMLButtonElement>('button')!.click() })
    expect(overlayDepth()).toBe(1)
    render('codex')
    expect(overlayDepth()).toBe(0)
  })
})

/**
 * SESSAO.ESTADO-ICONE (owner 2026-11-26): a sidebar row draws its state as an ICON with an accessible
 * tooltip — not as visible text beside the title — and the title is ONE line with "…".
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'

let createRoot: typeof import('react-dom/client').createRoot
let SessionLine: typeof import('./SessionLine').SessionLine
let TITLE_ONE_LINE_CLASS: string
let originalActEnvironment: boolean | undefined

beforeAll(async () => {
  originalActEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT
  GlobalRegistrator.register({ width: 1280, height: 800 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  Object.defineProperty(Element.prototype, 'animate', { value: undefined, configurable: true })
  createRoot = (await import('react-dom/client')).createRoot
  ;({ SessionLine, TITLE_ONE_LINE_CLASS } = await import('./SessionLine'))
})
afterAll(async () => {
  await new Promise(resolve => setTimeout(resolve, 50))
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = originalActEnvironment
  await GlobalRegistrator.unregister()
})

let host: HTMLDivElement
let root: Root
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove() })

const LONG = 'Motor · fila de testes pesados com um título bem comprido que não cabe'
const session = (extra: Record<string, unknown>) => ({
  id: 'row1', title: LONG, harness: 'claude', cwd: '/x', project: 'x', state: 'waiting',
  stateLabel: 'needs you', actionable: true, attachCommand: '', verbs: [], ...extra,
}) as never

const draw = (s: never, time: string | null, lang: 'pt' | 'en', tap?: number) =>
  act(() => root.render(createElement(SessionLine, { session: s, selected: false, onOpen: () => {}, lang, time, ...(tap ? { tap } : {}) })))

for (const lang of ['pt', 'en'] as const) {
  test(`a running row shows an icon with the full sentence as its tooltip, not as visible text (${lang})`, () => {
    draw(session({ activeSignal: 'tool' }), '1 min', lang)
    const icon = host.querySelector<HTMLElement>('[data-line-status]')!
    expect(icon).not.toBeNull()
    expect(icon.getAttribute('data-line-status')).toBe('cmd')
    const sentence = lang === 'pt' ? 'rodando há 1 min' : 'running for 1 min'
    expect(icon.getAttribute('role')).toBe('img')
    expect(icon.getAttribute('aria-label')).toBe(sentence)
    // Keyboard-reachable: a tab stop whose focus opens the tooltip.
    expect(icon.tabIndex).toBe(0)
    // The row's visible text is the title and the SHORT time — never the activity word.
    const row = host.querySelector<HTMLElement>('[data-session-line]')!
    expect(row.textContent).toBe(`${LONG}1 min`)
    expect(row.textContent).not.toContain(lang === 'pt' ? 'rodando' : 'running')
    expect(document.querySelector('[role="tooltip"]')).toBeNull()
    act(() => icon.focus())
    const tip = document.querySelector<HTMLElement>('[role="tooltip"]')!
    expect(tip.textContent).toBe(sentence)
    expect(icon.getAttribute('aria-describedby')).toBe(tip.id)
    act(() => icon.blur())
    expect(document.querySelector('[role="tooltip"]')).toBeNull()
  })
}

test('a queued row wears the queue icon; a tap (no hover on a phone) shows and hides the tooltip', () => {
  draw(session({ activeSignal: 'heavy-lock' }), null, 'pt', 44)
  const icon = host.querySelector<HTMLElement>('[data-line-status]')!
  expect(icon.getAttribute('data-line-status')).toBe('queue')
  expect(icon.getAttribute('aria-label')).toBe('na fila de trabalho pesado')
  expect(icon.style.height).toBe('44px')
  act(() => icon.click())
  expect(document.querySelector('[role="tooltip"]')?.textContent).toBe('na fila de trabalho pesado')
  act(() => icon.click())
  expect(document.querySelector('[role="tooltip"]')).toBeNull()
  // A real tap focuses the icon BEFORE its click: the click must not close what the focus opened.
  act(() => icon.focus())
  act(() => icon.click())
  expect(document.querySelector('[role="tooltip"]')?.textContent).toBe('na fila de trabalho pesado')
})

test('on a phone the status icon has a 44×44 tap target', () => {
  draw(session({ activeSignal: 'tool' }), '1 min', 'pt', 44)
  const icon = host.querySelector<HTMLElement>('[data-line-status]')!
  expect(parseInt(icon.style.width, 10)).toBeGreaterThanOrEqual(44)
  expect(parseInt(icon.style.height, 10)).toBeGreaterThanOrEqual(44)
})

test('on a phone an empty menu or pin slot takes no width: the status icon ends the row', () => {
  draw(session({}), '3 h', 'pt', 44)
  const row = host.querySelector<HTMLElement>('[data-session-line]')!
  expect(row.querySelectorAll('[data-slot]').length).toBe(0)
  expect(row.lastElementChild).toBe(row.querySelector('[data-line-status]'))
})

test('on desktop the empty pin slot is still reserved, so the columns line up', () => {
  draw(session({}), '3 h', 'pt')
  expect(host.querySelector('[data-slot="pin"]')).not.toBeNull()
})

test('only one tooltip is open at a time: opening a second icon closes the first', () => {
  const two = (lang: 'pt') => act(() => root.render(createElement('div', null,
    createElement(SessionLine, { session: session({ id: 'a', activeSignal: 'tool' }), selected: false, onOpen: () => {}, lang, time: '1 min' }),
    createElement(SessionLine, { session: session({ id: 'b', activeSignal: 'heavy-lock' }), selected: false, onOpen: () => {}, lang, time: '4 min' }),
  )))
  two('pt')
  const [a, b] = Array.from(host.querySelectorAll<HTMLElement>('[data-line-status]'))
  act(() => a!.click())
  expect(document.querySelectorAll('[role="tooltip"]').length).toBe(1)
  act(() => b!.focus())
  const tips = document.querySelectorAll('[role="tooltip"]')
  expect(tips.length).toBe(1)
  expect(tips[0]!.textContent).toBe('na fila de trabalho pesado há 4 min')
})

test('the title is one line with the single-line class and its full text on hover', () => {
  draw(session({}), '3 h', 'pt')
  const title = host.querySelector<HTMLElement>('[data-line-title]')!
  expect(title.classList.contains(TITLE_ONE_LINE_CLASS)).toBe(true)
  expect(title.style.whiteSpace).toBe('nowrap')
  expect(title.style.textOverflow).toBe('ellipsis')
  expect(title.querySelectorAll('wbr').length).toBe(0)
  expect(title.closest('[data-session-open]')!.getAttribute('title')).toBe(LONG)
  expect(host.querySelector('[data-line-status]')!.getAttribute('aria-label')).toBe('esperando você há 3 h')
})

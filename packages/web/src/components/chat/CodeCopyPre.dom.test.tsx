import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Root } from 'react-dom/client'

let createRoot: typeof import('react-dom/client').createRoot
let ReactMarkdown: typeof import('react-markdown').default
let codeCopyComponents: typeof import('./CodeCopyPre').codeCopyComponents
let host: HTMLDivElement, root: Root
let written: string[]
let oldAct: boolean | undefined

beforeAll(async () => {
  GlobalRegistrator.register({ width: 390, height: 844 })
  oldAct = (globalThis as any).IS_REACT_ACT_ENVIRONMENT
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  createRoot = (await import('react-dom/client')).createRoot
  ReactMarkdown = (await import('react-markdown')).default
  codeCopyComponents = (await import('./CodeCopyPre')).codeCopyComponents
})
beforeEach(() => {
  written = []
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t: string) => { written.push(t) } } })
  host = document.createElement('div'); document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(async () => { await act(async () => { root.unmount() }); host.remove() })
afterAll(async () => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = oldAct; await GlobalRegistrator.unregister() })

const render = async (md: string, pt = false) => {
  await act(async () => root.render(<div className="ag-chat-md"><ReactMarkdown components={codeCopyComponents(pt)}>{md}</ReactMarkdown></div>))
}

test('a fenced block gets exactly one copy button; inline code gets none', async () => {
  await render('use `npm i` here\n\n```bash\necho hi\n```\n\nand `inline` again')
  expect(host.querySelectorAll('button.ag-code-copy').length).toBe(1)
  expect(host.querySelector('button.ag-code-copy')!.closest('.ag-code-block')!.querySelector('pre')).not.toBeNull()
  await render('only `inline` code, no fences')
  expect(host.querySelectorAll('button').length).toBe(0)
})

test('clicking copies the exact block content — no backticks, no language tag — and says Copied for ~1.5s', async () => {
  await render('```ts\nconst a = 1\nconst b = 2\n```', false)
  const btn = host.querySelector('button.ag-code-copy') as HTMLButtonElement
  await act(async () => { btn.click() })
  expect(written).toEqual(['const a = 1\nconst b = 2'])
  expect(btn.textContent).toBe('Copied')
  await act(async () => { await new Promise(r => setTimeout(r, 1600)) })
  expect(btn.textContent).toBe('')
})

test('the label is Portuguese when asked', async () => {
  await render('```\nx\n```', true)
  expect((host.querySelector('button.ag-code-copy') as HTMLButtonElement).getAttribute('aria-label')).toBe('Copiar')
  await act(async () => { (host.querySelector('button.ag-code-copy') as HTMLButtonElement).click() })
  expect(host.querySelector('button.ag-code-copy')!.textContent).toBe('Copiado')
})

test('the copy control is not selectable; message text and code are, and rows/tabs/bars are not (touch devices)', () => {
  const css = readFileSync(join(import.meta.dir, '..', '..', 'index.css'), 'utf8')
  expect(css).toMatch(/\.ag-code-copy \{[^}]*user-select: none/)
  const touch = css.slice(css.indexOf('@media (hover: none) and (pointer: coarse) {\n  :where(button'))
  const block = touch.slice(0, touch.indexOf('\n}\n') + 3)
  for (const sel of ['button', '[role="tab"]', 'nav', 'header', 'aside', '[data-session-row]']) expect(block).toContain(sel)
  expect(block).toMatch(/:where\([^)]*\) \{\s*-webkit-user-select: none; user-select: none;/)
  expect(block).toMatch(/\.ag-chat-md[^{]*\{\s*-webkit-user-select: text; user-select: text;/)
})

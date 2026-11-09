/**
 * OPENCODE.GO: a model that trains on the user's data (Muse Spark) is never presented as safe, so its
 * row in the picker carries the warning in words, in both languages. The row used to RECEIVE the
 * label and never draw it.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement } from 'react'

let createRoot: typeof import('react-dom/client').createRoot
let mod: typeof import('./ModelSelect')

beforeAll(async () => {
  GlobalRegistrator.register({ width: 1200, height: 800 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as never
  createRoot = (await import('react-dom/client')).createRoot
  mod = await import('./ModelSelect')
})
afterAll(async () => { await GlobalRegistrator.unregister() })

const options = [
  { id: 'opencode-go/glm-5', label: 'glm-5' },
  { id: 'opencode-go/muse-spark-1.3-contributor', label: 'muse-spark-1.3-contributor' },
  { id: 'opencode/big-pickle', label: 'big-pickle' },
]

async function render(lang: 'pt' | 'en') {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(createElement(mod.ModelSelect, { lang, open: true, onOpenChange: () => {}, value: '', onChange: () => {}, options, unsetLabel: 'default' }))
  })
  return { host, unmount: () => act(() => root.unmount()) }
}

describe('ModelSelect — Muse Spark warning', () => {
  test('en: only the Muse Spark row carries "trains on your data", with an icon', async () => {
    const { host, unmount } = await render('en')
    const rows = Array.from(host.querySelectorAll('[role="option"]'))
    const warned = rows.filter(r => r.querySelector('[data-model-warning]'))
    expect(warned).toHaveLength(1)
    expect(warned[0]!.textContent).toContain('muse-spark')
    expect(warned[0]!.textContent).toContain('trains on your data')
    expect(warned[0]!.querySelector('[data-model-warning] svg')).not.toBeNull()
    expect(rows.filter(r => r.textContent?.includes('trains on your data'))).toHaveLength(1)
    await unmount()
  })

  test('pt: the same row says it in Portuguese', async () => {
    const { host, unmount } = await render('pt')
    const warning = host.querySelector('[data-model-warning]')
    expect(warning?.textContent).toContain('treina com seus dados')
    await unmount()
  })
})

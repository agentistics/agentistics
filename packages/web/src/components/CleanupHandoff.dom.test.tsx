import { afterAll, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'
import { DEFAULT_HANDOFF_CONFIG, type CleanWebPlan, type HandoffPanel } from '@agentistics/core'

const plan: CleanWebPlan = { scanId: 'regression', scannedAt: Date.now(), elapsedMs: 100, reclaimable: { bytes: 606 * 1024 ** 2, count: 3 }, items: [
  { id: 'a', repo: '/repo', project: 'repo', path: '/repo/a', name: 'a', kind: 'remove', bytes: 50 * 1024 ** 2, reason: 'merged and clean', lastActivityMs: 0 },
  { id: 'b', repo: '/repo', project: 'repo', path: '/repo/b', name: 'b', kind: 'node-modules', bytes: 556 * 1024 ** 2, reason: '', lastActivityMs: Date.now() },
  { id: 'c', repo: '/repo', project: 'repo', path: '/repo/c', name: 'c', kind: 'keep', bytes: 0, reason: 'dirty', lastActivityMs: Date.now() },
] }
const panel: HandoffPanel = { version: 1, sessionId: 'leader-regression', updatedAt: 0, config: DEFAULT_HANDOFF_CONFIG, cutTokens: 250000, contextTokens: 310000, contextWindow: 1000000, level: 'overdue', spentUSD: 18, replies: 84, nextReplyUSD: .39, successorReplyUSD: .15, successorBaseTokens: 40000, handoffOverheadUSD: 1.2, breakEvenReplies: 5, projectionReplies: 20, projections: [], quotaEstimated: true, workInFlight: [], handoffPath: null }
let createRoot: typeof import('react-dom/client').createRoot
let CleanDialog: typeof import('./CleanDialog').CleanDialog
let HandoffLivePanel: typeof import('./sessions/HandoffWarning').HandoffLivePanel
const realFetch = globalThis.fetch
let oldAct: boolean | undefined
beforeAll(async () => {
  GlobalRegistrator.register({ width: 1280, height: 900 })
  oldAct = (globalThis as any).IS_REACT_ACT_ENVIRONMENT
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  createRoot = (await import('react-dom/client')).createRoot
  CleanDialog = (await import('./CleanDialog')).CleanDialog
  HandoffLivePanel = (await import('./sessions/HandoffWarning')).HandoffLivePanel
})
afterAll(async () => { globalThis.fetch = realFetch; (globalThis as any).IS_REACT_ACT_ENVIRONMENT = oldAct; await GlobalRegistrator.unregister() })
for (const width of [1280, 390]) for (const lang of ['pt', 'en'] as const) test(`filters and confirmation preserve selected total (${width}, ${lang})`, async () => {
  (window as unknown as { happyDOM: { setViewport(v: { width: number; height: number }): void } }).happyDOM.setViewport({ width, height: 900 })
  window.matchMedia = ((q: string) => ({ matches: q.includes('max-width') && width < 768, addEventListener() {}, removeEventListener() {} })) as never
  globalThis.fetch = (async (url: string) => Response.json(url.endsWith('/scan') ? null : plan)) as typeof fetch
  const host = document.createElement('div'); document.body.appendChild(host); const root = createRoot(host)
  const button = (label: string) => Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(b => b.textContent === label)!
  try {
    await act(async () => { root.render(<CleanDialog lang={lang} open onClose={() => {}} />) })
    expect(host.querySelector('.clean-summary')!.textContent).toContain('606 MB')
    await act(async () => button('node_modules 1').click())
    expect(host.textContent).not.toContain('merged')
    expect(host.querySelectorAll(width < 768 ? '.clean-mobile-rows > div' : 'tbody tr')).toHaveLength(1)
    await act(async () => button(lang === 'pt' ? 'Parados há +7 dias 1' : 'Idle for 7+ days 1').click())
    expect(host.querySelectorAll(width < 768 ? '.clean-mobile-rows > div' : 'tbody tr')).toHaveLength(1)
    if (width < 768) expect(host.querySelector('.clean-mobile-select')!.textContent).not.toContain('50 MB')
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="clean-apply"]')!.click())
    expect(host.querySelector('.clean-number')!.textContent).toBe('50 MB')
    expect(host.querySelector('.clean-selected')).toBeNull()
    expect(host.textContent).not.toContain('606 MB')
    expect(host.textContent!.match(new RegExp(lang === 'pt' ? 'itens serão removidos' : 'items will be removed', 'g'))).toHaveLength(1)
  } finally { await act(async () => root.unmount()); host.remove() }
})
for (const pt of [true, false]) test(`handoff explanation occurs once; confirmation is in the footer (${pt ? 'pt' : 'en'})`, async () => {
  const host = document.createElement('div'); document.body.appendChild(host); const root = createRoot(host)
  try {
    await act(async () => root.render(<HandoffLivePanel panel={panel} open pt={pt} act={async () => ({ ok: true }) as never} />))
    const dialog = document.querySelector('.handoff-dialog')!
    expect(dialog.textContent!.match(new RegExp(pt ? 'O líder prepara' : 'The leader prepares', 'g'))).toHaveLength(1)
    expect(dialog.querySelector('.handoff-live-panel > small')!.textContent).not.toContain('10%')
    const footer = dialog.querySelector('.handoff-panel-footer')!
    const primary = footer.querySelector<HTMLButtonElement>('.primary')!
    await act(async () => primary.click())
    expect(primary.textContent).toBe(pt ? 'Confirmar passagem' : 'Confirm handoff')
    expect(footer.querySelector('[role="status"]')).not.toBeNull()
    expect(dialog.querySelector('.handoff-live-panel [role="status"]')).toBeNull()
  } finally { await act(async () => root.unmount()); host.remove() }
})

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'
import { DEFAULT_HANDOFF_CONFIG, type CleanWebPlan, type HandoffPanel } from '@agentistics/core'

const plan: CleanWebPlan = { scanId: 'regression', scannedAt: Date.now(), elapsedMs: 100, reclaimable: { bytes: 606 * 1024 ** 2, count: 3 }, items: [
  { id: 'a', repo: '/repo', project: 'project-with-a-complete-name-of-fifty-characters-12345', path: '/repo/a', name: 'a', kind: 'remove', bytes: 50 * 1024 ** 2, reason: 'merged and clean', lastActivityMs: 0 },
  { id: 'b', repo: '/repo', project: 'project-with-a-complete-name-of-fifty-characters-12345', path: '/repo/b', name: 'b/node_modules', kind: 'node-modules', bytes: 556 * 1024 ** 2, reason: '', lastActivityMs: Date.now() },
  { id: 'c', repo: '/another-repo', project: 'project-with-a-complete-name-of-fifty-characters-12345', path: '/repo/c', name: 'c', kind: 'keep', bytes: 900 * 1024 ** 2, reason: 'dirty', lastActivityMs: Date.now() },
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
  // Only `/plan` answers with the plan: a stray `/background` or `/scan` from another file's store
  // must not land the plan as the scan state.
  globalThis.fetch = (async (url: string) => Response.json(url.endsWith('/plan') ? plan : null)) as typeof fetch
  const host = document.createElement('div'); document.body.appendChild(host); const root = createRoot(host)
  const button = (label: string) => Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(b => b.textContent === label)!
  try {
    await act(async () => { root.render(<CleanDialog lang={lang} open onClose={() => {}} />) })
    expect(host.querySelector('.clean-summary')!.textContent).toContain('606 MB')
    // Count repository identities across every row, including kept items and repeated names.
    expect(host.querySelector('.clean-summary')!.textContent).toContain(lang === 'pt' ? '2 projetos nesta lista' : '2 projects in this list')
    const projectNames = Array.from(host.querySelectorAll(width < 768 ? '.clean-card-subtitle' : 'tbody td:nth-child(3)'))
    expect(projectNames).toHaveLength(3)
    for (const project of projectNames) expect(project.textContent).toContain(plan.items[0]!.project)
    const chips = host.querySelector<HTMLElement>('.clean-filter-chips > div')!
    expect(chips.style.flexWrap).toBe('wrap')
    if (width < 768) expect(host.querySelector('.clean-mobile-sort button')!.getAttribute('aria-haspopup')).toBe('listbox')
    expect(document.activeElement).toBe(host.querySelector('[role=dialog]'))
    const names = Array.from(host.querySelectorAll(width < 768 ? '.clean-card-name' : '.clean-folder-label > b')).map(n => n.textContent)
    expect(names).toEqual(['b', 'a', 'c'])
    expect(host.querySelector('.clean-selected')!.textContent).not.toContain(lang === 'pt' ? 'fora deste filtro' : 'outside this filter')
    await act(async () => button('node_modules 1').click())
    expect(host.textContent).not.toContain('merged')
    expect(host.querySelector('.clean-selected')!.textContent).toContain(lang === 'pt' ? '1 fora deste filtro' : '1 outside this filter')
    const name = host.querySelector(width < 768 ? '.clean-card-name' : '.clean-folder-label > b')!
    expect(name.textContent).toBe('b')
    expect(width < 768 ? host.querySelector('.clean-card-subtitle')!.textContent : name.parentElement!.textContent).toContain('/node_modules')
    expect(host.querySelectorAll(width < 768 ? '.clean-mobile-rows > div' : 'tbody tr')).toHaveLength(1)
    await act(async () => button(lang === 'pt' ? 'Parados há +7 dias 1' : 'Idle for 7+ days 1').click())
    expect(host.querySelectorAll(width < 768 ? '.clean-mobile-rows > div' : 'tbody tr')).toHaveLength(1)
    expect(host.querySelector('.clean-selected')!.textContent).not.toContain(lang === 'pt' ? 'fora deste filtro' : 'outside this filter')
    if (width < 768) expect(host.querySelector('.clean-mobile-controls')!.textContent).not.toContain('50 MB')
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
    expect(document.activeElement).toBe(dialog)
    expect(document.activeElement).not.toBe(dialog.querySelector('input'))
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }))
    expect(document.activeElement).toBe(dialog.querySelector('.handoff-panel-footer .primary'))
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

for (const lang of ['pt', 'en'] as const) for (const skippedCount of [0, 2]) test(`done counts final-check skips separately from protected scan rows (${lang}, ${skippedCount})`, async () => {
  const skipped = Array.from({ length: skippedCount }, (_, i) => ({ path: `/repo/skipped-${i}`, reason: 'dirty' }))
  const job = { id: 'done', state: 'done', progress: 100, result: { freedBytes: 1024, worktrees: 1, removedWorktrees: 1, nodeModules: 0, pruned: 0, skipped, errors: [], elapsedMs: 100, diskFreeBefore: null, diskFreeAfter: null, removed: [] } }
  globalThis.fetch = (async (url: string) => Response.json(url.endsWith('/apply') || url.endsWith('/job') ? job : url.endsWith('/plan') ? plan : null)) as typeof fetch
  const host = document.createElement('div'); document.body.appendChild(host); const root = createRoot(host)
  try {
    await act(async () => root.render(<CleanDialog lang={lang} open onClose={() => {}} />))
    expect(host.textContent).toContain(lang === 'pt' ? 'Mantidos por segurança' : 'Kept for safety')
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="clean-apply"]')!.click())
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="clean-apply"]')!.click())
    const cards = host.querySelectorAll('.clean-done-counts > div')
    expect(cards).toHaveLength(3)
    expect(cards[2]!.querySelector('b')!.textContent).toBe(String(skippedCount))
    expect(cards[2]!.querySelector('span')!.textContent).toBe(lang === 'pt' ? 'pulados na conferência final' : 'skipped by the final check')
  } finally { await act(async () => root.unmount()); host.remove() }
})

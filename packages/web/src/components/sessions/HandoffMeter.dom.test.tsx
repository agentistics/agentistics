/**
 * BUG.HANDOFF.BOTÃO — the leader crown in a real DOM (happy-dom): a click always answers. While a hand-off is in
 * progress (`panel.handoff`) the crown used to set `open` and render nothing (the modal and the popover were both
 * gated off), so the owner's click "did nothing".
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement } from 'react'
import type { HandoffPanel } from '@agentistics/core'

let createRoot: typeof import('react-dom/client').createRoot
let mod: typeof import('./HandoffWarning')
let Router: typeof import('react-router-dom').MemoryRouter
let originalFetch: typeof globalThis.fetch
let panel: HandoffPanel
const BASE = {"version": 1, "sessionId": "lead-1", "updatedAt": 1793365441674, "config": {"profile": "balanced", "customTokens": 250000, "warnings": {"near": true, "due": true, "overdue": true}, "extraPercent": 10}, "cutTokens": 250000, "contextTokens": 180000, "contextWindow": 200000, "level": "near", "spentUSD": null, "replies": null, "nextReplyUSD": null, "successorReplyUSD": null, "successorBaseTokens": 100000, "handoffOverheadUSD": null, "breakEvenReplies": null, "projectionReplies": 20, "projections": [{"kind": "continue", "contextTokens": null, "costUSD": null, "fiveHourPct": null, "weekPct": null}, {"kind": "extra", "contextTokens": null, "costUSD": null, "fiveHourPct": null, "weekPct": null}, {"kind": "handoff", "contextTokens": 100000, "costUSD": null, "fiveHourPct": null, "weekPct": null}], "quotaEstimated": true, "quotaUnavailableReason": "no-meter", "workInFlight": []} as unknown as HandoffPanel

beforeAll(async () => {
  originalFetch = globalThis.fetch
  GlobalRegistrator.register({ width: 1280, height: 800 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as never
  ;(globalThis as { fetch?: unknown }).fetch = async () => new Response(JSON.stringify(panel), { status: 200 })
  createRoot = (await import('react-dom/client')).createRoot
  Router = (await import('react-router-dom')).MemoryRouter
  mod = await import('./HandoffWarning')
})
afterAll(async () => { globalThis.fetch = originalFetch; await GlobalRegistrator.unregister() })

const settle = () => act(async () => { await new Promise(r => setTimeout(r, 30)) })
async function crownOf(id: string, pt = true) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(createElement(Router, null, createElement(mod.HandoffMeter, { id, pt, act: async () => ({ ok: true, message: '' }) }))) })
  await settle()
  const crown = host.querySelector('button.handoff-meter') as HTMLButtonElement | null
  if (!crown) throw new Error('no crown rendered')
  return { crown, unmount: () => act(async () => { root.unmount(); host.remove() }) }
}
const dialog = () => document.querySelector('.handoff-dialog')

describe('the leader crown always answers a click', () => {
  test('no hand-off in progress → the panel opens', async () => {
    panel = { ...BASE, sessionId: 'lead-a' }
    const { crown, unmount } = await crownOf('lead-a')
    await act(async () => { crown.click() })
    expect(dialog()).not.toBeNull()
    await unmount()
  })
  test('a hand-off PREPARING (requested, successor not open yet) → the panel opens, shows the progress and lets the owner ask again', async () => {
    panel = { ...BASE, sessionId: 'lead-b', handoff: { stage: 'preparing', requestedAt: new Date().toISOString(), progress: 0.1 } }
    const { crown, unmount } = await crownOf('lead-b')
    await act(async () => { crown.click() })
    const d = dialog()
    expect(d).not.toBeNull()
    expect(d!.textContent).toContain('Passagem em andamento')
    expect(d!.textContent).toContain('Preparando a passagem')
    expect(d!.textContent).toContain('Pedir de novo')
    await unmount()
  })
  test('a successor already open → the panel opens with the progress and a link to the successor, no second hand-off button', async () => {
    panel = { ...BASE, sessionId: 'lead-c', handoff: { stage: 'successor-open', successorId: 'succ-1', requestedAt: new Date().toISOString(), progress: 0.35 } }
    const { crown, unmount } = await crownOf('lead-c')
    await act(async () => { crown.click() })
    const d = dialog()
    expect(d).not.toBeNull()
    expect(d!.textContent).toContain('Sucessor aberto')
    expect(d!.querySelector('a[href="/sessions/succ-1"]')).not.toBeNull()
    expect(d!.textContent).not.toContain('Passar agora')
    await unmount()
  })
  test('a dismissed (collapsed) warning still opens the panel from the crown', async () => {
    panel = { ...BASE, sessionId: 'lead-d', level: 'due', contextTokens: 240000 }
    const { crown, unmount } = await crownOf('lead-d')
    await act(async () => { (await import('../../lib/handoffPanel')).handoffPanelActions.dismiss('lead-d', true) })
    await act(async () => { crown.click() })
    expect(dialog()).not.toBeNull()
    await unmount()
  })
})

// QA fixes F1–F4 (pt and en): the panel follows the hand-off state; asking again does not need a reading.
const buttons = (d: Element) => Array.from(d.querySelectorAll('button')) as HTMLButtonElement[]
const byText = (d: Element, t: string) => buttons(d).find(b => b.textContent === t)
const WORDS = {
  pt: { title: 'Passagem em andamento', ask: 'Pedir de novo', remind: 'Lembrar em +50 mil', now: 'Passar agora', level: 'Hora de passar', decide: 'Continuar ou passar o líder?', noRead: 'Sem leitura', noReadPara: 'Ainda não há uma leitura de contexto', needsReading: 'quando houver uma leitura de contexto', confirm: 'O líder vai preparar a passagem' },
  en: { title: 'Handoff in progress', ask: 'Ask again', remind: 'Remind me in +50k', now: 'Hand off now', level: 'Time to hand off', decide: 'Continue or hand off the leader?', noRead: 'No reading', noReadPara: 'There is no context reading', needsReading: 'once there is a context reading', confirm: 'The leader will prepare the handoff' },
} as const
const now = () => new Date().toISOString()

for (const lang of ['pt', 'en'] as const) {
  const w = WORDS[lang], pt = lang === 'pt'
  describe(`QA fixes — the panel follows the hand-off state (${lang})`, () => {
    test('F1: preparing with NO reading → "ask again" and the reminder are enabled', async () => {
      panel = { ...BASE, sessionId: `f1a-${lang}`, contextTokens: null, level: 'normal', handoff: { stage: 'preparing', requestedAt: now(), progress: 0.1 } }
      const { crown, unmount } = await crownOf(`f1a-${lang}`, pt)
      await act(async () => { crown.click() })
      const d = dialog()!
      expect(byText(d, w.ask)).toBeDefined()
      expect(byText(d, w.ask)!.disabled).toBe(false)
      await unmount()
    })
    test('F1: no hand-off and NO reading → only "hand off now" is disabled, and the page says why; the reminder is enabled', async () => {
      panel = { ...BASE, sessionId: `f1b-${lang}`, contextTokens: null, level: 'normal' }
      const { crown, unmount } = await crownOf(`f1b-${lang}`, pt)
      await act(async () => { crown.click() })
      const d = dialog()!
      expect(byText(d, w.now)!.disabled).toBe(true)
      expect(byText(d, w.remind)!.disabled).toBe(false)
      expect(d.textContent).toContain(w.needsReading)
      await unmount()
    })
    test('F2: no reading is said once (the paragraph), not as a state line too', async () => {
      panel = { ...BASE, sessionId: `f2-${lang}`, contextTokens: null, level: 'normal' }
      const { crown, unmount } = await crownOf(`f2-${lang}`, pt)
      await act(async () => { crown.click() })
      const d = dialog()!
      expect(d.textContent).not.toContain(w.noRead)
      expect(d.textContent!.split(w.noReadPara).length - 1).toBe(1)
      await unmount()
    })
    test('F3: during a hand-off the whole panel is the hand-off — title, no level line, no table, no simulation, no "what it receives"', async () => {
      for (const stage of ['preparing', 'successor-open', 'taken-over', 'closing'] as const) {
        panel = { ...BASE, sessionId: `f3-${lang}-${stage}`, level: 'due', contextTokens: 240000, handoff: { stage, requestedAt: now(), progress: 0.3, ...(stage === 'preparing' ? {} : { successorId: 'succ-9' }) } }
        const { crown, unmount } = await crownOf(`f3-${lang}-${stage}`, pt)
        await act(async () => { crown.click() })
        const d = dialog()!
        expect(d.textContent).toContain(w.title)
        expect(d.textContent).not.toContain(w.decide)
        expect(d.textContent).not.toContain(w.level)
        expect(d.querySelector('.handoff-projection-table')).toBeNull()
        expect(d.querySelector('.handoff-simulation')).toBeNull()
        expect(d.querySelector('.handoff-receives')).toBeNull()
        expect(byText(d, w.remind)).toBeUndefined()
        expect(byText(d, w.now)).toBeUndefined()
        expect(!!byText(d, w.ask)).toBe(stage === 'preparing')
        expect(!!d.querySelector('a[href="/sessions/succ-9"]')).toBe(stage !== 'preparing')
        await unmount()
      }
    })
    test('F3: without a hand-off the decision panel is unchanged (title, level line, table)', async () => {
      panel = { ...BASE, sessionId: `f3n-${lang}`, level: 'due', contextTokens: 240000 }
      const { crown, unmount } = await crownOf(`f3n-${lang}`, pt)
      await act(async () => { crown.click() })
      const d = dialog()!
      expect(d.textContent).toContain(w.decide)
      expect(d.textContent).toContain(w.level)
      expect(d.querySelector('.handoff-projection-table')).not.toBeNull()
      await unmount()
    })
    test('F4: the confirmation closes when the successor opens under it', async () => {
      const host = document.createElement('div')
      document.body.appendChild(host)
      const root = createRoot(host)
      const live = (p: HandoffPanel) => createElement(Router, null, createElement(mod.HandoffLivePanel, { panel: p, open: true, pt, act: async () => ({ ok: true, message: '' }) }))
      await act(async () => { root.render(live({ ...BASE, sessionId: `f4-${lang}`, level: 'due', contextTokens: 240000 })) })
      await act(async () => { byText(dialog()!, w.now)!.click() })
      expect(dialog()!.textContent).toContain(w.confirm)
      await act(async () => { root.render(live({ ...BASE, sessionId: `f4-${lang}`, level: 'due', contextTokens: 240000, handoff: { stage: 'successor-open', successorId: 'succ-4', requestedAt: now(), progress: 0.35 } })) })
      expect(dialog()!.textContent).not.toContain(w.confirm)
      expect(byText(dialog()!, 'Confirmar passagem')).toBeUndefined()
      expect(byText(dialog()!, 'Confirm handoff')).toBeUndefined()
      await act(async () => { root.unmount(); host.remove() })
    })
  })
}

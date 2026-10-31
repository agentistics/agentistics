import { handoffReminderDue } from './handoffPanelState'
import { useEffect, useSyncExternalStore } from 'react'
import type { HandoffPanel } from '@agentistics/core'

type State = { panel: HandoffPanel | null; open: boolean; popover: boolean; collapsed: boolean; dismissAt: number; remindTokens: number | null }
type Entry = { state: State; listeners: Set<() => void>; users: number; timer?: ReturnType<typeof setInterval>; controller?: AbortController; loading: boolean; extraPercent?: number; absent?: boolean }
const entries = new Map<string, Entry>()
function entry(id: string): Entry {
  let e = entries.get(id)
  if (!e) {
    if (entries.size >= 100) { const idle = [...entries].find(([, value]) => value.users === 0); if (idle) entries.delete(idle[0]) }
    e = { state: { panel: null, open: false, popover: false, collapsed: false, dismissAt: 0, remindTokens: null }, listeners: new Set(), users: 0, loading: false }; entries.set(id, e) }
  return e
}
function patch(id: string, values: Partial<State>) {
  const e = entry(id); e.state = { ...e.state, ...values }; e.listeners.forEach(fn => fn())
}
async function refresh(id: string) {
  const e = entry(id)
  if (e.loading) return
  e.loading = true
  const controller = new AbortController(); e.controller = controller
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/handoff-panel${e.extraPercent === undefined ? '' : `?extraPercent=${e.extraPercent}`}`, { signal: controller.signal })
    if (!res.ok) { if (res.status === 404) { e.absent = true; if (e.timer) { clearInterval(e.timer); e.timer = undefined }; patch(id, { panel: null }) }; return }
    e.absent = false
    const panel = await res.json() as HandoffPanel
    if (controller.signal.aborted) return
    const previous = e.state.panel
    const enabled = !panel.handoff && panel.level !== 'normal' && panel.config.warnings[panel.level]
    const changed = previous?.level !== panel.level
    const reminder = e.state.collapsed && handoffReminderDue(Date.now(), e.state.dismissAt, e.state.remindTokens, panel.contextTokens)
    patch(id, { panel, ...(!enabled ? { popover: false } : changed ? { popover: true } : {}), ...(reminder || (previous?.handoff && !panel.handoff) ? { collapsed: false, remindTokens: null } : {}) })
  } catch { /* keep the last measured reading during a transient poll failure */ }
  finally { e.loading = false }
}
export const handoffPanelActions = {
  requested: (id: string) => {
    const panel = entry(id).state.panel
    if (panel) patch(id, { panel: { ...panel, handoff: { stage: 'preparing', requestedAt: new Date().toISOString(), progress: .1 } }, collapsed: false, popover: false })
    void refresh(id)
  },
  simulate: (id: string, extraPercent: number) => { entry(id).extraPercent = extraPercent; void refresh(id) },
  open: (id: string) => patch(id, { open: true, popover: false }),
  close: (id: string) => patch(id, { open: false }),
  acknowledge: (id: string) => patch(id, { popover: false }),
  expand: (id: string) => patch(id, { collapsed: false }),
  dismiss: (id: string, tokens = false) => patch(id, { collapsed: true, popover: false, open: false, dismissAt: Date.now(), remindTokens: tokens ? (entry(id).state.panel?.contextTokens ?? 0) + 50_000 : null }),
}
export function useHandoffPanel(id: string) {
  const state = useSyncExternalStore(fn => { const e = entry(id); e.listeners.add(fn); return () => { e.listeners.delete(fn) } }, () => entry(id).state, () => entry(id).state)
  useEffect(() => {
    const e = entry(id); e.users++
    if (e.users === 1) { e.absent = false; void refresh(id); e.timer = setInterval(() => { if (!document.hidden) void refresh(id) }, 5_000) }
    const update = () => { e.extraPercent = undefined; void refresh(id) }
    window.addEventListener('agentistics:handoff-settings', update)
    return () => {
      window.removeEventListener('agentistics:handoff-settings', update)
      if (--e.users === 0) { clearInterval(e.timer); e.controller?.abort(); e.loading = false }
    }
  }, [id])
  return state
}

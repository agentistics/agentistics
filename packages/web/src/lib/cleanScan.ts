/** A view of the server's task, shared by the dialog and the existing pinned bell pattern. */
import { useSyncExternalStore } from 'react'
import type { CleanScanState, CleanWebPlan } from '@agentistics/core'
import { getNotificationSettings, playNotificationSound } from './sessionNotifications'
import { dismissCleanAlert, pushAlert } from './nayNotifyStore'

export interface CleanScanSnapshot { scan: CleanScanState | null; plan: CleanWebPlan | null; error: boolean }
let current: CleanScanSnapshot = { scan: null, plan: null, error: false }
const listeners = new Set<() => void>()
const announced = new Set<string>()
let timer: ReturnType<typeof setTimeout> | null = null
let polling = false
let revision = 0
const emit = (next: CleanScanSnapshot) => { current = next; for (const cb of listeners) cb() }
async function request<T>(path: string, method = 'GET'): Promise<T> {
  const response = await fetch(`/api/clean/${path}`, { method })
  if (!response.ok) throw new Error(`cleanup ${response.status}`)
  return response.json() as Promise<T>
}
function announce(scan: CleanScanState, plan: CleanWebPlan): void {
  if (!scan.background || announced.has(scan.id)) return
  const settings = getNotificationSettings()
  if (!settings.enabled || settings.doNotDisturb || (typeof document !== 'undefined' && document.visibilityState !== 'visible')) return
  announced.add(scan.id)
  const raised = pushAlert({ key: `clean:${scan.id}`, kind: 'clean', sessionId: `clean:${scan.id}`, name: 'Worktrees · node_modules', sinceMs: plan.scannedAt, sinceKnown: true,
    clean: { scanId: scan.id, bytes: plan.reclaimable.bytes, count: plan.reclaimable.count, kept: plan.items.filter(i => i.kind === 'keep').length } })
  if (raised && settings.soundEnabled) playNotificationSound(settings.eventSounds.waiting, settings.soundVolume)
}
async function poll(): Promise<void> {
  if (polling) return
  polling = true
  const observedRevision = revision
  try {
    const scan = await request<CleanScanState | null>('scan')
    if (observedRevision !== revision) return
    let plan = current.plan
    if (scan?.state === 'ready' && plan?.scanId !== scan.id) {
      const response = await request<CleanWebPlan | CleanScanState>('plan')
      if ('items' in response) plan = response
    }
    if (observedRevision !== revision) return
    const previousId = current.scan?.id ?? current.plan?.scanId
    if (previousId && (!scan || scan.id !== previousId || scan.state === 'cancelled')) dismissCleanAlert(previousId)
    if (!scan || scan.state === 'cancelled' || (plan && plan.scanId !== scan.id)) plan = null
    emit({ scan, plan, error: scan?.state === 'error' })
    if (scan?.state === 'ready' && plan) announce(scan, plan)
  } catch { if (observedRevision === revision) emit({ ...current, error: true }) }
  finally {
    polling = false
    if (listeners.size) timer = setTimeout(() => void poll(), current.scan?.state === 'scanning' ? 500 : 4000)
  }
}
export function subscribeCleanScan(cb: () => void): () => void {
  listeners.add(cb)
  if (listeners.size === 1) void poll()
  return () => { listeners.delete(cb); if (!listeners.size && timer) { clearTimeout(timer); timer = null } }
}
export function useCleanScan(): CleanScanSnapshot {
  return useSyncExternalStore(subscribeCleanScan, () => current, () => current)
}

export function readCleanScan(): CleanScanSnapshot { return current }

export async function startCleanScan(): Promise<void> {
  revision++
  emit({ ...current, error: false })
  try {
    const result = await request<CleanWebPlan | CleanScanState>('plan')
    if ('items' in result) emit({ ...current, plan: result, error: false })
    else emit({ scan: result, plan: null, error: result.state === 'error' })
  } catch { emit({ ...current, error: true }) }
}
export async function backgroundCleanScan(): Promise<void> {
  revision++
  const scan = await request<CleanScanState | null>('background', 'POST')
  emit({ ...current, scan })
  if (scan?.state === 'ready' && current.plan) announce(scan, current.plan)
}
export async function cancelCleanScan(): Promise<void> {
  revision++
  const scan = await request<CleanScanState | null>('cancel', 'POST')
  if (scan) dismissCleanAlert(scan.id)
  emit({ scan, plan: null, error: false })
}
export async function finalizeCleanScan(): Promise<void> {
  revision++
  const id = current.scan?.id ?? current.plan?.scanId
  await request('finalize', 'POST')
  if (id) dismissCleanAlert(id)
  emit({ scan: null, plan: null, error: false })
}

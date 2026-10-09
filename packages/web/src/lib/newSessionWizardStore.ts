/**
 * The new-session wizard survives the desktop <-> mobile layout swap.
 *
 * The wizard is mounted by whichever `SessionsAside` / `SessionsRail` is on screen, and crossing the
 * mobile breakpoint swaps which of them exists — unmounting the open modal with every answer in it.
 * Module state outlives the swap: the modal writes its answers here as they change, an unmount that
 * was NOT a close/start leaves the wizard ORPHANED, and the next list to mount adopts it and reopens
 * the modal on the same answers. Closing or starting clears everything, so a finished wizard never
 * comes back. In memory only: a reload is a fresh wizard.
 */
import type { StepId } from './wizardSteps'

export interface WizardSnapshot {
  harnessId: string
  nativeProvider: string
  cwd: string
  task: string
  subtaskTarget: { taskId: string; subtaskId?: string } | null
  model: string
  effort: string
  prompt: string
  label: string
  attachments: { name: string; path: string }[]
  step: StepId
  dirty: boolean
}

let snapshot: WizardSnapshot | null = null
let orphaned = false

export const saveWizardSnapshot = (s: WizardSnapshot): void => { snapshot = s }
export const readWizardSnapshot = (): WizardSnapshot | null => snapshot
/** The wizard ended (closed or started): forget it. */
export const clearWizard = (): void => { snapshot = null; orphaned = false }
/** The modal unmounted without ending — the layout swapped under it. */
export const orphanWizard = (): void => {
  if (!snapshot) return
  orphaned = true
  for (const l of [...listeners]) l()
}
const listeners = new Set<() => void>()
/** Called whenever a wizard is orphaned — lets a list that is ALREADY mounted adopt it, whatever
 *  the order React ran the swap's unmount and mount effects in. */
export function onWizardOrphaned(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}
/** A list that just mounted takes the orphan over; true exactly once per orphan. */
export function claimOrphanWizard(): boolean {
  if (!orphaned) return false
  orphaned = false
  return true
}

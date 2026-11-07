/**
 * topBarGroupModel — PURE: what the top bar's single "grid" button groups and when it lights up.
 *
 * TOPBAR.AGRUPAR (owner-approved 07/11): Hardware, Autonomous mode, Vault, Live Delivery and Calls sit
 * behind ONE 32×32 button. The button carries NO coloured dots: it turns orange (the accent border and
 * icon the autonomous-mode button wears today) when something in the group is going on, and stays
 * neutral otherwise. The rows are real states in one line each.
 */
import type { VaultLockState } from '../../lib/vaultGlyph'
import { vaultLockWord } from '../../lib/vaultGlyph'

export type GroupRowId = 'hardware' | 'autonomous' | 'vault' | 'live' | 'calls'

export interface GroupFacts {
  pt: boolean
  /** Hardware is an overlay opened by a callback; absent where the page has no such handler. */
  hasHardware: boolean
  /** The host-only entries (autonomous, vault, live) are absent on a central. */
  host: boolean
  awayActive: boolean
  awayUntil?: string
  vault: VaultLockState
  liveWorking: number
  liveWaiting: number
  /** `Ligações` is announced by the engine for the `rail` placement; absent with no voice (kill switch). */
  callsSurface: { id: string; label: string; beta: boolean } | null
  callActive: boolean
}

export interface GroupRow {
  id: GroupRowId
  label: string
  /** The REAL state, one line. */
  state: string
  /** Rows that are the activity the button's colour reports. */
  active: boolean
  beta?: boolean
  /** The engine surface behind a `calls` row. */
  surfaceId?: string
}

export function liveStateLine(working: number, waiting: number, pt: boolean): string {
  const parts: string[] = []
  if (waiting > 0) parts.push(pt ? `${waiting} esperando você` : `${waiting} waiting on you`)
  if (working > 0) parts.push(pt ? `${working} trabalhando` : `${working} working`)
  return parts.length ? parts.join(' · ') : (pt ? 'sem atividade' : 'idle')
}

export function groupRows(f: GroupFacts): GroupRow[] {
  const rows: GroupRow[] = []
  if (f.hasHardware) rows.push({ id: 'hardware', label: 'Hardware', state: f.pt ? 'CPU, memória e disco' : 'CPU, memory and disk', active: false })
  if (f.host) {
    rows.push({
      id: 'autonomous', label: f.pt ? 'Modo autônomo' : 'Autonomous mode', active: f.awayActive,
      state: f.awayActive ? (f.awayUntil || (f.pt ? 'ligado' : 'on')) : (f.pt ? 'desligado' : 'off'),
    })
    rows.push({ id: 'vault', label: f.pt ? 'Cofre' : 'Vault', state: vaultLockWord(f.vault, f.pt), active: false })
    rows.push({
      id: 'live', label: f.pt ? 'Esteira de entregas' : 'Live Delivery',
      state: liveStateLine(f.liveWorking, f.liveWaiting, f.pt), active: f.liveWorking + f.liveWaiting > 0,
    })
  }
  if (f.callsSurface) {
    rows.push({
      id: 'calls', label: f.callsSurface.label, beta: f.callsSurface.beta, surfaceId: f.callsSurface.id, active: f.callActive,
      state: f.callActive ? (f.pt ? 'em ligação' : 'in a call') : (f.pt ? 'sem ligação' : 'no call'),
    })
  }
  return rows
}

/** The button is accented when any row reports activity — never a dot, never a count. */
export function groupAccented(rows: readonly GroupRow[]): boolean { return rows.some(r => r.active) }

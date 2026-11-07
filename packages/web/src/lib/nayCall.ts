/**
 * nayCall.ts — PURE: the "call Nay" button in the Nay button's right-click pop (owner, 2026-11-07).
 *
 * The voice call is NOT implemented in this repository. The engine announces it as an ordinary
 * `composer` surface with the `phone` icon (`docs/engine-surfaces.md`), and the session composer's
 * phone button opens it with `openEngineSurface`. This module only answers three questions about that
 * existing path, so the pop reuses it instead of duplicating any voice logic:
 *
 *  - which announced surface is the call (`callSurfaceOf`) — none on a community build, with the voice
 *    kill switch, or with an engine that has no voice, and then the pop shows no call button at all;
 *  - what state the call is in (`callStateOf`) — idle, on screen, or parked (a call in progress that was
 *    taken off screen; the top-bar pill shows the very same mounted surface);
 *  - which Nay conversation the call is placed on (`naySessionForCall`).
 *
 * The server mirrors the state for agents (`server/nay-call.ts`, MCP tool `agentistics_nay_call`).
 */

import type { EngineSurfaceInfo } from './engineSurfaces'
import { naySections, type NayListRow } from './nayList'

/** The announced surface that places a call: a `composer` surface whose idle icon is the phone. */
export function callSurfaceOf(surfaces: readonly EngineSurfaceInfo[]): EngineSurfaceInfo | null {
  return surfaces.find(s => s.placement === 'composer' && s.icon === 'phone') ?? null
}

/** The slice of a mounted surface the call state reads (`OpenSurface` from `engineSurfaceHost`). */
export interface MountedCall {
  surface: { id: string }
  sessionId: string | null
  parked: boolean
  indicator: { since?: number | undefined } | null
}

export interface NayCallState {
  /** A call surface is mounted (on screen or parked). */
  active: boolean
  /** Mounted but off screen: pressing the button brings it back. */
  parked: boolean
  sessionId: string | null
  /** Epoch ms the call began, as its own top-bar pill reports it. */
  since: number | null
}

export const NAY_CALL_IDLE: NayCallState = { active: false, parked: false, sessionId: null, since: null }

export function callStateOf(call: EngineSurfaceInfo | null, mounted: readonly MountedCall[]): NayCallState {
  if (!call) return NAY_CALL_IDLE
  const m = mounted.find(x => x.surface.id === call.id)
  if (!m) return NAY_CALL_IDLE
  return { active: true, parked: m.parked, sessionId: m.sessionId, since: m.indicator?.since ?? null }
}

/**
 * The Nay conversation a new call is placed on: the one open in the dock if it is alive, else the
 * newest alive one (waiting on the person first, then working), else `null` — and the caller starts one.
 */
export function naySessionForCall(rows: readonly NayListRow[], panelSession: string | null): string | null {
  const { working, waiting } = naySections(rows)
  const alive = [...waiting, ...working]
  if (panelSession && alive.some(r => r.id === panelSession)) return panelSession
  return alive[0]?.id ?? null
}

export interface NayCallFace { label: string; icon: 'phone' | 'phone-off'; tone: 'idle' | 'active' }

/** The button's accessible name and look: "Ligar para a Nay", or "Voltar à ligação" while one is in progress. */
export function nayCallFace(state: NayCallState, lang: 'pt' | 'en'): NayCallFace {
  const pt = lang === 'pt'
  return state.active
    ? { label: pt ? 'Voltar à ligação' : 'Back to the call', icon: 'phone', tone: 'active' }
    : { label: pt ? 'Ligar para a Nay' : 'Call Nay', icon: 'phone', tone: 'idle' }
}

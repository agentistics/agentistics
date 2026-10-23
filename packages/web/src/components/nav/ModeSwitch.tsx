/**
 * ModeSwitch — the segmented control at the top of the aside, and the only way between the two
 * workspaces.
 *
 * PINNED on purpose: it sits above the scrolling body and never moves with it. The sessions list
 * below can run to hundreds of rows, and a switch that scrolls out of view strands somebody in a
 * workspace with no visible way back — the one failure this control cannot be allowed to have.
 *
 * It navigates rather than setting state, because `workspaceMode.ts` derives the mode from the URL.
 * See that module for why: a mode held beside the router is a second answer that disagrees the
 * first time anyone reloads or presses back.
 */

import { useNavigate, useLocation } from 'react-router-dom'
import { LayoutDashboard, MessagesSquare } from 'lucide-react'
import { SegmentedTabs } from './SegmentedTabs'
import {
  WORKSPACE_MODES, modeLabel, modeOfPath, pathForMode, type WorkspaceMode,
} from '../../lib/workspaceMode'

const ICON: Record<WorkspaceMode, React.ReactNode> = {
  dashboard: <LayoutDashboard size={15} />,
  sessions: <MessagesSquare size={15} />,
}

export interface ModeSwitchProps {
  lang: 'pt' | 'en'
  /** Icons only, for the collapsed aside. The flyout renders the full control. */
  collapsed?: boolean
  /**
   * How many sessions are waiting on a person.
   *
   * Carried on the switch because it must be readable from the OTHER workspace — the whole point of
   * a badge here is that you are looking at the dashboard when a session starts needing you. It is
   * the same count the terminal cockpit puts in its header, and for the same reason.
   */
  attention?: number
  /**
   * Called after the switch navigates.
   *
   * It exists for the phone, where this control is rendered INSIDE the "More" sheet: switching
   * workspace is a navigation, and a sheet still covering the page you just asked for is a sheet
   * you have to dismiss before you can see what you chose. Every other control in that sheet
   * already closes it; this one was the exception because it is a shared component that knows
   * nothing about the sheet — so the sheet tells it what to do rather than the component guessing.
   * The desktop aside passes nothing and nothing changes there.
   */
  onNavigate?: () => void
}

const DASHBOARD_BACK_KEY = 'agentistics-dashboard-path'
const SESSIONS_BACK_KEY = 'agentistics-sessions-path'

export function ModeSwitch({ lang, collapsed = false, attention = 0, onNavigate }: ModeSwitchProps) {
  const navigate = useNavigate()
  const location = useLocation()
  const active = modeOfPath(location.pathname)

  // Where each side's "back" goes — the dashboard page and the SESSION you were last on. Remembered
  // on the way out rather than recomputed: once you are in the other workspace the router no longer
  // knows where you came from. Every access is guarded: a private window makes the accessor throw.
  const read = (key: string): string | null => {
    try { return typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(key) : null } catch { return null }
  }
  const back = read(DASHBOARD_BACK_KEY)
  const sessionsBack = read(SESSIONS_BACK_KEY)
  try {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.setItem(active === 'dashboard' ? DASHBOARD_BACK_KEY : SESSIONS_BACK_KEY, location.pathname)
    }
  } catch { /* private mode */ }

  return (
    <SegmentedTabs
      ariaLabel={lang === 'pt' ? 'Área de trabalho' : 'Workspace'}
      collapsed={collapsed}
      value={active}
      onChange={mode => { navigate(pathForMode(mode, back, sessionsBack)); onNavigate?.() }}
      tabs={WORKSPACE_MODES.map(mode => ({
        id: mode,
        label: modeLabel(mode, lang),
        icon: ICON[mode],
        ...(mode === 'sessions' && attention > 0 ? {
          badge: attention,
          badgeLabel: lang === 'pt' ? `${attention} aguardando você` : `${attention} waiting on you`,
        } : {}),
      }))}
    />
  )
}

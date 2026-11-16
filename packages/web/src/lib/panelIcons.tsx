/**
 * panelIcons.tsx — the ONE place a `PanelId` becomes a picture.
 *
 * `panelMeta.ts` stays icon-free on purpose (pure, no React — see its own header), so this is the
 * `.tsx` counterpart every renderer resolves through: `PanelRail.tsx`'s icons, `bandControls.tsx`'s
 * `PanelBar` (the bottom band's own tab strip) and the mobile panel menu. One table, so a reader
 * never sees a different glyph for "Skills" depending on which of the three drew it.
 *
 * `cli` draws the session's own harness mark when one is known (the same convention the pre-rail
 * `PanelBar` already used) and a plain terminal glyph otherwise; `shell` always draws the terminal
 * glyph, since it is nobody's assistant.
 */

import {
  Activity, CalendarDays, FileDiff, Bot, BarChart3, ClipboardList, Cpu, FolderTree, GitBranch, GitPullRequest, Image, Plug,
  Globe, Search, Sparkles, TerminalSquare, Workflow, type LucideIcon,
} from 'lucide-react'
import { HarnessMark } from '../components/sessions/HarnessMark'
import type { PanelId } from './panelSlots'

/**
 * The browser's own glyph (prototype `opcao-final.html`): a globe with a small magnifier at its lower
 * right. Composed from the two lucide icons so it follows `currentColor` and the rail's sizing like every
 * other panel icon — never a separate asset.
 */
export function GlobeSearchIcon({ size = 14 }: { size?: number }) {
  const lens = Math.max(8, Math.round(size * 0.55))
  return (
    <span aria-hidden="true" data-globe-search style={{ position: 'relative', display: 'inline-flex', width: size, height: size, flexShrink: 0 }}>
      <Globe size={size} />
      <span style={{
        position: 'absolute', right: -Math.round(size * 0.2), bottom: -Math.round(size * 0.2), display: 'inline-flex',
        background: 'var(--bg-card)', borderRadius: '50%', padding: 0.5,
      }}><Search size={lens} strokeWidth={3} /></span>
    </span>
  )
}

const ICON: Record<Exclude<PanelId, 'cli' | 'shell' | 'browser'>, LucideIcon> = {
  search: Search,
  live: FileDiff,
  gallery: Image,
  skills: Sparkles,
  agents: Bot,
  forks: GitBranch,
  workflows: Workflow,
  mcps: Plug,
  prs: GitPullRequest,
  tasks: ClipboardList,
  metrics: BarChart3,
  calendar: CalendarDays,
  livedelivery: Activity,
  studio: FolderTree,
  hardware: Cpu,
}

export function panelIconFor(panel: PanelId, size = 14, harness?: string): React.ReactNode {
  if (panel === 'cli') {
    return harness
      ? <span aria-hidden="true"><HarnessMark harness={harness} size={size} /></span>
      : <TerminalSquare size={size} />
  }
  if (panel === 'shell') return <TerminalSquare size={size} />
  if (panel === 'browser') return <GlobeSearchIcon size={size} />
  const Icon = ICON[panel]
  return <Icon size={size} />
}

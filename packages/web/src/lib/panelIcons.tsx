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
  Activity, Bot, BarChart3, ClipboardList, Cpu, FolderTree, GitBranch, GitPullRequest, Image, Plug,
  Search, Sparkles, TerminalSquare, Workflow, type LucideIcon,
} from 'lucide-react'
import { HarnessMark } from '../components/sessions/HarnessMark'
import type { PanelId } from './panelSlots'

const ICON: Record<Exclude<PanelId, 'cli' | 'shell'>, LucideIcon> = {
  search: Search,
  live: Activity,
  gallery: Image,
  skills: Sparkles,
  agents: Bot,
  forks: GitBranch,
  workflows: Workflow,
  mcps: Plug,
  prs: GitPullRequest,
  tasks: ClipboardList,
  metrics: BarChart3,
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
  const Icon = ICON[panel]
  return <Icon size={size} />
}

import { useState } from 'react'
import { BookOpen, Bot, Brain, ClipboardList, FilePlus, FilePen, Globe, Plug, Search, Sparkles, SquareTerminal, Wrench, type LucideIcon } from 'lucide-react'
import { brandAsset } from '../../lib/brand'
import { activityIconKind, activityMcpServer, type ActivityKind, type ActivityStep } from '../../lib/toolActivity'

const ICONS: Record<ActivityKind, LucideIcon> = {
  read: BookOpen, edit: FilePen, write: FilePlus, run: SquareTerminal, search: Search,
  web: Globe, memory: Brain, delegate: Bot, plan: ClipboardList, skill: Sparkles,
  mcp: Plug, other: Wrench,
}

/** Only real, locally available server marks; unknown servers keep the plug glyph. */
export function activityMcpLogo(server: string | undefined): string | undefined {
  return server === 'agentistics' ? brandAsset('/minimalistLogo.png') : undefined
}

function McpMark({ src }: { src: string }) {
  const [failed, setFailed] = useState(false)
  return failed ? <Plug size={14} /> : <img src={src} alt="" width={14} height={14}
    style={{ objectFit: 'contain' }} onError={() => setFailed(true)} />
}

/** Same 14px slot and inherited muted colour as SystemEventRow's info icon. */
export function ActivityIcon({ steps }: { steps: readonly ActivityStep[] }) {
  const kind = activityIconKind(steps)
  const Icon = ICONS[kind]
  const logo = kind === 'mcp' ? activityMcpLogo(activityMcpServer(steps)) : undefined
  return <span aria-hidden="true" data-activity-icon={kind} style={{
    display: 'inline-flex', width: 14, height: 14, alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  }}>{logo ? <McpMark key={logo} src={logo} /> : <Icon size={14} />}</span>
}

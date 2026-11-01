import { Mic } from 'lucide-react'
import { SessionChip } from './sessions/RoleChip'

export function SurfaceTurnBadge({ pt }: { pt: boolean }) {
  return <span data-surface-turn title={pt ? 'Enviado pela interface' : 'Submitted through interface'}><SessionChip><Mic size={11} aria-label={pt ? 'Microfone' : 'Microphone'} /></SessionChip></span>
}

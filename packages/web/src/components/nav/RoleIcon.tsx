import { Crown, Sparkles } from 'lucide-react'
import type { CSSProperties } from 'react'

/** What a row is, as the icon beside it says it: the leader's crown, the worker's tools, the quiet auto mark. */
export type RoleIconKind = 'leader' | 'worker' | 'auto'

/** Crossed wrench and screwdriver — lucide has a Wrench and no crossed pair, so this is drawn in its 24×24 stroke style. */
export function WorkerTools({ size = 14, style }: { size?: number; style?: CSSProperties }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={style} aria-hidden
    >
      {/* wrench: head at the top-right, handle running down to the bottom-left */}
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.1-3.1a5.5 5.5 0 0 1-7 7L5.5 20.5a2.1 2.1 0 0 1-3-3l7.3-7.2a5.5 5.5 0 0 1 7-7z" transform="translate(-1.5 .5) scale(.9)" />
      {/* screwdriver: tip at the top-left, handle at the bottom-right, crossing the wrench */}
      <path d="m3.5 3.5 5.2 5.2M8.7 8.7l-1 3.3 2.3 2.3 3.3-1M13.5 13.5l5.5 5.5a1.6 1.6 0 0 1-2.3 2.3l-5.5-5.5" />
    </svg>
  )
}

export const ROLE_COLOR: Record<RoleIconKind, string> = {
  leader: 'var(--accent-purple)',
  // The same cyan the role chip and the role menu already give a worker.
  worker: 'var(--accent-cyan)',
  auto: 'var(--text-tertiary)',
}

export function roleLabel(kind: RoleIconKind, pt: boolean): string {
  return kind === 'leader' ? (pt ? 'líder' : 'leader') : kind === 'worker' ? (pt ? 'worker' : 'worker') : (pt ? 'papel automático' : 'automatic role')
}

/** One role icon, the same size and alignment wherever the crown used to stand alone. */
export function RoleIcon({ kind, size, pt, style }: { kind: RoleIconKind; size: number; pt: boolean; style?: CSSProperties }) {
  const label = roleLabel(kind, pt)
  const css: CSSProperties = { flexShrink: 0, color: ROLE_COLOR[kind], ...style }
  return (
    <span data-role-icon={kind} title={label} role="img" aria-label={label} style={{ display: 'inline-flex', flexShrink: 0, ...css }}>
      {kind === 'leader' ? <Crown size={size} aria-hidden /> : kind === 'worker' ? <WorkerTools size={size} /> : <Sparkles size={size} aria-hidden />}
    </span>
  )
}

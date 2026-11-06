import { SESSION_STATE, harnessColor } from './board'
import type { PlanRow } from './sessionsPlan'

/** A session's live state as a coloured dot, with its harness initial — the dot never carries the
 *  state alone: the word is in the tooltip and beside the dot wherever there is room. */
export function StateDot({ r, withHarness = false }: { r: PlanRow; withHarness?: boolean }) {
  const st = r.state ? SESSION_STATE[r.state] : undefined
  const color = r.alive ? (st?.color ?? 'var(--text-tertiary)') : 'var(--text-tertiary)'
  return (
    <span title={`${r.row.label ?? r.row.id.slice(0, 8)} · ${st?.label ?? 'not in fleet'}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
      {withHarness && (
        <span style={{
          width: 16, height: 16, borderRadius: 4, fontSize: 9.5, fontWeight: 700, color: '#fff',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: harnessColor(r.row.harness),
        }}>{r.row.harness.slice(0, 1).toUpperCase()}</span>
      )}
      <span style={{ width: 8, height: 8, borderRadius: 999, background: color, opacity: r.alive ? 1 : 0.5 }} />
    </span>
  )
}

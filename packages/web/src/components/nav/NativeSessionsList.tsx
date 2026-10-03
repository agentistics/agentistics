/**
 * NativeSessionsList — the NATIVE Agentistics sessions in the sessions aside (UI.3): a way back to
 * one after leaving it. A native session is not a fleet row (no process, no tmux), so the fleet's
 * own list never shows it; the aside reads the engine's list (`useNativeSessionRows`) — once, so its
 * summary line counts the same rows (H17) — and hands them here. Renders nothing when there are none.
 */
import { useNavigate } from 'react-router-dom'
import { HarnessMark } from '../sessions/HarnessMark'
import { NATIVE_HARNESS_ID, NATIVE_HARNESS_LABEL } from '../../lib/nativeSession'
import { sessionPath } from '../../lib/sessionRoute'
import type { NativeSessionRow } from '../../hooks/useNativeSessionRows'

export function NativeSessionsList({ lang, rows, activeId, tap }: { lang: 'pt' | 'en'; rows: readonly NativeSessionRow[]; activeId?: string; tap?: number }) {
  const pt = lang === 'pt'
  const navigate = useNavigate()

  if (rows.length === 0) return null
  return (
    <div data-testid="native-sessions" style={{ marginBottom: 14 }}>
      <div style={{ padding: '6px 2px 6px 9px', fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-tertiary)' }}>
        {NATIVE_HARNESS_LABEL}
      </div>
      {rows.map(r => {
        const active = r.sessionId === activeId
        return (
          <button
            key={r.sessionId}
            type="button"
            onClick={() => navigate(sessionPath(r.sessionId))}
            title={r.title || r.model}
            style={{
              display: 'flex', alignItems: 'center', gap: 8, width: '100%', minHeight: tap, padding: '6px 9px', borderRadius: 9,
              border: 'none', textAlign: 'left', cursor: 'pointer', fontFamily: 'inherit',
              background: active ? 'var(--bg-elevated)' : 'transparent', color: 'var(--text-primary)',
            }}
          >
            <HarnessMark harness={NATIVE_HARNESS_ID} size={16} />
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12.5 }}>
              {r.title || r.model}
            </span>
            <span style={{ fontSize: 10.5, color: 'var(--text-tertiary)', flexShrink: 0 }}>
              {r.status === 'open' ? r.model : (pt ? 'encerrada' : 'ended')}
            </span>
          </button>
        )
      })}
    </div>
  )
}

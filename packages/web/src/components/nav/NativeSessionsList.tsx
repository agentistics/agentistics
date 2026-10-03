/**
 * NativeSessionsList — the NATIVE Agentistics sessions in the sessions aside (UI.3): a way back to
 * one after leaving it. A native session is not a fleet row (no process, no tmux), so the fleet's
 * own list never shows it; this reads the engine's list (`GET /api/runtime/sessions`) instead, only
 * where the engine provides the native runtime, and renders nothing when there are none.
 */
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { HarnessMark } from '../sessions/HarnessMark'
import { useEngineCaps } from '../../hooks/useEngineCaps'
import { CREATE_URL, NATIVE_HARNESS_ID, NATIVE_HARNESS_LABEL } from '../../lib/nativeSession'
import { sessionPath } from '../../lib/sessionRoute'

interface Row { sessionId: string; title?: string; model: string; status: string; updatedAt: string }

const REFRESH_MS = 15_000

export function NativeSessionsList({ lang, activeId, tap }: { lang: 'pt' | 'en'; activeId?: string; tap?: number }) {
  const pt = lang === 'pt'
  const { nativeRuntime } = useEngineCaps()
  const navigate = useNavigate()
  const [rows, setRows] = useState<Row[]>([])

  useEffect(() => {
    if (nativeRuntime !== true) return
    let live = true
    const read = () => fetch(`${CREATE_URL}?limit=20`)
      .then(r => (r.ok ? r.json() : null))
      .then((b: { sessions?: Row[] } | null) => { if (live && b?.sessions) setRows(b.sessions) })
      .catch(() => {})
    void read()
    const t = setInterval(read, REFRESH_MS)
    return () => { live = false; clearInterval(t) }
  }, [nativeRuntime, activeId])

  if (nativeRuntime !== true || rows.length === 0) return null
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

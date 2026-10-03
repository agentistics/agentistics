/**
 * NativeSessionActions — H21 in the native session's header: FORK it (a new session with this one's
 * settings and its history up to the last finished turn; the page moves to it) and EXPORT it (Markdown
 * or JSON, a download the engine builds: a call that touched secrets is withheld whole, the rest is
 * redacted). Fork waits for a run to end; export does not need to.
 */
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Download, GitFork, MoreHorizontal } from 'lucide-react'
import { exportUrl, forkUrl, refusalSentence } from '../../lib/nativeSession'
import { sessionPath } from '../../lib/sessionRoute'

export function NativeSessionActions({ sessionId, running, lang }: { sessionId: string; running: boolean; lang: 'pt' | 'en' }) {
  const pt = lang === 'pt'
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const wrap = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const fork = async () => {
    setOpen(false)
    try {
      const res = await fetch(forkUrl(sessionId), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      const body = await res.json().catch(() => null) as { session?: { sessionId?: string } } | null
      if (!res.ok || !body?.session?.sessionId) { setError(refusalSentence(body, res.status, lang)); return }
      setError(null)
      navigate(sessionPath(body.session.sessionId))
    } catch {
      setError(pt ? 'Erro de rede ao criar o fork.' : 'Network error forking the session.')
    }
  }

  const item = { display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 10px', border: 'none', background: 'none', color: 'var(--text-secondary)', fontSize: 12.5, cursor: 'pointer', textAlign: 'left', textDecoration: 'none', boxSizing: 'border-box' } as const
  return (
    <div ref={wrap} data-testid="native-session-actions" style={{ position: 'relative', flexShrink: 0 }}>
      <button type="button" onClick={() => setOpen(o => !o)} aria-haspopup="menu" aria-expanded={open}
        aria-label={pt ? 'Ações da sessão' : 'Session actions'}
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 34, height: 34, borderRadius: 9, border: 'none', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer' }}>
        <MoreHorizontal size={17} />
      </button>
      {open && (
        <div role="menu" style={{ position: 'absolute', right: 0, top: 38, zIndex: 20, minWidth: 220, maxWidth: 'calc(100vw - 32px)', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 10, padding: 4, boxShadow: '0 8px 24px rgba(0,0,0,0.18)' }}>
          <button type="button" role="menuitem" disabled={running} onClick={() => void fork()} style={{ ...item, opacity: running ? 0.5 : 1 }}
            title={running ? (pt ? 'Espere a run terminar.' : 'Wait for the run to end.') : undefined}>
            <GitFork size={14} /> {pt ? 'Fork a partir do último turno' : 'Fork from the last turn'}
          </button>
          <a role="menuitem" href={exportUrl(sessionId, 'md')} download onClick={() => setOpen(false)} style={item}>
            <Download size={14} /> {pt ? 'Exportar (Markdown)' : 'Export (Markdown)'}
          </a>
          <a role="menuitem" href={exportUrl(sessionId, 'json')} download onClick={() => setOpen(false)} style={item}>
            <Download size={14} /> {pt ? 'Exportar (JSON)' : 'Export (JSON)'}
          </a>
          <div style={{ padding: '6px 10px', fontSize: 11, color: 'var(--text-tertiary)' }}>
            {pt ? 'O export oculta segredos e omite chamadas sensíveis.' : 'The export redacts secrets and withholds sensitive calls.'}
          </div>
        </div>
      )}
      {error && (
        <div role="alert" style={{ position: 'absolute', right: 0, top: 38, zIndex: 19, maxWidth: 'min(320px, calc(100vw - 32px))', padding: '6px 10px', borderRadius: 8, background: 'var(--bg-elevated)', color: 'var(--accent-red)', fontSize: 12, border: '1px solid var(--border)' }}
          onClick={() => setError(null)}>
          {error}
        </div>
      )}
    </div>
  )
}

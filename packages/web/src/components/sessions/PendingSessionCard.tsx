/**
 * PendingSessionCard — the aside's own placeholder for a session that was just started, rendered
 * right under `IdleReviewCard` (see `SessionsAside.tsx`, which reconciles the store against the
 * fleet on every poll). Reads `lib/pendingSessionStore.ts` rather than taking props, for the exact
 * reason `IdleReviewCard` does: two mounts of this same aside must never disagree.
 *
 * A row that RESOLVES (the real one lands in the fleet) is dropped silently by the store — nothing
 * to draw here. A row that EXPIRES stays on screen as a failure, because a placeholder that just
 * vanishes reads exactly like the report this feature exists to fix: "parece que não criou nada".
 */
import { Loader, X } from 'lucide-react'
import { HarnessMark } from './HarnessMark'
import { dismissFailedPending, usePendingSessions } from '../../lib/pendingSessionStore'
import type { PendingSession } from '../../lib/pendingSession'

function PendingRow({
  lang, session, failed, tap,
}: { lang: 'pt' | 'en'; session: PendingSession; failed: boolean; tap?: number }) {
  const pt = lang === 'pt'
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '8px 9px', borderRadius: 9, marginBottom: 6,
      background: 'var(--bg-elevated)',
      border: `1px solid ${failed ? 'var(--accent-red)' : 'var(--border-subtle)'}`,
    }}>
      {session.harness
        ? <HarnessMark harness={session.harness} size={18} />
        : <span style={{ width: 18, flexShrink: 0 }} />}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
        <span style={{
          fontSize: 12, fontWeight: 600, color: 'var(--text-primary)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {session.label || (pt ? 'Nova sessão' : 'New session')}
        </span>
        <span style={{ fontSize: 11, color: failed ? 'var(--accent-red)' : 'var(--text-tertiary)' }}>
          {failed
            ? (pt
              ? 'A sessão não apareceu — pode não ter iniciado.'
              : 'The session did not appear — it may have failed to start.')
            : (pt ? 'Iniciando…' : 'Starting…')}
        </span>
      </div>
      {failed ? (
        <button
          type="button"
          onClick={() => dismissFailedPending(session.id)}
          aria-label={pt ? 'Dispensar' : 'Dismiss'}
          title={pt ? 'Dispensar' : 'Dismiss'}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            width: tap ?? 24, minHeight: tap ?? 24, padding: 0, borderRadius: 6, cursor: 'pointer',
            border: '1px solid var(--border-subtle)', background: 'transparent', color: 'var(--text-tertiary)',
          }}
        >
          <X size={12} />
        </button>
      ) : (
        <Loader size={14} className="ag-working-spin" style={{ flexShrink: 0, color: 'var(--text-tertiary)' }} />
      )}
    </div>
  )
}

export function PendingSessionCard({ lang, tap }: { lang: 'pt' | 'en'; tap?: number }) {
  const { pending, failed } = usePendingSessions()
  if (pending.length === 0 && failed.length === 0) return null
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {pending.map(s => <PendingRow key={s.id} lang={lang} session={s} failed={false} tap={tap} />)}
      {failed.map(s => <PendingRow key={s.id} lang={lang} session={s} failed tap={tap} />)}
    </div>
  )
}

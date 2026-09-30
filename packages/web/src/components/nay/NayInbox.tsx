/**
 * NayInbox.tsx — the sessions still waiting on the person, at the top of the Nay tab.
 *
 * The notification card leaves after a few seconds; this list keeps what it announced until the
 * session no longer needs anybody (answered, or back at work) — the store reconciles it against the
 * fleet on every poll, so it never accumulates. Tapping a row opens that session in the dock, the
 * same thing a card's "Responder" does. The Nay button carries the count as a badge.
 */

import type { CSSProperties } from 'react'
import { X } from 'lucide-react'
import type { HarnessId } from '@agentistics/core'
import { HARNESS_COLORS, HARNESS_LABELS } from '../../lib/harness'
import { formatWaiting, type NayAlert } from '../../lib/nayNotify'
import { inboxRemove } from '../../lib/nayNotifyStore'

const KIND: Record<NayAlert['kind'], { pt: string; en: string; fg: string; bg: string }> = {
  turn: { pt: 'precisa de você', en: 'needs you', fg: 'var(--anthropic-orange-light)', bg: 'var(--anthropic-orange-dim)' },
  approval: { pt: 'pede aprovação', en: 'needs approval', fg: 'var(--accent-red)', bg: 'var(--accent-red-dim)' },
  stale: { pt: 'sem abrir', en: 'not opened', fg: 'var(--text-secondary)', bg: 'var(--border)' },
}

export interface NayInboxProps {
  entries: readonly NayAlert[]
  lang: 'pt' | 'en'
  isMobile: boolean
  onOpen: (sessionId: string) => void
}

export function NayInbox({ entries, lang, isMobile, onOpen }: NayInboxProps) {
  const pt = lang === 'pt'
  if (entries.length === 0) return null
  const now = Date.now()
  const chip: CSSProperties = { fontSize: 10.5, padding: '2px 6px', borderRadius: 5, whiteSpace: 'nowrap', flexShrink: 0 }
  // Newest first: the one that just asked is the one most likely to be wanted.
  const list = [...entries].sort((a, b) => b.sinceMs - a.sinceMs)
  return (
    <section aria-label={pt ? 'Avisos' : 'Notifications'}
      style={{ flexShrink: 0, borderBottom: '1px solid var(--border)', padding: isMobile ? '8px 12px' : '6px 10px', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 4, maxHeight: '40%', overflowY: 'auto', overscrollBehavior: 'contain' }}>
      <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--text-tertiary)' }}>
        {pt ? `Esperando por você · ${entries.length}` : `Waiting for you · ${entries.length}`}
      </div>
      {list.map(a => {
        const k = KIND[a.kind]
        const harness = a.harness ? (HARNESS_LABELS[a.harness as HarnessId] ?? a.harness) : null
        return (
          <div key={a.key} style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
            <button type="button" onClick={() => onOpen(a.sessionId)}
              style={{
                flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 8, textAlign: 'left',
                minHeight: isMobile ? 44 : 34, padding: '4px 8px', borderRadius: 8, border: '1px solid var(--border)',
                background: 'var(--bg-elevated)', color: 'var(--text-primary)', fontFamily: 'inherit', fontSize: 12.5, cursor: 'pointer',
              }}>
              {harness && <span aria-hidden style={{ width: 7, height: 7, borderRadius: '50%', flexShrink: 0, background: HARNESS_COLORS[a.harness as HarnessId] ?? 'var(--text-tertiary)' }} />}
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 }}>{a.name}</span>
              <span style={{ ...chip, background: k.bg, color: k.fg }}>{k[lang]}</span>
              <span style={{ fontSize: 11, color: 'var(--text-tertiary)', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
                {formatWaiting(a.sinceMs, now, a.sinceKnown, lang)}
              </span>
            </button>
            <button type="button" aria-label={pt ? `Tirar ${a.name} dos avisos` : `Remove ${a.name} from notifications`}
              onClick={() => inboxRemove(a.sessionId)} className="ag-tap-icon"
              style={{ width: 26, height: 26, flexShrink: 0, border: 'none', borderRadius: 6, background: 'transparent', color: 'var(--text-tertiary)', cursor: 'pointer', display: 'grid', placeItems: 'center' }}>
              <X size={13} />
            </button>
          </div>
        )
      })}
    </section>
  )
}

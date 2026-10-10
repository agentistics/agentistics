import { useEffect, useState } from 'react'
import { Checkbox } from '../pages/settings/primitives'
import { X, Sparkles, ExternalLink } from 'lucide-react'
import { overlayPadding } from '../lib/mobileOverlay'
import type { ReleaseEntry } from '../whatsNew/select'

interface Props {
  entries: ReleaseEntry[]
  lang: 'pt' | 'en'
  isMobile: boolean
  onClose: () => void
  /** Opened by itself after an update: offers "Don't show again". */
  autoOpened?: boolean
  onDontShow?: (dontShow: boolean) => void
}

export const RELEASES_URL = 'https://github.com/agentistics/agentistics/releases'

const T = {
  pt: { title: 'Novidades', features: 'Novidades', fixes: 'Correções', all: 'Ver todas as versões', close: 'Fechar', never: 'Não mostrar novamente' },
  en: { title: "What's new", features: 'New', fixes: 'Fixes', all: 'See all versions', close: 'Close', never: "Don't show again" },
}

/** One version's notes — shared by the modal and Settings → What's new, so the two read the same. */
export function ReleaseSection({ entry, lang, first }: { entry: ReleaseEntry; lang: 'pt' | 'en'; first?: boolean }) {
  const t = T[lang]
  const group = (label: string, lines: { pt: string; en: string }[]) => lines.length === 0 ? null : (
    <div style={{ marginTop: 12 }}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', color: 'var(--text-tertiary)', marginBottom: 6 }}>{label}</div>
      <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 5 }}>
        {lines.map((l, i) => <li key={i} style={{ fontSize: 13, lineHeight: 1.55, color: 'var(--text-secondary)' }}>{l[lang]}</li>)}
      </ul>
    </div>
  )
  return (
    <section data-testid={`release-${entry.version}`} style={{ padding: '14px 0', borderTop: first ? 'none' : '1px solid var(--border)' }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>v{entry.version}</div>
      {group(t.features, entry.features)}
      {group(t.fixes, entry.fixes)}
    </section>
  )
}

/** The sheet the "Updated to vX" notification opens: curated notes for every version since the last one seen. */
export function WhatsNewModal({ entries, lang, isMobile, onClose, autoOpened, onDontShow }: Props) {
  const t = T[lang]
  const [never, setNever] = useState(false)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      onClick={onClose}
      data-testid="whats-new-modal"
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(4px)',
        display: 'flex', alignItems: isMobile ? 'stretch' : 'center', justifyContent: 'center',
        padding: overlayPadding(isMobile, 16),
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t.title}
        onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--bg-surface)',
          border: isMobile ? 'none' : '1px solid var(--border)',
          borderRadius: isMobile ? 0 : 16,
          boxShadow: '0 24px 64px rgba(0,0,0,0.4)',
          maxWidth: isMobile ? '100%' : 520,
          width: '100%',
          maxHeight: isMobile ? '100%' : 'min(640px, calc(100vh - 32px))',
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 20px 14px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            <div style={{ width: 36, height: 36, borderRadius: 10, flexShrink: 0, background: 'var(--anthropic-orange-dim)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Sparkles size={18} color="var(--anthropic-orange)" />
            </div>
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>{t.title}</div>
          </div>
          <button
            onClick={onClose}
            aria-label={t.close}
            className="ag-tap-icon"
            style={{ background: 'none', border: 'none', cursor: 'pointer', position: 'relative', color: 'var(--text-secondary)', width: 32, height: 32, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
          >
            <X size={18} />
          </button>
        </div>

        <div style={{ overflowY: 'auto', WebkitOverflowScrolling: 'touch', padding: '4px 20px 8px', flex: 1, minHeight: 0 }}>
          {entries.map((e, idx) => (
            <ReleaseSection key={e.version} entry={e} lang={lang} first={idx === 0} />
          ))}
        </div>

        <div style={{ padding: '12px 20px 16px', borderTop: '1px solid var(--border)', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <a
            href={RELEASES_URL}
            target="_blank"
            rel="noreferrer"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 5, minHeight: isMobile ? 44 : undefined, fontSize: 12, fontWeight: 600, color: 'var(--anthropic-orange-light)', textDecoration: 'none' }}
          >
            <ExternalLink size={12} /> {t.all}
          </a>
          {autoOpened && onDontShow && (
            <Checkbox checked={never} onChange={v => { setNever(v); onDontShow(v) }} label={t.never} />
          )}
        </div>
      </div>
    </div>
  )
}

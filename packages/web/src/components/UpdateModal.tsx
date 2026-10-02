import { useEffect, useCallback, type ReactNode } from 'react'
import { X, ArrowUpCircle, ExternalLink } from 'lucide-react'
import type { Lang } from '@agentistics/core'
import { ut } from '../lib/updateI18n'
import { startUpgrade } from '../lib/upgradeFlow'

interface Props {
  current: string
  latest: string
  critical?: boolean
  lang: Lang
  /** "Remind me later" — the same per-person snooze the popup stores. */
  onLater: () => void
  onClose: () => void
}

/**
 * The bell's sheet for an available update — what clicking the bell entry opens.
 *
 * It is the SAME install flow as the popup in the Nay window: "Install now" is the one
 * `startUpgrade` (`upgradeFlow.ts`), and the loader that follows is `UpgradeOverlay`, mounted once
 * by `App.tsx`. This sheet used to carry its own poll loop; that loop now lives in the flow so two
 * buttons cannot wait for one machine in two ways.
 *
 * Owner rule (2026-10-02): the web interface never shows or suggests the CLI path — no command, no
 * copy box, no "or do it in a terminal". In the UI, updating is the button only. It is mounted only
 * where the button works (a local installed binary; `updateToast.ts` → `shouldShowToast`), so there
 * is no fallback to explain.
 */
export function UpdateModal({ current, latest, critical, lang, onLater, onClose }: Props) {
  const handleKey = useCallback(
    (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() },
    [onClose],
  )

  useEffect(() => {
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [handleKey])

  const install = () => {
    onClose()
    void startUpgrade(latest, lang === 'pt' ? 'pt' : 'en')
  }

  return (
    <div
      onClick={onClose}
      data-testid="update-modal"
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 16,
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={ut(lang, 'prompt.title')}
        onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--bg-surface)',
          border: '1px solid var(--border)',
          borderRadius: 16,
          boxShadow: '0 24px 64px rgba(0,0,0,0.4)',
          maxWidth: 460,
          width: '100%',
          overflow: 'hidden',
        }}
      >
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '18px 20px 14px',
          borderBottom: '1px solid var(--border)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            <div style={{
              width: 36, height: 36, borderRadius: 10, flexShrink: 0,
              background: 'var(--anthropic-orange-dim)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <ArrowUpCircle size={18} color="var(--anthropic-orange)" />
            </div>
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>
              {ut(lang, 'prompt.title')}
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label={ut(lang, 'prompt.close')}
            className="ag-tap-icon"
            style={{
              background: 'none', border: 'none', cursor: 'pointer', position: 'relative',
              color: 'var(--text-secondary)', width: 32, height: 32, borderRadius: 8,
              display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            }}
          >
            <X size={18} />
          </button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '18px 20px 6px', flexWrap: 'wrap' }}>
          <VersionPill version={current} dim />
          <div style={{ color: 'var(--text-tertiary)', fontSize: 18 }}>→</div>
          <VersionPill version={latest} />
        </div>

        <div style={{ padding: '8px 20px 4px' }}>
          <p style={{ fontSize: 12.5, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.6 }}>
            {ut(lang, 'prompt.body')}
          </p>
          {critical && (
            <p style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--accent-red)', margin: '8px 0 0', lineHeight: 1.5 }}>
              {ut(lang, 'prompt.critical')}
            </p>
          )}
          <a
            href={`https://github.com/agentistics/agentistics/releases/tag/v${latest}`}
            target="_blank"
            rel="noreferrer"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 5, marginTop: 10, fontSize: 12, fontWeight: 600, color: 'var(--anthropic-orange-light)', textDecoration: 'none' }}
          >
            <ExternalLink size={12} /> {ut(lang, 'prompt.release_notes')}
          </a>
        </div>

        <div style={{ display: 'flex', gap: 8, padding: '16px 20px 20px', flexWrap: 'wrap' }}>
          <Btn primary onClick={install} icon={<ArrowUpCircle size={16} />}>{ut(lang, 'prompt.install')}</Btn>
          <Btn onClick={() => { onLater(); onClose() }}>{ut(lang, 'prompt.later')}</Btn>
        </div>
      </div>
    </div>
  )
}

function Btn({ primary, onClick, icon, children }: { primary?: boolean; onClick: () => void; icon?: ReactNode; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8,
        // @touch-intentional — a dialog's actions are full buttons and keep 44px of paint everywhere.
        flex: primary ? '1 1 180px' : '0 1 auto', minHeight: 44, padding: '0 16px', borderRadius: 10, cursor: 'pointer',
        fontFamily: 'inherit', fontSize: 13.5, fontWeight: primary ? 700 : 600,
        border: primary ? 'none' : '1px solid var(--border)',
        background: primary ? 'var(--anthropic-orange)' : 'transparent',
        color: primary ? '#fff' : 'var(--text-secondary)',
      }}
    >
      {icon}{children}
    </button>
  )
}

function VersionPill({ version, dim }: { version: string; dim?: boolean }) {
  return (
    <div style={{
      padding: '8px 14px', borderRadius: 10,
      background: dim ? 'var(--bg-card)' : 'color-mix(in srgb, var(--accent-green) 10%, transparent)',
      border: `1px solid ${dim ? 'var(--border)' : 'color-mix(in srgb, var(--accent-green) 30%, transparent)'}`,
      fontSize: 18, fontWeight: 800, letterSpacing: '-0.02em',
      color: dim ? 'var(--text-tertiary)' : 'var(--accent-green)',
    }}>
      v{version}
    </div>
  )
}

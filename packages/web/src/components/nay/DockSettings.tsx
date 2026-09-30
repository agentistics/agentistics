/**
 * DockSettings.tsx — the gear in the Nay dock's header, and the settings SCREEN it opens inside the
 * chat window. The screen draws `NaySettingsPanel`, the very component Settings → Chat draws, so the
 * two places show the same groups, the same words and the same values (owner, 2026-09-30).
 */

import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, ArrowUpRight, Settings2 } from 'lucide-react'
import { NaySettingsPanel, type ChatSoundCtx } from './NaySettingsPanel'

export interface DockSettingsProps {
  pt: boolean
  isMobile: boolean
  chat: ChatSoundCtx
  /** Called before leaving for the full Settings screen, so the dock can get out of the way. */
  onLeave: () => void
}

export interface DockSettingsButtonProps {
  pt: boolean
  isMobile: boolean
  open: boolean
  onToggle: () => void
}

/**
 * The gear in the dock's header. It used to open a dropdown the owner found hard to use (2026-09-30);
 * it now opens the chat window's own SETTINGS SCREEN (`DockSettingsScreen`), which replaces the
 * conversation until its back button is pressed.
 */
export function DockSettings({ pt, isMobile, open, onToggle }: DockSettingsButtonProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={pt ? 'Ajustes do chat' : 'Chat settings'}
      aria-pressed={open}
      title={pt ? 'Ajustes do chat' : 'Chat settings'}
      className={isMobile ? 'ag-tap-icon' : undefined}
      style={{
        width: 30, height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center', border: 'none',
        borderRadius: 7, cursor: 'pointer', color: open ? 'var(--text-primary)' : 'var(--text-secondary)',
        background: open ? 'var(--bg-hover, rgba(127,127,127,0.1))' : 'transparent',
      }}
    >
      <Settings2 size={15} />
    </button>
  )
}

/**
 * The chat window's settings SCREEN: the shared `NaySettingsPanel` (the same one Settings → Chat
 * draws), scrolling inside the window, with a back button. `Escape` goes back too, unless a
 * `Select` inside is open — that one closes itself first (its list is portalled to `body`, so the
 * check looks there).
 */
export function DockSettingsScreen({ pt, isMobile, chat, onLeave, onBack }: DockSettingsProps & { onBack: () => void }) {
  const navigate = useNavigate()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (document.querySelector('[role="listbox"]')) return
      e.stopPropagation(); onBack()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onBack])

  return (
    <div role="region" aria-label={pt ? 'Ajustes do chat' : 'Chat settings'}
      style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        <button type="button" onClick={onBack} aria-label={pt ? 'Voltar à conversa' : 'Back to the conversation'}
          style={{
            display: 'flex', alignItems: 'center', gap: 4, minHeight: isMobile ? 44 : 30, padding: '0 8px', borderRadius: 7,
            border: 'none', background: 'transparent', color: 'var(--text-secondary)', fontFamily: 'inherit', fontSize: 12.5, cursor: 'pointer',
          }}>
          <ArrowLeft size={15} />{pt ? 'Voltar' : 'Back'}
        </button>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>{pt ? 'Ajustes do chat' : 'Chat settings'}</span>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', padding: isMobile ? 12 : 10, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <NaySettingsPanel pt={pt} isMobile={isMobile} layout="stack" chat={chat} />
        <button type="button" onClick={() => { onBack(); onLeave(); navigate('/settings/chat') }}
          style={{
            display: 'flex', alignItems: 'center', gap: 4, alignSelf: 'flex-start', border: 'none', padding: 0,
            minHeight: isMobile ? 44 : undefined,
            background: 'transparent', color: 'var(--text-secondary)', fontFamily: 'inherit', fontSize: 12, cursor: 'pointer',
            textDecoration: 'underline', textUnderlineOffset: 3,
          }}>
          {pt ? 'Abrir em Ajustes → Chat' : 'Open in Settings → Chat'}<ArrowUpRight size={12} />
        </button>
      </div>
    </div>
  )
}

/**
 * ChatSelectionBar — the header's face while a conversation is in SELECTION MODE.
 *
 * "N selected · Forward · Copy · Cancel", drawn IN PLACE OF the header's usual contents by whichever
 * header is on screen (`App.tsx`'s desktop strip, `SessionsPage`'s phone bar). The state comes from
 * `chatSelection.ts`; this component owns nothing and does nothing on its own.
 *
 * Esc leaves the mode — handled by the chat, which owns the selection, so the key works whether or
 * not the focus is in this bar.
 */
import type { CSSProperties } from 'react'
import { Copy, Forward, X } from 'lucide-react'
import { useIsMobile } from '../../hooks/useIsMobile'
import { useChatSelection, type ChatSelectionState } from '../../lib/chatSelection'
import { selectionCountLabel } from '../../lib/chatForward'

export function ChatSelectionBar({ sel, lang }: { sel: ChatSelectionState; lang: 'pt' | 'en' }) {
  const pt = lang === 'pt'
  const isMobile = useIsMobile()
  const tap = isMobile ? 44 : 32
  const none = sel.count === 0
  const btn = (enabled: boolean): CSSProperties => ({
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
    minHeight: tap, minWidth: tap, padding: isMobile ? '0 8px' : '0 11px', borderRadius: 8,
    border: '1px solid var(--border)', background: 'transparent',
    color: enabled ? 'var(--text-primary)' : 'var(--text-tertiary)',
    opacity: enabled ? 1 : 0.5, cursor: enabled ? 'pointer' : 'default',
    fontFamily: 'inherit', fontSize: 12.5, flexShrink: 0,
  })
  return (
    <div
      role="toolbar"
      aria-label={pt ? 'Mensagens selecionadas' : 'Selected messages'}
      style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 }}
    >
      <button
        onClick={sel.cancel}
        aria-label={pt ? 'Cancelar seleção' : 'Cancel selection'}
        title={pt ? 'Cancelar (esc)' : 'Cancel (esc)'}
        style={{ ...btn(true), border: 'none', padding: 0, width: tap }}
      >
        <X size={isMobile ? 20 : 16} />
      </button>
      <span role="status" style={{
        fontSize: 13.5, fontWeight: 650, color: 'var(--text-primary)', minWidth: 0, flex: 1,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {selectionCountLabel(sel.count, pt)}
      </span>
      <button onClick={() => { if (!none) sel.forward() }} disabled={none} style={btn(!none)}
        aria-label={pt ? 'Encaminhar' : 'Forward'} title={pt ? 'Encaminhar' : 'Forward'}>
        <Forward size={15} style={{ color: 'var(--anthropic-orange)' }} />
        {!isMobile && (pt ? 'Encaminhar' : 'Forward')}
      </button>
      <button onClick={() => { if (!none) sel.copy() }} disabled={none} style={btn(!none)}
        aria-label={pt ? 'Copiar' : 'Copy'} title={pt ? 'Copiar' : 'Copy'}>
        <Copy size={15} />
        {!isMobile && (pt ? 'Copiar' : 'Copy')}
      </button>
      {!isMobile && (
        <button onClick={sel.cancel} style={btn(true)}>
          {pt ? 'Cancelar' : 'Cancel'}
        </button>
      )}
    </div>
  )
}

/**
 * The bar, laid OVER a header while a selection is live and nothing otherwise. The header keeps its
 * own contents and layout underneath — only covered — so leaving the mode restores it exactly, and
 * neither header had to be restructured to host a second face. The parent must be
 * `position: relative`.
 */
export function ChatSelectionOverlay({ lang, padX }: { lang: 'pt' | 'en'; padX: number }) {
  const sel = useChatSelection()
  if (!sel) return null
  return (
    <div style={{
      position: 'absolute', inset: 0, zIndex: 5,
      display: 'flex', alignItems: 'center', padding: `0 ${padX}px`, boxSizing: 'border-box',
      paddingTop: 'var(--safe-top, 0px)',
      background: 'var(--bg-surface)',
    }}>
      <ChatSelectionBar sel={sel} lang={lang} />
    </div>
  )
}

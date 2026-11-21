/**
 * BrowserFollowChip — the top-bar chip "● <session title> · <state>" the approved prototype draws while a
 * session's browser (A1) floats over another page (`opcao-final.html`, `.followchip`). The dot and the state word
 * come from the live fleet row; a click raises the window (restoring it if it was minimized). It is not drawn on
 * the session's own page (the conversation strip says it there) and not while the window is minimized (the
 * minimized chip already is the handle).
 */
import { useLocation } from 'react-router-dom'
import { useFleet, type FleetRow } from '../../lib/fleet'
import { useIsMobile } from '../../hooks/useIsMobile'
import { managedIdOf, restoreBrowser, updateBrowserWindows, useBrowserWindows } from '../../lib/browserWindows'

type Lang = 'pt' | 'en'

const STATE_WORD: Record<Lang, Partial<Record<FleetRow['state'], string>>> = {
  pt: { working: 'trabalhando', waiting: 'precisa de você', 'waiting-approval': 'precisa de aprovação', idle: 'ociosa', exited: 'encerrada', lost: 'desconectada', closed: 'fechada', unknown: 'externa' },
  en: { working: 'working', waiting: 'needs you', 'waiting-approval': 'needs approval', idle: 'idle', exited: 'ended', lost: 'disconnected', closed: 'closed', unknown: 'external' },
}

/** Pure: the chip's text and dot colour for a session's state. */
export function followChipView(row: Pick<FleetRow, 'title' | 'state'> | undefined, fallbackTitle: string | undefined, lang: Lang): { text: string; dot: string } {
  const title = row?.title || fallbackTitle || (lang === 'pt' ? 'Navegador' : 'Browser')
  const word = row ? STATE_WORD[lang][row.state] : undefined
  const dot = !row ? 'var(--text-tertiary)'
    : row.state === 'working' ? '#22c55e'
      : row.state === 'waiting' || row.state === 'waiting-approval' ? 'var(--anthropic-orange)'
        : 'var(--text-tertiary)'
  return { text: word ? `${title} · ${word}` : title, dot }
}

export function BrowserFollowChip({ lang, enabled = true, rows }: { lang: Lang; enabled?: boolean; /** Injected in tests: the fleet rows otherwise come from `useFleet`. */ rows?: readonly Pick<FleetRow, 'id' | 'title' | 'state' | 'conversationId'>[] }) {
  const state = useBrowserWindows()
  const { pathname } = useLocation()
  const mobile = useIsMobile()
  const win = state.windows.find(w => managedIdOf(w.id) !== null && !w.minimized)
  const { fleet } = useFleet(lang, enabled && !!win && !rows)
  if (!win) return null
  const managedId = managedIdOf(win.id)!
  if (pathname === `/sessions/${managedId}` || pathname === `/sessions/${encodeURIComponent(managedId)}`) return null
  const row = (rows ?? fleet.sessions).find(r => r.id === managedId || r.conversationId === managedId)
  const { text, dot } = followChipView(row, win.title, lang)
  const label = lang === 'pt' ? `Navegador flutuando — ${text}. Trazer a janela para a frente` : `Browser floating — ${text}. Bring the window forward`
  return (
    <button type="button" data-browser-follow-chip={managedId} data-state={row?.state} aria-label={label} title={label}
      onClick={() => updateBrowserWindows(s => restoreBrowser(s, win.id))}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--text-secondary)', border: '1px solid var(--border-strong, var(--border))',
        borderRadius: 999, padding: '3px 10px', whiteSpace: 'nowrap', background: 'transparent', cursor: 'pointer', fontFamily: 'inherit',
        minHeight: mobile ? 44 : undefined, maxWidth: mobile ? 150 : 280, flexShrink: 1, minWidth: 0,
      }}>
      <span aria-hidden style={{ width: 8, height: 8, borderRadius: '50%', background: dot, flexShrink: 0 }} />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{text}</span>
    </button>
  )
}

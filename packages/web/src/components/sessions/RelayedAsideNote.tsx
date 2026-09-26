/**
 * RelayedAsideNote — what the session aside shows on a CENTRAL for a tab only the machine can fill.
 *
 * It replaces the tab's own panel instead of mounting it: that panel's first act is a request to a
 * route the central refuses (see `lib/relayedAside.ts`), and an empty pane beside a 403 says
 * "broken" where the truth is "this lives on that machine". The header keeps the panel's title and
 * its controls, so closing and moving it work exactly as they do everywhere else.
 */
import type { ReactNode } from 'react'
import { PanelRightClose } from 'lucide-react'
import { panelTitle } from '../../lib/panelMeta'
import type { TabPanelId } from '../../lib/panelSlots'

export function RelayedAsideNote({ id, lang, onClose, hideCloseButton, headerControls }: {
  id: TabPanelId
  lang: 'pt' | 'en'
  onClose: () => void
  hideCloseButton?: boolean
  headerControls?: ReactNode
}) {
  const pt = lang === 'pt'
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, minWidth: 0 }}>
      <header style={{
        display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, minWidth: 0,
        padding: '10px 12px', borderBottom: '1px solid var(--border)',
      }}>
        <span style={{
          fontSize: 12, fontWeight: 700, letterSpacing: 0.3, color: 'var(--text-primary)',
          minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {panelTitle(id, pt)}
        </span>
        <span style={{ flex: 1 }} />
        {!hideCloseButton && (
          <button
            onClick={onClose}
            aria-label={pt ? 'Fechar o painel' : 'Close the panel'}
            style={{
              display: 'flex', width: 26, height: 26, borderRadius: 7, flexShrink: 0,
              alignItems: 'center', justifyContent: 'center', border: 'none',
              background: 'transparent', color: 'var(--text-tertiary)', cursor: 'pointer',
            }}
          >
            <PanelRightClose size={15} />
          </button>
        )}
        {headerControls}
      </header>
      <p style={{ margin: 0, padding: 16, fontSize: 12.5, lineHeight: 1.55, color: 'var(--text-tertiary)' }}>
        {pt
          ? 'Isto é lido do disco e da conversa da própria máquina, e a central não tem acesso a eles. Abra esta sessão no agentistics da máquina para ver este painel. As métricas da sessão continuam disponíveis aqui.'
          : "This is read from the machine's own disk and conversation, which a central has no access to. Open this session in that machine's agentistics to see this panel. The session's metrics are still available here."}
      </p>
    </div>
  )
}

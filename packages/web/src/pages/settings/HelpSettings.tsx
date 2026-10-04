/** Settings → Help & feedback. One door onto the feedback dialog (`components/FeedbackDialog.tsx`). */
import { useOutletContext } from 'react-router-dom'
import type { AppContext } from '../../lib/app-context'
import { openFeedback } from '../../lib/feedbackStore'
import { useIsMobile } from '../../hooks/useIsMobile'
import { SectionHeader, PrefRow } from './primitives'

export default function HelpSettings() {
  const ctx = useOutletContext<AppContext>()
  const pt = ctx.lang === 'pt'
  const isMobile = useIsMobile()
  return (
    <div>
      <SectionHeader label={pt ? 'Ajuda e feedback' : 'Help & feedback'} />
      <PrefRow
        label={pt ? 'Encontrou um bug ou tem uma sugestão?' : 'Found a bug or have a suggestion?'}
        sub={pt ? 'Abre uma página do GitHub já preenchida; você envia pela sua conta. Nada é enviado daqui.'
          : 'Opens a pre-filled GitHub page; you send it from your own account. Nothing is sent from here.'}
      >
        <button type="button" onClick={() => openFeedback()} style={{
          padding: isMobile ? '0 14px' : '8px 14px', minHeight: isMobile ? 44 : undefined, borderRadius: 7, border: 'none',
          background: 'var(--anthropic-orange)', color: '#fff', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
        }}>{pt ? 'Relatar ou sugerir' : 'Report or suggest'}</button>
      </PrefRow>
    </div>
  )
}

/**
 * SessionTitleFlag — the OPEN session's own delivery flag, beside its title.
 *
 * Three headers currently draw an open session's title inline — the desktop shared header
 * (`App.tsx`), the mobile panel header and the mobile dedicated-terminal header (both in
 * `SessionsPage.tsx`) — and each used to be a candidate for pasting the same "flag icon, filled
 * orange when `task` is set, dotted outline otherwise" markup a fourth time. One gesture
 * implemented three times is the bug `task-reopen.ts` exists to have fixed once, so it lives here
 * instead and every header imports it.
 *
 * Unlinked: an outlined, dashed flag. Clicking it opens `NewTaskWizard` pre-linked to this
 * session — the same dialog `SessionTasksTab`'s own "New task for this session" composer opens,
 * so there is no second creation flow, only a new entry point into the existing one.
 *
 * Linked: a filled orange flag. Clicking it opens this session's own aside on the Deliveries tab
 * (`openArtifacts('tasks')`) — the pattern `chatNote.ts`'s `systemRef` navigation already uses for
 * "open this tab of the aside," rather than navigating away from the conversation.
 */

import { useState } from 'react'
import { Flag } from 'lucide-react'
import { openArtifacts } from '../../lib/artifactsStore'
import { NewTaskWizard } from '../tasks/NewTaskWizard'

export interface SessionTitleFlagProps {
  session: { id: string; title: string; harness?: string; task?: string }
  lang: 'pt' | 'en'
  /**
   * A task was just created and this session linked to it.
   *
   * The fleet poll would pick this up within a few seconds regardless, but calling it lets the
   * caller refresh right away so the flag fills in the same moment the dialog closes.
   */
  onLinked?: () => void
}

export function SessionTitleFlag({ session, lang, onLinked }: SessionTitleFlagProps) {
  const pt = lang === 'pt'
  const [creating, setCreating] = useState(false)
  const linked = Boolean(session.task)

  return (
    <>
      <button
        type="button"
        onClick={() => { if (linked) openArtifacts('tasks'); else setCreating(true) }}
        title={linked
          ? (pt ? `Entrega: ${session.task} — abrir` : `Delivery: ${session.task} — open`)
          : (pt ? 'Sem entrega — criar uma para esta sessão' : 'No delivery — create one for this session')}
        aria-label={linked
          ? (pt ? 'Abrir a entrega desta sessão' : "Open this session's delivery")
          : (pt ? 'Criar uma entrega para esta sessão' : 'Create a delivery for this session')}
        style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 22, height: 22, flexShrink: 0, padding: 0,
          border: 'none', borderRadius: 6, background: 'transparent', cursor: 'pointer',
          color: linked ? 'var(--anthropic-orange)' : 'var(--text-tertiary)',
        }}
      >
        <Flag
          size={13}
          {...(linked
            ? { fill: 'currentColor' }
            // Unlinked reads as an outline the reader can fill in, never a solid mark that looks
            // like a fact already recorded.
            : { strokeDasharray: '2,1.6' })}
        />
      </button>

      {creating && (
        <NewTaskWizard
          session={{
            id: session.id, title: session.title,
            ...(session.harness ? { harness: session.harness } : {}),
          }}
          onClose={() => setCreating(false)}
          onDone={() => { setCreating(false); onLinked?.() }}
        />
      )}
    </>
  )
}

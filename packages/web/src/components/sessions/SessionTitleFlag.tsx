/**
 * SessionTitleFlag — the OPEN session's own delivery control.
 *
 * It used to sit beside the title in the fixed header; the owner's drawing (design item 3) moves it
 * DOWN into the bottom bar's left end instead, alongside the panel switcher — the top bar is left
 * with only the title and its state. Three places still draw it: the bottom bar (`SessionPanel.tsx`,
 * desktop), and the mobile panel header and mobile dedicated-terminal header (both in
 * `SessionsPage.tsx`) — carried over unchanged, since a phone has no bottom band to move it into
 * (design item 4). One gesture implemented three times is the bug `task-reopen.ts` exists to have
 * fixed once, so it lives here instead and every caller imports it.
 *
 * The icon is a clipboard (lucide `ClipboardList`), not a flag — the owner's own word for what this
 * is ("a entrega") reads more naturally as a clipboard than a flag once it is not standing beside a
 * title any more, and the drawing names the icon explicitly.
 *
 * Unlinked: an outlined clipboard. Clicking it opens `NewTaskWizard` pre-linked to this session —
 * the same dialog `SessionTasksTab`'s own "New task for this session" composer opens, so there is no
 * second creation flow, only a new entry point into the existing one.
 *
 * Linked: a filled orange clipboard. Clicking it opens this session's own aside on the Deliveries
 * tab (`openArtifacts('tasks')`) — the pattern `chatNote.ts`'s `systemRef` navigation already uses
 * for "open this tab of the aside," rather than navigating away from the conversation.
 */

import { useState } from 'react'
import { ClipboardList } from 'lucide-react'
import { openArtifacts } from '../../lib/artifactsStore'
import { NewTaskWizard } from '../tasks/NewTaskWizard'

export interface SessionTitleFlagProps {
  session: { id: string; title: string; harness?: string; task?: string }
  lang: 'pt' | 'en'
  /**
   * A task was just created and this session linked to it.
   *
   * The fleet poll would pick this up within a few seconds regardless, but calling it lets the
   * caller refresh right away so the control fills in the same moment the dialog closes.
   */
  onLinked?: () => void
  /**
   * The button's own box, in pixels — 22 (the original header figure) by default, or the shared
   * `BAND_CONTROL_H` (26) where this now lives among the bottom bar's other controls, so it does not
   * stand out as a different size beside them (design item 3, and the same complaint item 3 of the
   * previous pass already fixed for every OTHER control in that bar).
   */
  size?: number
}

export function SessionTitleFlag({ session, lang, onLinked, size = 22 }: SessionTitleFlagProps) {
  const pt = lang === 'pt'
  const [creating, setCreating] = useState(false)
  const linked = Boolean(session.task)

  return (
    <>
      <button
        type="button"
        onClick={e => {
          // Stops propagation unconditionally: this control now also renders inside the bottom
          // bar's own whole-row collapse toggle (`ShellBand`/`StudioBand`), where an unstopped click
          // would both open the task dialog AND collapse the band. Harmless where there is no such
          // parent (the mobile headers) — there is nothing above it to stop.
          e.stopPropagation()
          if (linked) openArtifacts('tasks'); else setCreating(true)
        }}
        title={linked
          ? (pt ? `Entrega: ${session.task} — abrir` : `Delivery: ${session.task} — open`)
          : (pt ? 'Sem entrega — criar uma para esta sessão' : 'No delivery — create one for this session')}
        aria-label={linked
          ? (pt ? 'Abrir a entrega desta sessão' : "Open this session's delivery")
          : (pt ? 'Criar uma entrega para esta sessão' : 'Create a delivery for this session')}
        style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: size, height: size, flexShrink: 0, padding: 0,
          border: 'none', borderRadius: 6, background: 'transparent', cursor: 'pointer',
          color: linked ? 'var(--anthropic-orange)' : 'var(--text-tertiary)',
        }}
      >
        <ClipboardList
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

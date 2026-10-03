/**
 * SplitPaneHeader — one side's own header in the split sessions workspace.
 *
 * While the workspace shows two sessions side by side, the App's session strip stops naming one of
 * them (it would read as the only session on screen), and each pane carries this row instead: the
 * session's title and state, its delivery flag, its metrics chip, the chat/terminal switch, its
 * verbs, and a control that closes THIS side. The pane the person is working in is marked in the
 * product orange — that is the pane a pick from the list, a keyboard shortcut or an "open the
 * Gallery" note lands in (`lib/paneScope.ts`).
 *
 * Desktop only: a phone never splits.
 */

import { useSyncExternalStore } from 'react'
import { BellOff, MessagesSquare, TerminalSquare, X } from 'lucide-react'
import { mutedTooltip, useSessionMuted } from '../../lib/notifyMenu'
import type { CostBasis, SessionMeta } from '@agentistics/core'
import type { ControlSession } from '@agentistics/tui/control/session-fleet'
import type { FleetActionId, FleetRow } from '../../lib/fleet'
import { getActivePane, subscribeActivePane, type PaneId } from '../../lib/paneScope'
import { SessionStatsMenu } from './SessionStatsMenu'
import { SessionTitleFlag } from './SessionTitleFlag'
import { SessionActions } from './SessionActions'
import type { SessionView } from './SessionPanel'

export interface SplitPaneHeaderProps {
  pane: PaneId
  lang: 'pt' | 'en'
  session: ControlSession
  row?: FleetRow
  meta: SessionMeta | undefined
  currency: 'USD' | 'BRL'
  brlRate: number
  costBasis: CostBasis
  planFactor: number | null
  onOpenFull?: () => void
  onOpenLive: (ref?: string) => void
  onOpenTask: (ref: string) => void
  onLinked: () => void
  act: (req: { id: string; action: FleetActionId; text?: string; choice?: number; occurrence?: number })
    => Promise<{ ok: boolean; message: string; id?: string }>
  onGone: () => void
  onOpened: (id: string) => void
  onClosePane: () => void
  view: SessionView
  onViewChange: (v: SessionView) => void
}

export function SplitPaneHeader(p: SplitPaneHeaderProps) {
  const pt = p.lang === 'pt'
  const active = useSyncExternalStore(subscribeActivePane, getActivePane, () => 'main') === p.pane
  const s = p.session
  const muted = useSessionMuted(s)
  return (
    <div
      data-split-pane-header={p.pane}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, minHeight: 40, padding: '4px 10px',
        marginRight: 8, marginBottom: 6, flexShrink: 0, minWidth: 0,
        border: '1px solid var(--border)', borderRadius: 10, background: 'var(--bg-surface)',
        boxShadow: active ? 'inset 0 2px 0 var(--anthropic-orange)' : 'none',
      }}
    >
      <div style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          <span style={{
            fontSize: 13, fontWeight: 650, color: 'var(--text-primary)', minWidth: 0,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>{s.title}</span>
          {muted && (
            <span role="img" aria-label={mutedTooltip(p.lang === 'pt')} title={mutedTooltip(p.lang === 'pt')}
              style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0, color: 'var(--text-tertiary)' }}>
              <BellOff size={13} />
            </span>
          )}
          <SessionTitleFlag
            session={{
              id: s.id, title: s.title,
              ...(s.harness ? { harness: s.harness } : {}),
              ...(s.task ? { task: s.task } : {}),
            }}
            lang={p.lang}
            onLinked={p.onLinked}
          />
        </span>
        <span style={{ fontSize: 10.5, color: 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {s.stateLabel}{s.project ? ` · ${s.project}` : ''}
        </span>
      </div>

      {s.conversationId !== undefined && (
        <SessionStatsMenu
          harness={s.harness}
          sessionId={s.conversationId}
          meta={p.meta}
          lang={p.lang}
          currency={p.currency}
          brlRate={p.brlRate}
          costBasis={p.costBasis}
          planFactor={p.planFactor}
          {...(s.task ? { task: s.task } : {})}
          onOpenTask={p.onOpenTask}
          rowId={s.id}
          onOpenLive={p.onOpenLive}
          {...(p.onOpenFull ? { onOpenFull: p.onOpenFull } : {})}
          {...(s.model ? { startedModel: s.model } : {})}
          {...(s.effort ? { startedEffort: s.effort } : {})}
        />
      )}

      {/* The chat/terminal switch — a segmented control, because the two are alternatives. Absent
          where the harness can never name its conversation, exactly as in the session strip. */}
      {s.conversationBlind === undefined && (
        <div role="tablist" aria-label={pt ? 'Vista' : 'View'} style={{
          display: 'flex', gap: 2, padding: 2, borderRadius: 8,
          background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', flexShrink: 0,
        }}>
          {([
            ['chat', pt ? 'Conversa' : 'Chat', <MessagesSquare key="c" size={13} />],
            ['terminal', 'Terminal', <TerminalSquare key="t" size={13} />],
          ] as const).map(([id, label, icon]) => (
            <button
              key={id}
              role="tab"
              aria-selected={p.view === id}
              title={label}
              onClick={() => p.onViewChange(id)}
              style={{
                display: 'flex', alignItems: 'center', gap: 5, padding: '3px 8px', borderRadius: 6,
                border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 11.5,
                background: p.view === id ? 'var(--bg-surface)' : 'transparent',
                color: p.view === id ? 'var(--anthropic-orange)' : 'var(--text-tertiary)',
                fontWeight: p.view === id ? 650 : 400,
              }}
            >{icon}{label}</button>
          ))}
        </div>
      )}

      {p.row && (
        <SessionActions row={p.row} lang={p.lang} act={p.act} onGone={p.onGone} onOpened={p.onOpened} />
      )}

      <button
        onClick={p.onClosePane}
        aria-label={pt ? 'Fechar este lado' : 'Close this side'}
        title={pt ? 'Fechar este lado da divisão' : 'Close this side of the split'}
        style={{
          width: 28, height: 28, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
          border: 'none', borderRadius: 7, background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer',
        }}
      >
        <X size={15} />
      </button>
    </div>
  )
}

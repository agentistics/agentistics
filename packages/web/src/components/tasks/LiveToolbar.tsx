/**
 * LiveToolbar — the Live Delivery's filter bar, drawn the way the Agentask toolbar is (`button()`, `PanelMenu`,
 * `menuRowStyle`, one row, a trailing group) instead of a pile of loose pills (owner, 07/11).
 *
 *   ● Esteira de entregas ao vivo · 3 entregas · 2 agentes
 *   [ tarefas ▾ ] [ Todas as etapas ] [ Apenas ativas ] [ Exibir itens na fila ] [ Ordenar: Prioridade ▾ ]   ····   [ Revisões antigas ] [ Janela externa ] [ Líderes ]
 *   └──────────────────────── FILTROS ─────────────────────────────┘                                         └──────── VISÃO / AÇÕES ────────┘
 *
 * It decides nothing: the page owns every value; this file is the shape and the words.
 */

import type { CSSProperties, ReactNode } from 'react'
import { ArrowDownWideNarrow, Check } from 'lucide-react'
import { LIVE_SORTS, type LiveSortId } from '@agentistics/core'
import { button } from './board'
import { menuRowStyle, PanelMenu } from './PickerMenu'

const WORDS = (pt: boolean) => pt ? {
  filters: 'Filtros', actions: 'Visão e ações',
  onlyActive: 'Apenas ativas', showQueue: 'Exibir itens na fila',
  onlyActiveTip: 'Mostra os cartões das etapas depois da fila: Bloqueado, Em desenvolvimento, QA, Ajuste, Revisão do líder, PR / merge, CI e Publicado.',
  showQueueTip: 'Mostra os cartões da coluna Na fila.',
  allSteps: 'Todas as etapas', sort: 'Ordenar',
  sorts: { priority: 'Prioridade', 'time-in-stage': 'Tempo na etapa', recent: 'Mais recente' } as Record<LiveSortId, string>,
  sortNote: 'Prioridade: da mais alta para a mais baixa; empate pelo que está há mais tempo na etapa.',
} : {
  filters: 'Filters', actions: 'View and actions',
  onlyActive: 'Only active', showQueue: 'Show queued items',
  onlyActiveTip: 'Shows the cards of the stages after the queue: Blocked, In development, QA, Adjusting, Leader review, PR / merge, CI and Published.',
  showQueueTip: 'Shows the cards of the Queued column.',
  allSteps: 'All steps', sort: 'Sort',
  sorts: { priority: 'Priority', 'time-in-stage': 'Time in stage', recent: 'Most recent' } as Record<LiveSortId, string>,
  sortNote: 'Priority: highest first; a tie goes to the card that has been in the stage longest.',
}

export function LiveToolbar({
  pt, mobile, title, summary, summaryTitle, taskFilter, stageAll, onlyActive, showQueue, sort, onOnlyActive, onShowQueue, onSort, actions,
}: {
  pt: boolean
  mobile: boolean
  title: string
  summary: string
  /** The long form of the summary (next ETA, "updated live") — the tooltip. */
  summaryTitle: string
  /** The task multi-select, already built (it owns its chips). */
  taskFilter: ReactNode
  /** The "all steps" toggle; absent on a phone (the stage chips below do that job there). */
  stageAll?: { active: boolean; onClick: () => void }
  onlyActive: boolean
  showQueue: boolean
  sort: LiveSortId
  onOnlyActive: (v: boolean) => void
  onShowQueue: (v: boolean) => void
  onSort: (s: LiveSortId) => void
  /** Leaders, older reviews, recently left, open in a window — the right-hand group. */
  actions: ReactNode
}) {
  const w = WORDS(pt)
  const chip = (on: boolean): CSSProperties => ({
    ...button(mobile), gap: 6, flexShrink: 0,
    borderRadius: 999, padding: '0 12px',
    borderColor: on ? 'var(--anthropic-orange)' : 'var(--border)',
    background: on ? 'var(--anthropic-orange-dim)' : 'transparent',
    color: on ? 'var(--anthropic-orange-light)' : 'var(--text-secondary)',
  })
  const group: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 }
  return (
    <div data-live-toolbar style={{ display: 'grid', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', minWidth: 0 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 14, fontWeight: 650 }}>
          <span aria-hidden style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--accent-red, #ff5f5f)' }} />{title}
        </span>
        <span data-live-summary title={summaryTitle} style={{
          fontSize: 12, color: 'var(--text-tertiary)', minWidth: 0,
          ...(mobile ? { flexBasis: '100%', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' as const, overflow: 'hidden' } : {}),
        }}>{summary}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', minWidth: 0 }}>
        <div role="group" aria-label={w.filters} data-live-filters style={{ ...group, flex: mobile ? '1 1 100%' : '1 1 auto' }}>
          {taskFilter}
          {stageAll && (
            <button type="button" className="ag-tap" aria-pressed={stageAll.active} data-live-allsteps onClick={stageAll.onClick} style={chip(stageAll.active)}>{w.allSteps}</button>
          )}
          <button type="button" className="ag-tap" aria-pressed={onlyActive} data-live-only-active title={w.onlyActiveTip} onClick={() => onOnlyActive(!onlyActive)} style={chip(onlyActive)}>
            <span aria-hidden style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--anthropic-orange)' }} />{w.onlyActive}
          </button>
          <button type="button" className="ag-tap" aria-pressed={showQueue} data-live-show-queue title={w.showQueueTip} onClick={() => onShowQueue(!showQueue)} style={chip(showQueue)}>
            <span aria-hidden style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--anthropic-orange)' }} />{w.showQueue}
          </button>
          <PanelMenu
            title={w.sort} width={250} ariaLabel={`${w.sort}: ${w.sorts[sort]}`}
            triggerStyle={{ ...button(mobile), gap: 6, flexShrink: 0 }} triggerClassName="ag-tap"
            render={close => (
              <div data-live-sort-menu style={{ display: 'grid', gap: 2 }}>
                {LIVE_SORTS.map(s => (
                  <button key={s} type="button" data-live-sort={s} aria-pressed={sort === s} style={menuRowStyle(mobile, sort === s)} onClick={() => { onSort(s); close() }}>
                    <span style={{ flex: 1 }}>{w.sorts[s]}</span>{sort === s && <Check size={13} aria-hidden />}
                  </button>
                ))}
                <div style={{ fontSize: 11, color: 'var(--text-tertiary)', padding: '4px 8px 2px', lineHeight: 1.35 }}>{w.sortNote}</div>
              </div>
            )}
          >
            <ArrowDownWideNarrow size={14} aria-hidden />{w.sort}: <b data-live-sort-current style={{ fontWeight: 600 }}>{w.sorts[sort]}</b>
          </PanelMenu>
        </div>
        <div role="group" aria-label={w.actions} data-live-actions style={{ ...group, ...(mobile ? { flex: '1 1 100%' } : { marginLeft: 'auto', justifyContent: 'flex-end' }) }}>
          {actions}
        </div>
      </div>
    </div>
  )
}

export { WORDS as liveToolbarWords }

/**
 * LiveToolbar — the Live Delivery's filter bar, option C of "filtros v2" (owner, 08/11): the main choice is a
 * strip of TABS with counts instead of a pile of pills.
 *
 *   ● Esteira de entregas ao vivo · 3 entregas · 2 agentes
 *   [ tarefas ▾ ]  [ Em andamento 6 | Na fila 9 | Publicado 3 | Tudo 167 ]   ····   [ ⇅ ] [ ↗ ] [ Líderes ]
 *   └──────────── FILTROS ─────────────────────────────┘                          └─ VISÃO / AÇÕES ─┘
 *
 * The tab strip is the app's own `TabStrip` (`sessions/formBits.tsx`, with its `count`), the sort is the
 * `PanelMenu` the Agentask toolbar uses, shrunk to an icon. It decides nothing: the page owns every value;
 * this file is the shape and the words.
 */

import type { CSSProperties, ReactNode } from 'react'
import { ArrowDownWideNarrow, Check } from 'lucide-react'
import { LIVE_SORTS, LIVE_TABS, type LiveSortId, type LiveTab } from '@agentistics/core'
import { TabStrip } from '../sessions/formBits'
import { button } from './board'
import { menuRowStyle, PanelMenu } from './PickerMenu'

const WORDS = (pt: boolean) => pt ? {
  filters: 'Filtros', actions: 'Visão e ações', tabs: 'O que mostrar',
  tab: { active: 'Em andamento', queue: 'Na fila', published: 'Publicado', all: 'Tudo' } as Record<LiveTab, string>,
  tabShort: { active: 'Andamento', queue: 'Fila', published: 'Publicado', all: 'Tudo' } as Record<LiveTab, string>,
  sort: 'Ordenar',
  sorts: { priority: 'Prioridade', 'time-in-stage': 'Tempo na etapa', recent: 'Mais recente' } as Record<LiveSortId, string>,
  sortNote: 'Prioridade: da mais alta para a mais baixa; empate pelo que está há mais tempo na etapa.',
} : {
  filters: 'Filters', actions: 'View and actions', tabs: 'What to show',
  tab: { active: 'In progress', queue: 'Queued', published: 'Published', all: 'All' } as Record<LiveTab, string>,
  tabShort: { active: 'Active', queue: 'Queued', published: 'Published', all: 'All' } as Record<LiveTab, string>,
  sort: 'Sort',
  sorts: { priority: 'Priority', 'time-in-stage': 'Time in stage', recent: 'Most recent' } as Record<LiveSortId, string>,
  sortNote: 'Priority: highest first; a tie goes to the card that has been in the stage longest.',
}

export function LiveToolbar({
  pt, mobile, title, summary, summaryTitle, taskFilter, taskChips, tab, counts, onTab, sort, onSort, actions,
}: {
  pt: boolean
  mobile: boolean
  title: string
  summary: string
  /** The long form of the summary (next ETA, "updated live") — the tooltip. */
  summaryTitle: string
  /** The task multi-select, already built (it owns its chips). */
  taskFilter: ReactNode
  /** The chosen-task chips: drawn on a row of their own under the controls. */
  taskChips?: ReactNode
  tab: LiveTab
  /** What each tab prints — counted from the very cards the columns draw. */
  counts: Record<LiveTab, number>
  onTab: (t: LiveTab) => void
  sort: LiveSortId
  onSort: (s: LiveSortId) => void
  /** Leaders, recently left, open in a window — the right-hand group. */
  actions: ReactNode
}) {
  const w = WORDS(pt)
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
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', minWidth: 0 }} data-live-controls>
        <div role="group" aria-label={w.filters} data-live-filters style={{ ...group, flex: mobile ? '1 1 100%' : '1 1 auto' }}>
          {taskFilter}
          <div data-live-tabs style={mobile ? { minWidth: 0, flex: '1 1 100%' } : { flex: '0 0 auto', width: 'max-content', minWidth: 'max-content' }}>
            <TabStrip<LiveTab>
              tabs={LIVE_TABS} value={tab} onPick={onTab} label={t => (mobile ? w.tabShort : w.tab)[t]} count={t => counts[t]}
              ariaLabel={w.tabs} flush {...(mobile ? { tap: 44, variant: 'underline' as const, gap: 6 } : { natural: true, height: 32 })}
            />
          </div>
        </div>
        <div role="group" aria-label={w.actions} data-live-actions style={{ ...group, ...(mobile ? { flex: '1 1 100%' } : { marginLeft: 'auto', justifyContent: 'flex-end' }) }}>
          <PanelMenu
            title={w.sort} width={250} ariaLabel={`${w.sort}: ${w.sorts[sort]}`} align="right"
            triggerStyle={{ ...button(mobile), gap: 6, flexShrink: 0, padding: '0 10px' }} triggerClassName="ag-tap"
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
            <ArrowDownWideNarrow size={14} aria-hidden /><b hidden data-live-sort-current>{w.sorts[sort]}</b>
          </PanelMenu>
          {actions}
        </div>
      </div>
      {taskChips}
    </div>
  )
}

export { WORDS as liveToolbarWords }

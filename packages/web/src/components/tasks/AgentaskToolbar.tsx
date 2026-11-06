/**
 * AgentaskToolbar — the ONE place the board's view is arranged.
 *
 * It used to be four stacked rows: a title row with five controls, a search line, and a bar of
 * seven loose pills (Group · Columns · Hide empty · Compose · Sort · WIP · Reset). Now a single row:
 *
 *   [ search ] [ View ▾ ] [ active chips… ]  ········  [ Metrics | Board | Table ] [ + New task ]
 *
 * and everything that shapes WHAT is shown lives in the View panel (`ViewPanel`): which statuses
 * are visible and in what order, how the board/table is grouped, sort, WIP limits, empty groups,
 * "compose in progress", "Statuses & types" and "Restore default". Nothing here decides anything —
 * state stays with the page (`boardPrefs`); this file is the shape and the words.
 *
 * The panel is the app's portal popover (`PanelMenu`) on desktop and a bottom sheet on a phone
 * (the page hosts the sheet and renders `ViewPanel` inside it), so both open the same content.
 */

import type { CSSProperties, ReactNode } from 'react'
import { ArrowDown, ArrowUp, BarChart3, ChevronDown, ChevronUp, Eye, EyeOff, LayoutGrid, Plus, RotateCcw, Rows3, Search, Settings2, SlidersHorizontal, X } from 'lucide-react'
import { PRIORITY_ORDER, type SortSpec, type TaskStatusDef } from '@agentistics/core'
import { useIsMobile } from '../../hooks/useIsMobile'
import { BOARD_SORTS } from './BoardArrange'
import { button, field, liveStatusMap, microLabel, type BoardStatus } from './board'
import type { BoardView, GroupBy, LaneKey } from './boardPrefs'
import { LANE_KEYS } from './boardPrefs'
import type { Lang } from './copy'
import { PanelMenu } from './PickerMenu'
import { moveStatus } from './statusDefaults'
import { segmentBadge } from './ViewBar'

/** One thing that can be shown or hidden: a status, or (when grouped by type) a type. */
export interface VisibilityItem { id: string; label: string; color: string; count: number }

export interface ViewState {
  view: BoardView
  /** Items that exist, in their natural order. */
  items: readonly VisibilityItem[]
  /** Ids shown, in the order shown. */
  shown: readonly string[]
  /** `true` when `shown` is the factory default (nothing to restore for visibility). */
  shownIsDefault: boolean
  /** `'status'` or `'type'` — what the items are. Only the table can pick `type`. */
  groupBy: GroupBy
  lanes: LaneKey
  sort: SortSpec
  wip: Record<string, number>
  hideEmpty: boolean
  compose: boolean
}

export interface ViewActions {
  onShown: (next: string[]) => void
  onGroupBy: (g: GroupBy) => void
  onLanes: (l: LaneKey) => void
  onSort: (s: SortSpec) => void
  onWip: (w: Record<string, number>) => void
  onHideEmpty: (v: boolean) => void
  onCompose: (v: boolean) => void
  onManage: () => void
  onRestore: () => void
}

const T = (lang: Lang) => lang === 'pt'
  ? {
    view: 'Visualização', statuses: 'Status visíveis', types: 'Tipos visíveis', hidden: 'Ocultos',
    group: 'Agrupar por', byStatus: 'Status', byType: 'Tipo', lanes: 'Raias do quadro', sort: 'Ordenar',
    wip: 'Limite de cards por coluna', wipNote: 'O limite avisa, nunca bloqueia.',
    hideEmpty: 'Ocultar grupos vazios', compose: 'Compor em andamento', manage: 'Status e tipos',
    restore: 'Restaurar padrão', up: 'Subir', down: 'Descer', hide: 'Ocultar', show: 'Mostrar',
    search: 'Buscar', metrics: 'Métricas', board: 'Quadro', table: 'Tabela', newTask: 'Nova tarefa',
    none: 'Nenhuma raia', repo: 'Repositório', harness: 'Harness', priority: 'Prioridade',
    asc: 'Crescente', desc: 'Decrescente', hiding: (n: number) => `${n} oculto${n === 1 ? '' : 's'}`,
    clear: 'Remover', handOrder: 'Ordem manual',
  }
  : {
    view: 'View', statuses: 'Visible statuses', types: 'Visible types', hidden: 'Hidden',
    group: 'Group by', byStatus: 'Status', byType: 'Type', lanes: 'Board lanes', sort: 'Sort',
    wip: 'Cards per column limit', wipNote: 'A limit warns, it never blocks.',
    hideEmpty: 'Hide empty groups', compose: 'Compose in progress', manage: 'Statuses & types',
    restore: 'Restore default', up: 'Move up', down: 'Move down', hide: 'Hide', show: 'Show',
    search: 'Search', metrics: 'Metrics', board: 'Board', table: 'Table', newTask: 'New task',
    none: 'No lanes', repo: 'Repository', harness: 'Harness', priority: 'Priority',
    asc: 'Ascending', desc: 'Descending', hiding: (n: number) => `${n} hidden`,
    clear: 'Remove', handOrder: 'Hand order',
  }

/** The sort a panel treats as "nothing chosen". */
const PLAIN_SORT: SortSpec = { key: 'manual', dir: 'asc' }

/** How many things are moved off their default — the badge on the View button and the chips. */
export function activeChips(s: ViewState, lang: Lang): Array<{ id: string; label: string; clear: Partial<ViewActions> | string }> {
  const t = T(lang)
  const out: Array<{ id: string; label: string; clear: string }> = []
  const hidden = s.items.length - s.shown.length
  if (!s.shownIsDefault && hidden > 0) out.push({ id: 'visible', label: t.hiding(hidden), clear: 'visible' })
  if (s.view === 'board' && s.lanes !== 'none') out.push({ id: 'lanes', label: `${t.lanes}: ${t[s.lanes]}`, clear: 'lanes' })
  if (s.view === 'table' && s.groupBy === 'type') out.push({ id: 'groupBy', label: `${t.group} ${t.byType}`, clear: 'groupBy' })
  if (s.view === 'board' && s.sort.key !== 'manual') {
    const k = BOARD_SORTS.find(x => x.key === s.sort.key)?.label ?? String(s.sort.key)
    out.push({ id: 'sort', label: `${t.sort}: ${k} ${s.sort.dir === 'asc' ? '↑' : '↓'}`, clear: 'sort' })
  }
  const wip = Object.keys(s.wip).length
  if (s.view === 'board' && wip > 0) out.push({ id: 'wip', label: `WIP · ${wip}`, clear: 'wip' })
  if (s.hideEmpty) out.push({ id: 'hideEmpty', label: t.hideEmpty, clear: 'hideEmpty' })
  return out
}

const sectionTitle: CSSProperties = { ...microLabel, padding: '2px 2px 4px' }
const iconBtn = (mobile: boolean): CSSProperties => ({
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'none',
  border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', padding: 0,
  minWidth: mobile ? 44 : 26, minHeight: mobile ? 44 : 26, borderRadius: 6,
})

/** The panel body — hosted by a popover on desktop and by the page's bottom sheet on a phone. */
export function ViewPanel({ lang, state: s, actions: a, statuses }: {
  lang: Lang; state: ViewState; actions: ViewActions; statuses: readonly TaskStatusDef[] | null
}) {
  const t = T(lang)
  const mobile = useIsMobile()
  const byId = new Map(s.items.map(i => [i.id, i]))
  const shownItems = s.shown.map(id => byId.get(id)).filter((i): i is VisibilityItem => i !== undefined)
  const hiddenItems = s.items.filter(i => !s.shown.includes(i.id))
  const sm = liveStatusMap(statuses)
  const row: CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 6, minHeight: mobile ? 44 : 30, padding: '0 4px', borderRadius: 6,
  }
  const chip = (on: boolean): CSSProperties => ({
    ...button(mobile), height: mobile ? 44 : 28, padding: '0 10px', fontSize: 12,
    borderColor: on ? 'var(--anthropic-orange)' : 'var(--border)',
    background: on ? 'var(--anthropic-orange-dim)' : 'transparent',
    color: on ? 'var(--text-primary)' : 'var(--text-secondary)',
  })
  const check = (on: boolean, label: string, onClick: () => void, key: string) => (
    <label key={key} style={{ ...row, cursor: 'pointer', fontSize: 12.5 }}>
      <input type="checkbox" data-opt={key} checked={on} onChange={onClick} style={{ width: 16, height: 16 }} />
      <span>{label}</span>
    </label>
  )
  const listTitle = s.groupBy === 'type' ? t.types : t.statuses
  return (
    <div data-view-panel style={{ display: 'grid', gap: 14, fontSize: 12.5 }}>
      {s.view === 'table' && (
        <section>
          <div style={sectionTitle}>{t.group}</div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button type="button" data-group-by="status" style={chip(s.groupBy === 'status')} onClick={() => a.onGroupBy('status')}>{t.byStatus}</button>
            <button type="button" data-group-by="type" style={chip(s.groupBy === 'type')} onClick={() => a.onGroupBy('type')}>{t.byType}</button>
          </div>
        </section>
      )}

      {s.view !== 'overview' && (
        <section>
          <div style={sectionTitle}>{listTitle}</div>
          <div style={{ display: 'grid', gap: 1 }} data-visible-list>
            {shownItems.map((i, n) => (
              <div key={i.id} style={row} data-status-row={i.id}>
                <span style={{ width: 8, height: 8, borderRadius: 4, background: i.color, flexShrink: 0 }} />
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{i.label}</span>
                <span style={{ ...microLabel, fontSize: 10.5 }}>{i.count}</span>
                <button type="button" aria-label={t.up} disabled={n === 0} style={{ ...iconBtn(mobile), opacity: n === 0 ? 0.3 : 1 }}
                  onClick={() => a.onShown(moveStatus(s.shown, i.id, -1))}><ChevronUp size={14} /></button>
                <button type="button" aria-label={t.down} disabled={n === shownItems.length - 1} style={{ ...iconBtn(mobile), opacity: n === shownItems.length - 1 ? 0.3 : 1 }}
                  onClick={() => a.onShown(moveStatus(s.shown, i.id, 1))}><ChevronDown size={14} /></button>
                <button type="button" aria-label={`${t.hide} ${i.label}`} data-hide={i.id} style={iconBtn(mobile)}
                  onClick={() => a.onShown(s.shown.filter(x => x !== i.id))}><Eye size={14} /></button>
              </div>
            ))}
          </div>
          {hiddenItems.length > 0 && (
            <>
              <div style={{ ...sectionTitle, paddingTop: 8 }}>{t.hidden} · {hiddenItems.length}</div>
              <div style={{ display: 'grid', gap: 1 }} data-hidden-list>
                {hiddenItems.map(i => (
                  <div key={i.id} style={{ ...row, opacity: 0.8 }} data-hidden-row={i.id}>
                    <span style={{ width: 8, height: 8, borderRadius: 4, border: `1px solid ${i.color}`, flexShrink: 0 }} />
                    <span style={{ flex: 1, minWidth: 0, color: 'var(--text-tertiary)' }}>{i.label}</span>
                    <span style={{ ...microLabel, fontSize: 10.5 }}>{i.count}</span>
                    <button type="button" aria-label={`${t.show} ${i.label}`} data-show={i.id} style={iconBtn(mobile)}
                      onClick={() => a.onShown([...s.shown, i.id])}><EyeOff size={14} /></button>
                  </div>
                ))}
              </div>
            </>
          )}
        </section>
      )}

      {s.view === 'board' && (
        <>
          <section>
            <div style={sectionTitle}>{t.lanes}</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {LANE_KEYS.map(k => (
                <button key={k} type="button" data-lane={k} style={chip(s.lanes === k)} onClick={() => a.onLanes(k)}>{t[k]}</button>
              ))}
            </div>
            {s.lanes === 'priority' && (
              <div style={{ ...microLabel, paddingTop: 4, textTransform: 'none' }}>{PRIORITY_ORDER.join(' · ')}</div>
            )}
          </section>
          <section>
            <div style={sectionTitle}>{t.sort}</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              {BOARD_SORTS.map(o => {
                const on = s.sort.key === o.key
                return (
                  <button key={o.key} type="button" data-sort={o.key} style={chip(on)}
                    onClick={() => a.onSort(on && o.key !== 'manual'
                      ? { key: o.key, dir: s.sort.dir === 'asc' ? 'desc' : 'asc' }
                      : { key: o.key, dir: 'asc' })}>
                    {o.key === 'manual' ? t.handOrder : o.label}
                    {on && o.key !== 'manual' && (s.sort.dir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
                  </button>
                )
              })}
            </div>
          </section>
          <section>
            <div style={sectionTitle}>{t.wip}</div>
            <div style={{ display: 'grid', gap: 2 }}>
              {shownItems.map(i => (
                <label key={i.id} style={{ ...row, justifyContent: 'space-between' }}>
                  <span style={{ color: i.color }}>{sm[i.id]?.label ?? i.label}</span>
                  <input type="number" min={1} inputMode="numeric" aria-label={`${t.wip}: ${i.label}`}
                    value={s.wip[i.id] ?? ''} placeholder="—"
                    onChange={e => {
                      const n = Number(e.target.value)
                      const next = { ...s.wip }
                      if (!Number.isFinite(n) || n <= 0) delete next[i.id]
                      else next[i.id] = Math.floor(n)
                      a.onWip(next)
                    }}
                    style={{ ...field(mobile), width: 72, padding: '4px 8px' }} />
                </label>
              ))}
            </div>
            <div style={{ ...microLabel, textTransform: 'none', letterSpacing: 0, paddingTop: 2 }}>{t.wipNote}</div>
          </section>
        </>
      )}

      {s.view !== 'overview' && (
        <section style={{ display: 'grid', gap: 2 }}>
          {check(s.hideEmpty, t.hideEmpty, () => a.onHideEmpty(!s.hideEmpty), 'hideEmpty')}
          {s.view === 'board' && check(s.compose, t.compose, () => a.onCompose(!s.compose), 'compose')}
        </section>
      )}

      <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', borderTop: '1px solid var(--border-subtle)', paddingTop: 10 }}>
        <button type="button" data-manage style={{ ...button(mobile), gap: 6 }} onClick={a.onManage}>
          <Settings2 size={14} /> {t.manage}
        </button>
        <button type="button" data-restore style={{ ...button(mobile), gap: 6 }} onClick={a.onRestore}>
          <RotateCcw size={13} /> {t.restore}
        </button>
      </div>
    </div>
  )
}

export function AgentaskToolbar({ lang, q, onQ, state, actions, statuses, onView, onNew, onOpenSheet, onClearChip }: {
  lang: Lang
  q: string
  onQ: (v: string) => void
  state: ViewState
  actions: ViewActions
  statuses: readonly TaskStatusDef[] | null
  onView: (v: BoardView) => void
  onNew: () => void
  /** Phone: the page owns the bottom sheet; the button only asks for it. */
  onOpenSheet: () => void
  onClearChip: (id: string) => void
}) {
  const t = T(lang)
  const mobile = useIsMobile()
  const chips = activeChips(state, lang)
  const seg = (active: boolean): CSSProperties => ({
    ...button(mobile), height: mobile ? 44 : 30, border: 'none',
    background: active ? 'var(--bg-elevated)' : 'transparent',
    color: active ? 'var(--text-primary)' : 'var(--text-tertiary)',
  })
  const search: ReactNode = (
    <div style={{ position: 'relative', flex: mobile ? 1 : '0 1 280px', minWidth: 0 }}>
      <Search size={14} style={{ position: 'absolute', left: 11, top: mobile ? 15 : 9, color: 'var(--text-tertiary)' }} />
      <input
        aria-label={t.search} style={{ ...field(mobile), paddingLeft: 32, ...(mobile ? {} : { height: 32 }) }}
        value={q} placeholder={t.search} onChange={e => onQ(e.target.value)}
      />
    </div>
  )
  const viewLabel = (
    <>
      <SlidersHorizontal size={14} /> {!mobile && t.view}
      {chips.length > 0 && <span style={segmentBadge}>{chips.length}</span>}
    </>
  )
  const trigger: CSSProperties = { ...button(mobile), gap: 6, flexShrink: 0, ...(chips.length > 0 ? { borderColor: 'var(--anthropic-orange)' } : {}) }

  if (mobile) {
    // One line: search · view · new task. The panel is the page's bottom sheet.
    return (
      <div data-toolbar style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        {search}
        <button type="button" style={trigger} aria-label={t.view} onClick={onOpenSheet}>{viewLabel}</button>
        <button type="button" style={{ ...button(true, 'primary'), flexShrink: 0 }} aria-label={t.newTask} onClick={onNew}><Plus size={16} /></button>
      </div>
    )
  }
  return (
    <div data-toolbar style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      {search}
      <PanelMenu title={t.view} width={360} triggerStyle={trigger} ariaLabel={t.view}
        render={() => <ViewPanel lang={lang} state={state} actions={actions} statuses={statuses} />}>
        {viewLabel}
      </PanelMenu>
      {chips.map(c => (
        <span key={c.id} data-chip={c.id} style={{
          display: 'inline-flex', alignItems: 'center', gap: 4, height: 24, padding: '0 4px 0 9px', borderRadius: 999,
          fontSize: 11.5, background: 'var(--bg-elevated)', border: '1px solid var(--border)', color: 'var(--text-secondary)',
        }}>
          {c.label}
          <button type="button" aria-label={`${t.clear}: ${c.label}`} onClick={() => onClearChip(c.id)}
            style={{ ...iconBtn(false), minWidth: 18, minHeight: 18 }}><X size={11} /></button>
        </span>
      ))}
      <span style={{ flex: 1 }} />
      <div style={{ display: 'flex', padding: 3, gap: 2, background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}>
        <button type="button" data-view="overview" style={seg(state.view === 'overview')} onClick={() => onView('overview')}><BarChart3 size={14} /> {t.metrics}</button>
        <button type="button" data-view="board" style={seg(state.view === 'board')} onClick={() => onView('board')}><LayoutGrid size={14} /> {t.board}</button>
        <button type="button" data-view="table" style={seg(state.view === 'table')} onClick={() => onView('table')}><Rows3 size={14} /> {t.table}</button>
      </div>
      {/* Live Delivery's own segment and the pagination control land here (feat/live-delivery). */}
      <button type="button" style={button(false, 'primary')} onClick={onNew}><Plus size={15} /> {t.newTask}</button>
    </div>
  )
}

export type { BoardStatus }
export { PLAIN_SORT }

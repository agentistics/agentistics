/**
 * SessionsGroupMenu — the aside's one discreet control for how its list is arranged and shown.
 *
 * The trigger is a "view options" icon (not the old up/down arrows, which read as sort alone) and
 * wears a badge counting the options that differ from the default (`arrangeChangedCount`), the
 * same badge the filter button beside it wears. The panel groups its options BY KIND — ordering,
 * grouping, display, hidden folders — in cards, two columns on the desktop and one on a phone.
 *
 * Three questions, one popover, because they are all "how does this list organize and look":
 * which dimension the sessions are sub-grouped by, in what order those groups appear, and how a
 * session's own card shows its status color. Reordering lives inside the SAME item that picks the
 * grouping — the reorder list only makes sense once a dimension is chosen, and it always shows
 * exactly what THAT dimension is currently drawing.
 *
 * Follows the settings screens' popover contract — `position: fixed` in a portal, measured from
 * the trigger, clamped to the viewport, closing on scroll — the same contract `PickerMenu` and
 * `BoardArrange`'s panels already keep, because a menu that opens inside a scrolling list gets
 * clipped by it.
 */

import { useEffect, useRef, useState } from 'react'
import { SESSION_SORTS, type SessionOrder, type SessionSort } from '@agentistics/tui/control/session-order'
import { createPortal } from 'react-dom'
import { ChevronDown, ChevronsDownUp, ChevronsUpDown, ChevronUp, Eye, GripVertical, LayoutList } from 'lucide-react'
import { reorderByDrag, stepOrder } from '../../lib/dragReorder'
import { useIsMobile } from '../../hooks/useIsMobile'
import {
  ASIDE_CARD_COLOR_VALUES, ASIDE_GROUP_BY_VALUES,
  type AsideCardColor, type AsideGroupBy,
} from '../../lib/sessionsAsidePrefs'

const GROUP_BY_LABEL: Record<AsideGroupBy, { en: string; pt: string }> = {
  project: { en: 'Project', pt: 'Projeto' },
  task: { en: 'Task', pt: 'Tarefa' },
  status: { en: 'Status', pt: 'Status' },
}

const CARD_COLOR_LABEL: Record<AsideCardColor, { en: string; pt: string }> = {
  wash: { en: 'Background follows status', pt: 'Fundo acompanha o status' },
  neutral: { en: 'Neutral background, colored text', pt: 'Fundo neutro, texto colorido' },
  stripe: { en: 'Colored left stripe', pt: 'Barra lateral colorida' },
}

export interface SessionsGroupMenuProps {
  lang: 'pt' | 'en'
  groupBy: AsideGroupBy
  onGroupBy: (v: AsideGroupBy) => void
  /** The current dimension's groups, across both bands, deduped by key, in their EFFECTIVE order
   *  (manual order already applied) — what the reorder list edits and shows. */
  groups: readonly { key: string; label: string }[]
  /** The full new key order, every time a drag or a step button moves one. */
  onReorder: (next: string[]) => void
  cardColor: AsideCardColor
  onCardColor: (v: AsideCardColor) => void
  /** Stretch the trigger to share a row equally with its siblings instead of a fixed square. */
  fill?: boolean
  /** What the sessions inside each group are ordered by, and how to change it. */
  sort: SessionOrder
  onSort: (next: SessionOrder) => void
  /** Fold, or unfold, EVERYTHING this list can fold — Fixadas, Grupos, every folder and every
   *  automatic sub-group — in one action ("recolher tudo" / "desrecolher"). */
  onCollapseAll: () => void
  onExpandAll: () => void
  /** Folders the person hid from the list, labelled for reading (a child as "Parent › Child"). */
  hiddenFolders: readonly { id: string; name: string }[]
  onShowFolder: (id: string) => void
  /** How many options differ from the default (`arrangeChangedCount`) — the trigger's badge. */
  changed: number
}

/** The words for each ordering. `state` is first and the default: it puts what is waiting on you on
 *  top, which is what the list is for; every other key answers one question. */
const SORT_LABEL: Record<SessionSort, { pt: string; en: string }> = {
  state: { pt: 'Precisa de você primeiro', en: 'Needs you first' },
  recent: { pt: 'Atividade mais recente', en: 'Most recent activity' },
  started: { pt: 'Data de início', en: 'Start date' },
  name: { pt: 'Nome (A–Z)', en: 'Name (A–Z)' },
  project: { pt: 'Projeto', en: 'Project' },
  usage: { pt: 'Maior uso', en: 'Heaviest use' },
}

export function SessionsGroupMenu(p: SessionsGroupMenuProps) {
  const pt = p.lang === 'pt'
  const isMobile = useIsMobile()
  const tap = isMobile ? 44 : undefined
  const [open, setOpen] = useState(false)
  const [at, setAt] = useState<{ left: number; top: number } | null>(null)
  const [drag, setDrag] = useState<string | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  // Desktop: two columns of grouped sections, like the filter popover. Phone: one column, full width.
  const width = isMobile ? Math.min(window.innerWidth - 24, 420) : 500

  useEffect(() => {
    if (!open) return
    // Capture-phase on `window` so scrolling the PAGE (or any ancestor) closes a panel that can no
    // longer follow its trigger — but that also fires when the panel's OWN option list scrolls
    // (e.g. reaching the Card Color section past the fold on a fleet with many groups), which
    // closed the menu before that scroll could ever land. Only close for a scroll whose target is
    // outside this panel's own DOM subtree — same fix as PickerMenu's, in settings/primitives.tsx.
    const onScroll = (e: Event) => {
      if (panel.current && !panel.current.contains(e.target as Node)) setOpen(false)
    }
    const close = () => setOpen(false)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', close)
    }
  }, [open])

  // Shared with the panel rail's and the pinned-sessions band's own drag: `reorderByDrag` /
  // `stepOrder` in `dragReorder.ts`. This menu's reorder was the reference implementation that
  // pattern was extracted FROM — it was always correctly keyed, never by position.
  const move = (from: string, to: string) => p.onReorder(reorderByDrag(p.groups.map(g => g.key), from, to))
  const step = (key: string, by: 1 | -1) => p.onReorder(stepOrder(p.groups.map(g => g.key), key, by))

  const rowStyle = (on: boolean): React.CSSProperties => ({
    display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', textAlign: 'left',
    width: '100%', padding: '6px 8px', borderRadius: 6, fontSize: 12, fontFamily: 'inherit',
    minHeight: tap,
    background: on ? 'var(--anthropic-orange-dim)' : 'transparent',
    color: on ? 'var(--text-primary)' : 'var(--text-secondary)',
    border: `1px solid ${on ? 'var(--anthropic-orange)' : 'transparent'}`,
  })

  const sectionLabel: React.CSSProperties = {
    fontSize: 10, fontWeight: 600, color: 'var(--text-tertiary)', padding: '6px 8px 3px',
  }
  /** One KIND of option per card — ordering, grouping, display, hidden folders. */
  const card: React.CSSProperties = {
    display: 'grid', gap: 2, minWidth: 0, padding: 6, borderRadius: 10,
    border: '1px solid var(--border-subtle)', background: 'var(--bg-surface)',
  }
  const heading: React.CSSProperties = {
    fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em',
    color: 'var(--text-secondary)', padding: '4px 8px 2px',
  }
  const hint: React.CSSProperties = { margin: 0, padding: '2px 8px 4px', fontSize: 11, lineHeight: 1.45, color: 'var(--text-tertiary)' }
  const stepStyle = (off: boolean): React.CSSProperties => ({
    background: 'none', border: 'none', padding: 0, width: tap ?? 18, height: tap ?? 18,
    display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
    color: off ? 'var(--border)' : 'var(--text-tertiary)', cursor: off ? 'default' : 'pointer',
  })

  return (
    <>
      <button
        ref={trigger}
        onClick={() => {
          if (open) { setOpen(false); return }
          const r = trigger.current?.getBoundingClientRect()
          if (!r) return
          setAt({ left: Math.max(12, Math.min(r.left, window.innerWidth - width - 12)), top: r.bottom + 6 })
          setOpen(true)
        }}
        aria-label={pt ? 'Opções de exibição da lista' : 'List view options'}
        aria-expanded={open}
        title={p.changed > 0
          ? (pt ? `Opções de exibição — ${p.changed} alterada(s)` : `List view options — ${p.changed} changed`)
          : (pt ? 'Opções de exibição da lista' : 'List view options')}
        style={{
          position: 'relative',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          ...(p.fill ? { flex: 1, minWidth: 0, minHeight: tap ?? 36 } : { flexShrink: 0, width: tap ?? 34 }),
          padding: 0, borderRadius: 9, cursor: 'pointer',
          border: `1px solid ${open ? 'var(--anthropic-orange)' : 'var(--border-subtle)'}`,
          background: open ? 'var(--anthropic-orange-dim)' : 'var(--bg-elevated)',
          color: open ? 'var(--anthropic-orange)' : 'var(--text-tertiary)', fontFamily: 'inherit',
        }}
      >
        <LayoutList size={14} />
        {/* Same badge as the filter button beside it: what is not at its default, counted. */}
        {p.changed > 0 && (
          <span style={{
            position: 'absolute', top: 3, right: 3,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            minWidth: 13, height: 13, padding: '0 3px', borderRadius: 7,
            background: 'var(--anthropic-orange)', color: '#fff',
            fontSize: 8.5, fontWeight: 700, lineHeight: 1,
          }}>{p.changed}</span>
        )}
      </button>

      {open && at && createPortal(
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 1199 }} />
          <div ref={panel} role="dialog" aria-label={pt ? 'Opções de exibição' : 'View options'} style={{
            position: 'fixed', left: at.left, top: at.top, width, zIndex: 1200,
            borderRadius: 12, border: '1px solid var(--border-subtle)',
            background: 'var(--bg-elevated)', padding: 10,
            display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 10, alignItems: 'start',
            boxShadow: 'var(--ag-shadow-menu)',
            maxHeight: `min(560px, calc(100vh - ${at.top + 12}px))`, overflowY: 'auto',
          }}>
            {/* ORDERING — what comes first, inside each group and among the groups. */}
            <section style={card} aria-label={pt ? 'Ordenação' : 'Ordering'}>
              <div style={heading}>{pt ? 'Ordenação' : 'Ordering'}</div>
              {/* The groups stay most-urgent-first (or in the person's own order) whatever this says,
                  so "by name" can never bury a session waiting on you behind a late-sorting group. */}
              <div style={sectionLabel}>{pt ? 'Ordenar sessões por' : 'Sort sessions by'}</div>
              {SESSION_SORTS.map(v => (
                <button key={v} onClick={() => p.onSort({ by: v, dir: p.sort.dir })} style={rowStyle(p.sort.by === v)}>
                  {SORT_LABEL[v][p.lang]}
                </button>
              ))}
              <button
                onClick={() => p.onSort({ by: p.sort.by, dir: p.sort.dir === 'desc' ? 'asc' : 'desc' })}
                aria-pressed={p.sort.dir === 'asc'}
                style={rowStyle(p.sort.dir === 'asc')}
              >
                {pt ? 'Inverter a ordem' : 'Reverse the order'}
              </button>
              {p.groups.length > 1 && (
                <>
                  <div style={sectionLabel}>{pt ? 'Ordem dos grupos' : 'Group order'}</div>
                  {p.groups.map((g, i) => (
                    <div
                      key={g.key}
                      draggable
                      onDragStart={() => setDrag(g.key)}
                      onDragEnd={() => setDrag(null)}
                      onDragOver={e => e.preventDefault()}
                      onDrop={e => { e.preventDefault(); if (drag) move(drag, g.key); setDrag(null) }}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px',
                        borderRadius: 6, fontSize: 12, color: 'var(--text-secondary)',
                        minHeight: tap,
                        opacity: drag === g.key ? 0.45 : 1,
                      }}
                    >
                      <GripVertical size={12} style={{ flexShrink: 0, color: 'var(--text-tertiary)', cursor: 'grab' }} />
                      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.label}</span>
                      <button
                        onClick={() => step(g.key, -1)} disabled={i === 0}
                        aria-label={pt ? 'Mover para cima' : 'Move up'}
                        style={stepStyle(i === 0)}
                      ><ChevronUp size={13} /></button>
                      <button
                        onClick={() => step(g.key, 1)} disabled={i === p.groups.length - 1}
                        aria-label={pt ? 'Mover para baixo' : 'Move down'}
                        style={stepStyle(i === p.groups.length - 1)}
                      ><ChevronDown size={13} /></button>
                    </div>
                  ))}
                  <button onClick={() => p.onReorder([])} style={rowStyle(false)}>
                    {pt ? 'Automático' : 'Automatic'}
                  </button>
                </>
              )}
            </section>

            <div style={{ display: 'grid', gap: 10, minWidth: 0 }}>
              {/* GROUPING — which dimension the sessions are sub-grouped by. */}
              <section style={card} aria-label={pt ? 'Agrupamento' : 'Grouping'}>
                <div style={heading}>{pt ? 'Agrupamento' : 'Grouping'}</div>
                {ASIDE_GROUP_BY_VALUES.map(v => (
                  <button key={v} onClick={() => p.onGroupBy(v)} style={rowStyle(p.groupBy === v)}>
                    {GROUP_BY_LABEL[v][p.lang]}
                  </button>
                ))}
              </section>

              {/* DISPLAY — how the cards look, and folding everything at once. */}
              <section style={card} aria-label={pt ? 'Exibição' : 'Display'}>
                <div style={heading}>{pt ? 'Exibição' : 'Display'}</div>
                <div style={sectionLabel}>{pt ? 'Cor dos cards' : 'Card color'}</div>
                {ASIDE_CARD_COLOR_VALUES.map(v => (
                  <button key={v} onClick={() => p.onCardColor(v)} style={rowStyle(p.cardColor === v)}>
                    {CARD_COLOR_LABEL[v][p.lang]}
                  </button>
                ))}
                <div style={sectionLabel}>{pt ? 'Recolher / expandir' : 'Collapse / expand'}</div>
                <button onClick={() => { p.onCollapseAll(); setOpen(false) }} style={rowStyle(false)}>
                  <ChevronsDownUp size={13} style={{ flexShrink: 0, color: 'var(--text-tertiary)' }} />
                  {pt ? 'Recolher tudo' : 'Collapse all'}
                </button>
                <button onClick={() => { p.onExpandAll(); setOpen(false) }} style={rowStyle(false)}>
                  <ChevronsUpDown size={13} style={{ flexShrink: 0, color: 'var(--text-tertiary)' }} />
                  {pt ? 'Expandir tudo' : 'Expand all'}
                </button>
              </section>

              {/* HIDDEN FOLDERS — the one place a hidden folder can be seen and brought back. */}
              <section style={card} aria-label={pt ? 'Pastas ocultas' : 'Hidden folders'}>
                <div style={heading}>
                  {pt ? 'Pastas ocultas' : 'Hidden folders'}
                  {p.hiddenFolders.length > 0 && <span style={{ marginLeft: 6, fontWeight: 600, opacity: 0.7 }}>{p.hiddenFolders.length}</span>}
                </div>
                {p.hiddenFolders.length === 0 ? (
                  <p style={hint}>
                    {pt
                      ? 'Nenhuma. Oculte uma pasta pelo menu ⋮ dela; ela some da lista com o que tem dentro e volta por aqui.'
                      : 'None. Hide a folder from its ⋮ menu; it leaves the list with what is inside it and comes back from here.'}
                  </p>
                ) : p.hiddenFolders.map(f => (
                  <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px', minHeight: tap, fontSize: 12, color: 'var(--text-secondary)' }}>
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                    <button
                      onClick={() => p.onShowFolder(f.id)}
                      aria-label={pt ? `Mostrar a pasta ${f.name}` : `Show folder ${f.name}`}
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0, minHeight: tap,
                        padding: '3px 8px', borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit', fontSize: 11.5,
                        border: '1px solid var(--border-subtle)', background: 'transparent', color: 'var(--text-secondary)',
                      }}
                    >
                      <Eye size={12} />{pt ? 'Mostrar' : 'Show'}
                    </button>
                  </div>
                ))}
              </section>
            </div>
          </div>
        </>,
        document.body,
      )}
    </>
  )
}

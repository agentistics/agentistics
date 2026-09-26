/**
 * SessionsGroupMenu — the aside's one discreet control for how its list is arranged.
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
import { ChevronDown, ChevronUp, GripVertical, SlidersHorizontal } from 'lucide-react'
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
  const width = 240

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
    fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em',
    color: 'var(--text-tertiary)', padding: '6px 8px 3px',
  }

  return (
    <>
      <button
        ref={trigger}
        onClick={() => {
          if (open) { setOpen(false); return }
          const r = trigger.current?.getBoundingClientRect()
          if (!r) return
          setAt({ left: Math.min(r.left, window.innerWidth - width - 12), top: r.bottom + 6 })
          setOpen(true)
        }}
        aria-label={pt ? 'Organizar lista' : 'Arrange list'}
        title={pt ? 'Organizar lista' : 'Arrange list'}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          ...(p.fill ? { flex: 1, minWidth: 0, minHeight: tap ?? 36 } : { flexShrink: 0, width: tap ?? 34 }),
          padding: 0, borderRadius: 9, cursor: 'pointer',
          border: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)',
          color: open ? 'var(--anthropic-orange)' : 'var(--text-tertiary)', fontFamily: 'inherit',
        }}
      >
        <SlidersHorizontal size={14} />
      </button>

      {open && at && createPortal(
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 1199 }} />
          <div ref={panel} style={{
            position: 'fixed', left: at.left, top: at.top, width, zIndex: 1200,
            borderRadius: 12, border: '1px solid var(--border-subtle)',
            background: 'var(--bg-elevated)', padding: 8, display: 'grid', gap: 2,
            boxShadow: 'var(--ag-shadow-menu)', maxHeight: 420, overflowY: 'auto',
          }}>
            <div style={sectionLabel}>{pt ? 'Agrupamento por' : 'Group by'}</div>
            {ASIDE_GROUP_BY_VALUES.map(v => (
              <button key={v} onClick={() => p.onGroupBy(v)} style={rowStyle(p.groupBy === v)}>
                {GROUP_BY_LABEL[v][p.lang]}
              </button>
            ))}

            {/* HOW THE SESSIONS INSIDE EACH GROUP ARE ORDERED. The groups stay most-urgent-first (or in
                the person's own order) whatever this says, so "by name" can never bury a session
                that is waiting on you behind a group whose name sorts late. */}
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
                    <GripVertical
                      size={12}
                      style={{ flexShrink: 0, color: 'var(--text-tertiary)', cursor: 'grab' }}
                    />
                    <span style={{
                      flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}>{g.label}</span>
                    <button
                      onClick={() => step(g.key, -1)} disabled={i === 0}
                      aria-label={pt ? 'Mover para cima' : 'Move up'}
                      style={{
                        background: 'none', border: 'none', padding: 0, width: tap ?? 18, height: tap ?? 18,
                        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                        color: i === 0 ? 'var(--border)' : 'var(--text-tertiary)',
                        cursor: i === 0 ? 'default' : 'pointer',
                      }}
                    ><ChevronUp size={13} /></button>
                    <button
                      onClick={() => step(g.key, 1)} disabled={i === p.groups.length - 1}
                      aria-label={pt ? 'Mover para baixo' : 'Move down'}
                      style={{
                        background: 'none', border: 'none', padding: 0, width: tap ?? 18, height: tap ?? 18,
                        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                        color: i === p.groups.length - 1 ? 'var(--border)' : 'var(--text-tertiary)',
                        cursor: i === p.groups.length - 1 ? 'default' : 'pointer',
                      }}
                    ><ChevronDown size={13} /></button>
                  </div>
                ))}
                <button
                  onClick={() => p.onReorder([])}
                  style={rowStyle(false)}
                >
                  {pt ? 'Automático' : 'Automatic'}
                </button>
              </>
            )}

            <div style={sectionLabel}>{pt ? 'Cor dos cards' : 'Card color'}</div>
            {ASIDE_CARD_COLOR_VALUES.map(v => (
              <button key={v} onClick={() => p.onCardColor(v)} style={rowStyle(p.cardColor === v)}>
                {CARD_COLOR_LABEL[v][p.lang]}
              </button>
            ))}
          </div>
        </>,
        document.body,
      )}
    </>
  )
}

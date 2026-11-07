/**
 * LiveColumn — one stage column of the line (desktop).
 *
 * Collapsed it is the thin vertical strip empty columns always were. Open it is ONE vertical stack: every card
 * on its own line at the column's width, and the column — not the page — scrolls when they do not fit (owner,
 * 07/11: the old grid of full cards + one-line rows + "menos N" was confusing and ugly). The page of the Live keeps
 * its rule of no vertical scroll.
 *
 * When MORE THAN THREE cards are out of view the column offers a search at its top, which filters this column's
 * cards by title or task while you type. The rules (what counts as out of view, when the field shows) are pure
 * and tested in `liveCardModel`; this file measures the DOM and draws.
 */

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { microLabel } from './board'
import { SearchField } from './SearchField'
import { countOutOfView, matchesColumnQuery, showColumnSearch } from './liveCardModel'
import { STAGE_LABEL, type LiveCard, type LiveStage } from './liveDeliveryModel'

export const COL_W = 280, COL_GAP = 8, COLLAPSED_W = 40

const reducedMotion = (): boolean => { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch { return false } }

export interface LiveColumnWords { empty: string; collapse: string; expand: string; searchPlaceholder: string; noMatch: string; clear: string }

export function LiveColumn({ stage, pt, cards, collapsed, words, query, onQuery, onToggle, render, override, note, groupHeading }: {
  stage: LiveStage; pt: boolean; cards: readonly LiveCard[]; collapsed: boolean; words: LiveColumnWords
  query: string; onQuery: (q: string) => void; onToggle: () => void
  render: (c: LiveCard) => React.ReactNode
  /** The Histórico column: the same column, under its own id, name and colour. */
  override?: { id: string; label: string; color: string }
  /** One informative line under the header. */
  note?: string
  /** A heading drawn above a card when it opens a new group (history: the day). */
  groupHeading?: (c: LiveCard, prev: LiveCard | undefined) => string | null
}) {
  const label = override?.label ?? STAGE_LABEL[stage][pt ? 'pt' : 'en']
  const color = override?.color ?? STAGE_LABEL[stage].color
  const bodyRef = useRef<HTMLDivElement>(null)
  const [searchShown, setSearchShown] = useState(false)
  // Cards of a column that was just collapsed stay mounted for the width animation to play over them.
  const [lingerOpen, setLingerOpen] = useState(false)
  const wasCollapsed = useRef(collapsed)
  useEffect(() => {
    if (!wasCollapsed.current && collapsed && !reducedMotion()) {
      setLingerOpen(true)
      const t = setTimeout(() => setLingerOpen(false), 230)
      wasCollapsed.current = collapsed
      return () => clearTimeout(t)
    }
    wasCollapsed.current = collapsed
    return undefined
  }, [collapsed])

  const visible = useMemo(() => cards.filter(c => matchesColumnQuery(c, query)), [cards, query])
  const signature = useMemo(() => visible.map(c => `${c.d.key}:${c.liveState}`).join('|'), [visible])

  // How many cards are out of view of the column's own scroll area -> does the search show?
  const measure = React.useCallback(() => {
    const el = bodyRef.current
    if (!el) return
    const v = el.getBoundingClientRect()
    const rects = Array.from(el.querySelectorAll<HTMLElement>('[data-live-slot]')).map(x => { const r = x.getBoundingClientRect(); return { top: r.top, bottom: r.bottom } })
    // An unlaid-out body (a hidden tab, a test DOM) has no height and says nothing about what is out of view.
    const out = v.height > 0 ? countOutOfView(rects, { top: v.top, bottom: v.bottom }) : 0
    setSearchShown(prev => showColumnSearch({ outOfView: out, query, wasShown: prev }))
  }, [query])
  useLayoutEffect(() => { if (!collapsed) measure() }, [collapsed, signature, measure, searchShown])
  useEffect(() => {
    const el = bodyRef.current
    if (!el || collapsed) return
    el.addEventListener('scroll', measure, { passive: true })
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    ro?.observe(el)
    return () => { el.removeEventListener('scroll', measure); ro?.disconnect() }
  }, [collapsed, measure])

  const mountBody = !collapsed || lingerOpen
  const showSearch = !collapsed && searchShown
  const width = collapsed ? COLLAPSED_W : COL_W

  return (
    <section
      data-live-column={override?.id ?? stage} data-collapsed={collapsed ? '1' : '0'}
      style={{
        flex: `0 0 ${width}px`, width, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8, overflow: 'hidden',
        opacity: cards.length === 0 && collapsed ? 0.5 : 1,
        transition: reducedMotion() ? 'none' : 'flex-basis .2s ease, width .2s ease, opacity .2s ease',
      }}
    >
      <header
        role="button" tabIndex={0} aria-expanded={!collapsed} aria-label={`${label} — ${collapsed ? words.expand : words.collapse}`}
        title={collapsed ? words.expand : words.collapse} data-live-colhead onClick={onToggle}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle() } }}
        style={{
          borderTop: `3px solid ${color}`, padding: '8px 4px 2px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6,
          cursor: 'pointer', flexShrink: 0, ...(collapsed ? { flexDirection: 'column', gap: 6 } : {}),
        }}
      >
        <span style={{ fontWeight: 700, fontSize: 13, ...(collapsed ? { writingMode: 'vertical-rl', whiteSpace: 'nowrap' } : {}) }}>{label}</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ ...microLabel, fontSize: 11 }}>{query.trim() ? `${visible.length}/${cards.length}` : cards.length}</span>
          {!collapsed && <span aria-hidden data-live-colchev style={{ ...microLabel, fontSize: 13, lineHeight: 1 }}>‹</span>}
        </span>
      </header>
      {note && !collapsed && <span data-live-col-note style={{ fontSize: 10.5, color: 'var(--text-tertiary)', lineHeight: 1.3, padding: '0 4px', flexShrink: 0 }}>{note}</span>}
      {showSearch && (
        <SearchField
          value={query} onChange={onQuery} placeholder={words.searchPlaceholder} mobile={false}
          style={{ flexShrink: 0, padding: '0 2px' }}
          inputProps={{ 'data-live-col-search': stage }}
        />
      )}
      {mountBody && (
        <div
          ref={bodyRef} data-live-colbody className="ag-scroll"
          style={{
            flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', display: 'grid', gap: 8, alignContent: 'start',
            padding: '0 2px 2px', overscrollBehavior: 'contain',
            opacity: collapsed ? 0 : 1, transition: reducedMotion() ? 'none' : 'opacity .15s ease', pointerEvents: collapsed ? 'none' : undefined,
          }}
        >
          {visible.map((c, i) => {
            const heading = groupHeading?.(c, visible[i - 1])
            return (
              <React.Fragment key={c.d.key}>
                {heading && <span data-live-group-head style={{ ...microLabel, fontSize: 10.5, padding: '4px 4px 0', textTransform: 'uppercase', letterSpacing: '.05em' }}>{heading}</span>}
                <div data-live-slot style={{ minWidth: 0 }}>{render(c)}</div>
              </React.Fragment>
            )
          })}
          {cards.length === 0 && <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)', padding: '4px 6px' }}>{words.empty}</span>}
          {cards.length > 0 && visible.length === 0 && (
            <span data-live-col-nomatch style={{ fontSize: 11.5, color: 'var(--text-tertiary)', padding: '4px 6px' }}>
              {words.noMatch} <button type="button" onClick={() => onQuery('')} style={{ background: 'none', border: 0, padding: 0, color: 'var(--anthropic-orange-light)', cursor: 'pointer', fontFamily: 'inherit', fontSize: 11.5 }}>{words.clear}</button>
            </span>
          )}
        </div>
      )}
    </section>
  )
}

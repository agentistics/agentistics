/**
 * PanelRail — the icon rail on the right edge of the sessions workspace (right-rail spec §2).
 *
 * ALWAYS PRESENT ON DESKTOP, icons only, VS Code's activity bar. `panels` is already filtered and
 * ordered by the caller (`panelSlots.railPanels`, with whatever server/per-session gates apply —
 * `hardwareOffered`, `editorEnabled`, `relayed` — already subtracted): this component draws exactly
 * what it is given and decides nothing about which panels exist.
 *
 * CLICKING opens that panel in the content area to the rail's OWN LEFT — this component never
 * decides where that content renders, only that `onOpen(id)` was asked for; the caller
 * (`SessionsPage.tsx`) is what keeps the content area from ever painting UNDER the rail (the rail is
 * a flex sibling with a fixed width, never absolutely positioned over anything).
 *
 * HOVER NAMES THE ICON, AND SO DOES KEYBOARD FOCUS (spec §2). A native `title` attribute would
 * satisfy the first alone — most browsers show it only on a POINTER hover, never on `:focus` — so
 * this draws its own tooltip, shown on `mouseenter`/`focus` alike and hidden on the matching leave/
 * blur, positioned to the LEFT of the rail (the rail sits at the screen's own right edge, so a
 * tooltip opening rightward would run off-screen). It carries the TITLE and a one-line DESCRIPTION
 * (addendum item 1: "nao ta aparecendo o cardzinho explicativo").
 *
 * PORTALED TO `document.body`, `position: fixed`, measured off the hovered button's own rect —
 * NEVER `position: absolute` inside this component's tree. It was, once, and shipped invisible: the
 * rail's own `overflow: hidden` (immediately below, load-bearing for "the rail never scrolls its
 * icons") clips ANY descendant whose box extends outside the rail's bounds, which the tooltip does
 * BY DESIGN — it opens 8px to the tooltip's own LEFT of a 44px-wide column, i.e. entirely outside
 * it. Clipping is a layout/paint fact, not a stacking-context one, so no `z-index` could have
 * rescued it. This is why it "worked in the preview and failed in production": it never actually
 * worked — the phase-1 verification confirmed the tooltip NODE existed (right text, right DOM) and
 * never confirmed it was PAINTED, so a bug present in dev from the start went unnoticed until a
 * real hover in the shipped build showed nothing. `SessionsGroupMenu.tsx`'s own popover already
 * solves the identical problem the identical way — `createPortal` + `position: fixed` — this
 * follows that established pattern rather than inventing a second one.
 *
 * NEVER SCROLLS (spec §4: "The rail never scrolls its icons: overflow is the dropdown, not a
 * scrollbar") — that dropdown is a LATER pass; for now a rail taller than its column simply clips
 * (`overflow: hidden`), which is the honest incomplete state rather than a scrollbar this design
 * explicitly rules out.
 *
 * DRAG (spec §3), mouse only — it reaches neither the keyboard nor a phone, which is exactly why the
 * gear's move verbs stay clickable everywhere this drag can reach and everywhere it cannot. Dragging
 * one icon onto another REORDERS the rail; dragging an icon here from the BOTTOM band (or anywhere
 * else carrying the shared drag payload — `dragReorder.ts`'s `DRAG_KEY_TYPE`) MOVES it onto the
 * rail. This component only ever reports "this key was dropped on that target" — `onDrop` decides
 * what that means, via the pure `planPanelDrop`; the DOM layer holds no order arithmetic of its own,
 * only which icon is being dragged/hovered, for the drop-target highlight.
 *
 * OVERFLOW (spec §4). `panels` can hold more entries than the rail's own measured height can show —
 * `fitRailIcons` (`lib/railFit.ts`, pure, tested) decides the split, this component only measures
 * the icon COLUMN's own height (a `ResizeObserver`, so it reacts to the window resizing) and reads
 * the split back. The overflowing tail collapses into ONE "more" control at the end of the visible
 * icons, carrying how many are behind it; picking it opens a `PanelTileDropdown` (shared with the
 * eye, below) whose tiles are icon + title + description, exactly like the mobile "More" sheet's own
 * tiles. The rail never grows a scrollbar for this — `overflow: hidden` on the icon column stays.
 *
 * HIDING AND THE CONFIG AREA (spec §5). Right-click → "Ocultar" (added to the SAME context menu the
 * move verb already opened) sends a panel to `hidden` — no icon anywhere. The rail's own END is a
 * config area, visually separated from the icon column (a top border), holding ONE control: an eye,
 * present only while `hidden.length > 0`. It opens the SAME `PanelTileDropdown`, listing the hidden
 * panels with a "Restaurar"/"Restore" verb per tile — the only way back, so it must never itself be
 * unreachable, which is why it lives in the config area rather than behind the icon list's own
 * overflow (a hidden panel could otherwise hide the very control that recovers it).
 *
 * THE RESIZABLE WIDTH (owner, 2026-09-21: "aumentar POUCA COISA da largura dele, dai isso aumenta os
 * icones tbm"). A small vertical grip sits centred on the rail's OWN LEFT EDGE — the same
 * `ResizeGrip` family the aside's own vertical divider and the bottom band's top edge already use,
 * so a reader who has learned one drag handle recognises this one. The drag is a bare clamp
 * (`clampRailWidth`, `lib/railFit.ts`) with no snapping and no escalation to anything — unlike
 * `useBandDrag`'s height, there is no "full screen" a rail can grow into, so the range stays the
 * narrow one `railFit.ts`'s own header explains (floor to `floor * 1.5`). The icon size is DERIVED
 * (`railIconSize`), never a second stored number, so it cannot drift from the width that produced
 * it. Persistence is `setRailWidth`'s own job (`panelSlots.ts`) — this component only ever reports
 * the pointer's current position; the clamp-and-commit-and-write happens once, in the pure layer.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowDown, Eye, EyeOff, MoreHorizontal } from 'lucide-react'
import { PanelContextMenu, PanelTileDropdown, type PanelContextMenuEntry, type PanelTile } from './bandControls'
import { readDragPayload, setDragPayload } from '../../lib/dragReorder'
import { panelIconFor } from '../../lib/panelIcons'
import { panelDescription, panelTitle } from '../../lib/panelMeta'
import { panelMoveEntry } from '../../lib/panelMenu'
import { fitRailIcons, railIconSize } from '../../lib/railFit'
import { railClickAction } from '../../lib/panelSlots'
import { RAIL_WIDTH_PX } from '../../lib/rightAsideEdge'
import { ResizeGrip } from '../ResizeGrip'
import type { PanelDropTarget, PanelId } from '../../lib/panelSlots'

export { RAIL_WIDTH_PX }

/** The config area's own reserved height (eye button + its own top border) — subtracted from the
 *  measured rail height BEFORE `fitRailIcons` runs, only while there is something to reveal. */
const CONFIG_AREA_H = 41

export interface PanelRailProps {
  /** Already filtered (gates subtracted) and ordered — see this module's own header. */
  panels: readonly PanelId[]
  /** Hidden panels this session can still reach (gates subtracted the same way) — the eye's own
   *  list (spec §5). Empty hides the config area's eye entirely. */
  hidden: readonly PanelId[]
  /** Which panel the content area is currently showing, if any. */
  active: PanelId | null
  /** Is the RIGHT SLOT's own content currently visible — `SlotLayout.rightOpen`. Decides what a
   *  click on the ACTIVE icon does (`railClickAction`); irrelevant to every other icon. */
  rightOpen: boolean
  /** Panels with real, right-now activity (addendum item 5) — see `PanelRail`'s own dot, below.
   *  Absent/empty draws no dot on anything, same as every other capability-honest surface here. */
  activity?: ReadonlySet<PanelId>
  /** Is the machine's hardware currently at `critical` on any measured resource (addendum item 6,
   *  `lib/hardwarePressure.ts`)? Recolors ONLY the `hardware` icon — never a generic "something is
   *  wrong" tint on the whole rail, since the fault is specific to the one panel that can explain
   *  it. Absent/false draws the icon exactly as before this feature. */
  hardwareCritical?: boolean
  /** The rail's own LIVE width (owner, 2026-09-21) — `SlotLayout.railWidth`, already clamped by its
   *  reader in `panelSlots.ts`. Icon size is derived from it (`railIconSize`), never a second field. */
  railWidth: number
  /** The grip's own drag report — `usePanelSlots().setRailWidth`, which clamps and persists. This
   *  component never clamps itself, so the same drag can freely overshoot the ends: the pure layer
   *  is the one place that decides what "too far" means. */
  onResizeWidth: (width: number) => void
  lang: 'pt' | 'en'
  /** Names the `cli` icon after the session's own harness, exactly like the bottom band's tab. */
  harness?: string
  onOpen: (id: PanelId) => void
  /**
   * Minimize `id` — the rail-icon-toggle's other half (addendum item 3). Takes the panel id, NOT a
   * bare callback: `SlotLayout.rightOpen` genuinely gates visibility for exactly ONE panel (the
   * Studio, `panelMinimizeAction`'s `collapse-right-park`) — every other panel's own minimize is a
   * full `closeSlotPanel` (`close-right`), which `rightOpen` alone does not express (`open` in
   * `resolveDockedTarget`'s own slot-layout construction reads `slotLayout.right !== null` for those
   * — `rightOpen` never gated them, or Skills stayed fully visible with its "minimized" flag flipped
   * and nothing on screen changing). The caller dispatches through `panelMinimizeAction` itself; this
   * component decides only WHETHER to minimize, never WHAT that means for a given panel.
   */
  onMinimize: (id: PanelId) => void
  /** The context menu's own move verb (addendum, 2026-09-21) — always "move to the bottom", since
   *  every rail panel's other placement is the bottom band. */
  onMove: (id: PanelId) => void
  /** The context menu's own hide verb (spec §5) — sends `id` to `hidden`. */
  onHide: (id: PanelId) => void
  /** The eye's own restore verb (spec §5) — puts a hidden panel back where it was. */
  onReveal: (id: PanelId) => void
  /** A drag ended here (spec §3) — either on a specific icon or on the rail's own empty space. */
  onDrop: (dragPanel: PanelId, target: PanelDropTarget) => void
}

/** One tile, shared by the "more" list and the eye's list — the icon, the title, the one-line
 *  description every hover tooltip already shows, so the two surfaces never disagree about either.
 *  EXPORTED for the MOBILE eye too (`SessionsPage.tsx`'s `rightSwitcherMobile`, the mobile pass's
 *  own "the same tile list the desktop's eye opens is the obvious form") — a phone has no rail to
 *  hold this function privately, and a second copy would be the tile reading a hidden panel's
 *  title/description/icon differently on the two surfaces. */
export function panelTile(id: PanelId, pt: boolean, harness: string | undefined, verbLabel?: string): PanelTile {
  return {
    id, icon: panelIconFor(id, 18, harness), title: panelTitle(id, pt),
    description: panelDescription(id, pt), ...(verbLabel ? { verbLabel } : {}),
  }
}

/**
 * RailResizeHandle — the rail's own grip (owner, 2026-09-21), centred on the rail's LEFT edge, the
 * same small vertical pill (`ResizeGrip orientation="vertical"`) the artifacts aside's own divider
 * draws one column over. Absolutely positioned so it consumes no flex width of its own — the rail's
 * root is `position: relative` for exactly this.
 *
 * A BARE REPORT, never a clamp: `onResize` is `usePanelSlots().setRailWidth`, which clamps
 * (`clampRailWidth`) and persists in one place (`panelSlots.ts`) — this component only ever hands it
 * the pointer's raw delta, so overshooting past either end during a fast drag is harmless, exactly
 * as `useBandDrag`'s own height-resize leaves clamping to `resolveBandDrag`.
 *
 * DRAGGING LEFT WIDENS THE RAIL — it is anchored to the viewport's own right edge, so its only free
 * edge is this one; the sign is the same inversion the artifacts aside's own width drag already
 * uses (`SessionsPage.tsx`'s `dragArt`), for the identical reason.
 */
function RailResizeHandle({ width, onResize, lang }: {
  width: number
  onResize: (width: number) => void
  lang: 'pt' | 'en'
}) {
  const label = lang === 'pt' ? 'Redimensionar a barra de painéis' : 'Resize the panel rail'
  const dragRef = useRef<{ startX: number; startW: number } | null>(null)
  // Read fresh on every render, exactly as `useBandDrag`'s own `startRef` does, so a mouseDown mid-
  // resize (or a keyboard step right after a pointer drag) starts from what is ACTUALLY on screen.
  const startRef = useRef(width)
  startRef.current = width
  useEffect(() => {
    const move = (clientX: number) => {
      const d = dragRef.current
      if (!d) return
      onResize(d.startW + (d.startX - clientX))
    }
    const onMouse = (e: MouseEvent) => move(e.clientX)
    const onTouch = (e: TouchEvent) => { const p = e.touches[0]; if (p) move(p.clientX) }
    const end = () => { dragRef.current = null }
    window.addEventListener('mousemove', onMouse)
    window.addEventListener('mouseup', end)
    window.addEventListener('touchmove', onTouch)
    window.addEventListener('touchend', end)
    return () => {
      window.removeEventListener('mousemove', onMouse)
      window.removeEventListener('mouseup', end)
      window.removeEventListener('touchmove', onTouch)
      window.removeEventListener('touchend', end)
    }
  }, [onResize])
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={RAIL_WIDTH_PX}
      tabIndex={0}
      className="ag-resize-handle"
      onMouseDown={e => { e.preventDefault(); dragRef.current = { startX: e.clientX, startW: startRef.current } }}
      onTouchStart={e => {
        const p = e.touches[0]
        if (p) dragRef.current = { startX: p.clientX, startW: startRef.current }
      }}
      // A NARROW step (2px — `RAIL_ICON_GAP_PX`'s own scale, not `useBandDrag`'s 24px): the whole
      // range here is 22px (`RAIL_WIDTH_CEILING_PX - RAIL_WIDTH_FLOOR_PX`), so a 24px step would
      // jump the rail from floor to past ceiling in one keystroke, defeating the "POUCA COISA" this
      // range exists to express.
      onKeyDown={e => {
        if (e.key === 'ArrowLeft') { e.preventDefault(); onResize(startRef.current + 2) }
        if (e.key === 'ArrowRight') { e.preventDefault(); onResize(startRef.current - 2) }
      }}
      style={{
        position: 'absolute', left: 0, top: '50%', transform: 'translate(-50%, -50%)',
        width: 10, height: 36, cursor: 'col-resize', background: 'transparent', zIndex: 1,
      }}
    ><ResizeGrip orientation="vertical" /></div>
  )
}

export function PanelRail({
  panels, hidden, active, rightOpen, activity, hardwareCritical, railWidth, onResizeWidth, lang,
  harness, onOpen, onMinimize, onMove, onHide, onReveal, onDrop,
}: PanelRailProps) {
  const pt = lang === 'pt'
  const iconPx = railIconSize(railWidth)
  const glyphPx = Math.round(iconPx / 2)
  const [named, setNamed] = useState<{ id: PanelId; rect: DOMRect } | null>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)
  // The clamped vertical position, measured off the tooltip's OWN rendered height — see the
  // tooltip's own render block, below, for why a purely-CSS centered position can run off the
  // viewport's top or bottom edge. `null` until the first post-mount measurement lands.
  const [tooltipTop, setTooltipTop] = useState<number | null>(null)
  useLayoutEffect(() => {
    if (!named) { setTooltipTop(null); return }
    const el = tooltipRef.current
    if (!el) return
    const h = el.offsetHeight
    const desired = named.rect.top + named.rect.height / 2 - h / 2
    setTooltipTop(Math.min(Math.max(desired, 8), window.innerHeight - h - 8))
  }, [named])
  const [dragOver, setDragOver] = useState<PanelId | 'bar' | null>(null)
  const [menu, setMenu] = useState<{ panel: PanelId; at: { x: number; y: number } } | null>(null)
  const [more, setMore] = useState<{ x: number; y: number } | null>(null)
  const [eyeAt, setEyeAt] = useState<{ x: number; y: number } | null>(null)

  // THE ICON COLUMN'S OWN HEIGHT — a `ResizeObserver`, so overflow reacts to the window resizing
  // (spec §4's own requirement), not just to the panel list changing. Measured on the COLUMN, not
  // the whole rail: the config area below it is a fixed, separately-accounted block (`CONFIG_AREA_H`),
  // and folding its height into this measurement would double-subtract it.
  const colRef = useRef<HTMLDivElement>(null)
  const [colHeight, setColHeight] = useState(0)
  useEffect(() => {
    const el = colRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(entries => {
      const h = entries[0]?.contentRect.height
      if (typeof h === 'number') setColHeight(h)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const reserveConfig = hidden.length > 0 ? CONFIG_AREA_H : 0
  const fit = fitRailIcons(panels, colHeight - reserveConfig, iconPx)
  // Before the FIRST measurement (colHeight === 0) there is nothing to clip against yet — show
  // every icon rather than reading a not-yet-real "zero" as "nothing fits" (the same N/A-vs-a-
  // confident-0 rule this codebase applies everywhere else, applied to a layout instead of a metric).
  const { visible, overflow } = colHeight === 0 ? { visible: panels, overflow: [] as readonly PanelId[] } : fit

  const dropHere = (e: React.DragEvent, target: PanelDropTarget) => {
    e.preventDefault()
    const key = readDragPayload(e)
    if (key) onDrop(key as PanelId, target)
    setDragOver(null)
  }

  const openMenuAt = (id: PanelId, rect: DOMRect) => {
    setMenu({ panel: id, at: { x: rect.left, y: rect.top } })
  }

  const menuEntries: readonly PanelContextMenuEntry[] = menu
    ? (() => {
      const move = panelMoveEntry({ panel: menu.panel, placement: 'rail', lang, panelName: panelTitle(menu.panel, pt) })
      const p = menu.panel
      return [
        ...(move ? [{ id: move.id, label: move.label, icon: <ArrowDown size={14} />, onSelect: () => onMove(p) }] : []),
        { id: 'hide', label: pt ? 'Ocultar' : 'Hide', icon: <EyeOff size={14} />, onSelect: () => onHide(p) },
      ]
    })()
    : []

  return (
    <div
      // `data-panel-rail` — the narrow-overlay's own "was this click on the rail" test (spec §11
      // item 2: clicking the rail switches panels, it is never "clicking away"). Marks the WHOLE
      // rail root, config area included, not only the `role="tablist"` icon column — the eye and
      // the overflow "more" button sit outside that column and are just as much "the rail".
      data-panel-rail="true"
      style={{
        position: 'relative', display: 'flex', flexDirection: 'column', width: railWidth, flexShrink: 0,
        // The plain state carries NO line any more (owner-approved central-pane inset, 2026-09-26):
        // the pane immediately to this rail's left now has its OWN right border, 5px away, so a
        // second line here just sandwiched it. The drag-over highlight stays — that is a live
        // STATE, not the static frame divider the pane's own border replaced, and the resize
        // handle's grip (`RailResizeHandle`, below) still marks the edge as draggable.
        borderLeft: dragOver === 'bar' ? '1px solid var(--anthropic-orange)' : 'none',
        // FRAME, not a panel (floating-panel board): the rail sits on the same ground as the gaps.
        background: 'transparent',
      }}
    >
      <RailResizeHandle width={railWidth} onResize={onResizeWidth} lang={lang} />
      <div
        ref={colRef}
        role="tablist"
        aria-label={pt ? 'Painéis' : 'Panels'}
        aria-orientation="vertical"
        onDragOver={e => { e.preventDefault(); setDragOver(s => s ?? 'bar') }}
        onDragLeave={e => {
          if (e.currentTarget === e.target) setDragOver(null)
        }}
        onDrop={e => dropHere(e, { placement: 'rail' })}
        style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
          flex: 1, minHeight: 0, padding: '8px 4px', overflow: 'hidden',
        }}
      >
        {visible.map(id => {
          const on = id === active
          // ONLY the `hardware` icon ever reads `hardwareCritical` — a fault named on the one panel
          // that can explain it, never a tint spent on every icon in the column (addendum item 6).
          const hot = id === 'hardware' && hardwareCritical === true
          const title = hot
            ? `${panelTitle(id, pt)} — ${pt ? 'sob pressão' : 'under pressure'}`
            : panelTitle(id, pt)
          const busy = activity?.has(id) === true
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={on}
              aria-label={title}
              draggable
              onDragStart={e => setDragPayload(e, id)}
              onDragEnd={() => setDragOver(null)}
              onDragOver={e => { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'move'; setDragOver(id) }}
              onDrop={e => { e.stopPropagation(); dropHere(e, { panel: id }) }}
              // THE RAIL IS A LAUNCHER (addendum item 3) — `railClickAction` decides, never a bare
              // "always open". See that function's own header for why the bottom bar's tabs (select-
              // only) do NOT follow the same rule.
              onClick={() => (railClickAction(active, rightOpen, id) === 'minimize' ? onMinimize(id) : onOpen(id))}
              // RIGHT-CLICK / Menu key / Shift+F10 — the icon's own context menu (addendum, 2026-09-21:
              // the move verb that used to live in a gear this icon never had; spec §5's "Ocultar"
              // joined it). Anchored to the button's own rect, not the event coordinates — see
              // `PanelContextMenu`'s own header.
              onContextMenu={e => { e.preventDefault(); openMenuAt(id, e.currentTarget.getBoundingClientRect()) }}
              onMouseEnter={e => setNamed({ id, rect: e.currentTarget.getBoundingClientRect() })}
              onMouseLeave={() => setNamed(s => (s?.id === id ? null : s))}
              onFocus={e => setNamed({ id, rect: e.currentTarget.getBoundingClientRect() })}
              onBlur={() => setNamed(s => (s?.id === id ? null : s))}
              style={{
                position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center',
                width: iconPx, height: iconPx, flexShrink: 0, borderRadius: 8, border: 'none', padding: 0,
                cursor: 'pointer', fontFamily: 'inherit',
                background: on ? 'var(--bg-elevated)' : 'transparent',
                color: hot ? 'var(--accent-red)' : (on ? 'var(--anthropic-orange)' : 'var(--text-secondary)'),
                // The drop target is shown as an EDGE, matching the pinned-sessions band's own
                // convention — a list that reflows under the cursor moves the target you aimed at.
                boxShadow: dragOver === id ? 'inset 0 0 0 1.5px var(--anthropic-orange)' : undefined,
              }}
            >
              {panelIconFor(id, glyphPx, harness)}
              {/* THE ACTIVITY DOT (addendum item 5) — top-right, the same corner-dot convention
                  `PanelBar`'s own `studioSeen` marker already uses, so a reader who has learned
                  that one glyph reads this one the same way. Green (`#22c55e`, this codebase's own
                  "running" token — see the TUI's `COLORS.running`), never the orange this rail
                  already spends on "currently open", so the two facts stay visually distinct: a
                  session can be OPEN and quiet, or CLOSED and busy. */}
              {busy && (
                <span aria-hidden="true" style={{
                  position: 'absolute', top: -1, right: -1, width: 7, height: 7,
                  borderRadius: '50%', background: '#22c55e', border: '1.5px solid var(--bg-surface)',
                }} />
              )}
            </button>
          )
        })}
        {overflow.length > 0 && (
          <button
            type="button"
            aria-haspopup="menu"
            aria-label={pt ? `${overflow.length} painéis ocultos por espaço` : `${overflow.length} panels hidden by space`}
            title={pt ? `Mais ${overflow.length}` : `${overflow.length} more`}
            onClick={e => setMore(s => (s ? null : { x: e.currentTarget.getBoundingClientRect().left, y: e.currentTarget.getBoundingClientRect().top }))}
            style={{
              position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: iconPx, height: iconPx, flexShrink: 0, borderRadius: 8, border: 'none', padding: 0,
              cursor: 'pointer', fontFamily: 'inherit', background: 'transparent', color: 'var(--text-secondary)',
            }}
          >
            <MoreHorizontal size={glyphPx} />
            <span aria-hidden="true" style={{
              position: 'absolute', top: -2, right: -4,
              minWidth: 14, height: 14, padding: '0 3px', borderRadius: 7,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'var(--anthropic-orange)', color: '#fff', fontSize: 9, fontWeight: 700,
            }}>{overflow.length}</span>
          </button>
        )}
      </div>
      {/* THE CONFIG AREA (spec §5) — separated from the icon column by its own top border, holding
          the eye. Absent (not merely dimmed) while nothing is hidden: a control with one enabled
          state and one permanently-disabled one is a control that trains readers to ignore it. */}
      {hidden.length > 0 && (
        <div style={{
          display: 'flex', justifyContent: 'center', padding: '4px 4px 8px',
          borderTop: '1px solid var(--border)', flexShrink: 0,
        }}>
          <button
            type="button"
            aria-haspopup="menu"
            aria-label={pt ? `${hidden.length} painéis ocultos` : `${hidden.length} hidden panels`}
            title={pt ? `${hidden.length} ocultos — clique para restaurar` : `${hidden.length} hidden — click to restore`}
            onClick={e => setEyeAt(s => (s ? null : { x: e.currentTarget.getBoundingClientRect().left, y: e.currentTarget.getBoundingClientRect().top }))}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: iconPx, height: iconPx, borderRadius: 8, border: 'none', padding: 0,
              cursor: 'pointer', fontFamily: 'inherit', background: 'transparent', color: 'var(--anthropic-orange)',
            }}
          >
            <Eye size={glyphPx} />
          </button>
        </div>
      )}
      {/* THE TOOLTIP — portaled to `document.body`, NEVER `position: absolute` in this tree. See
          this module's own header for the clipping bug this replaced (`overflow: hidden` above
          clipped the old in-tree version entirely, in every build, dev included).

          A WIDE, SHORT RECTANGLE (owner, 2026-09-21: "um retangulo horizontal mano") — v2.46.0's
          card had no `minWidth`, only a `maxWidth: 220`, and a `position: fixed` box with no
          explicit width shrinks to its own content's PREFERRED width rather than growing out to
          the max — for a short title next to a long description that preferred width came out
          under half of 220px, so the description wrapped one or two words per line into a tall
          column instead of the wide card the max-width was meant to allow. `minWidth` fixes the
          shape; the title is now `nowrap` (never wraps, a panel's name is always short enough to
          say on one line) and the description is a 2-line CLAMP (`-webkit-line-clamp`), so the
          card's HEIGHT stays fixed regardless of which panel is hovered — never "grows taller",
          the owner's other complaint about the tall version.

          CLAMPED AGAINST THE VIEWPORT'S TOP AND BOTTOM, measured rather than guessed: `tooltipTop`
          starts `null` (naive vertical centering, `transform`'s own `translateY(-50%)`) and a
          `useLayoutEffect` — synchronous, before the browser ever paints the frame — measures the
          card's OWN rendered height once mounted and recomputes a clamped `top`, dropping the
          transform once it has one. A hover near the very top or bottom rail icon on a short
          window is exactly the case a purely-CSS centered tooltip would push off-screen. */}
      {named && createPortal(
        <div
          ref={tooltipRef}
          role="tooltip"
          style={{
            position: 'fixed',
            top: tooltipTop ?? (named.rect.top + named.rect.height / 2),
            left: named.rect.left - 8,
            transform: tooltipTop === null ? 'translate(-100%, -50%)' : 'translateX(-100%)',
            minWidth: 240, maxWidth: 300, padding: '8px 12px', borderRadius: 8,
            background: 'var(--bg-elevated)', color: 'var(--text-primary)',
            border: '1px solid var(--border)', boxShadow: '0 4px 12px -4px rgba(0,0,0,0.4)',
            pointerEvents: 'none', zIndex: 1250,
          }}
        >
          <div style={{
            fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>{panelTitle(named.id, pt)}</div>
          <div style={{
            fontSize: 10.5, color: 'var(--text-tertiary)', marginTop: 3, lineHeight: 1.35,
            display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
          }}>
            {panelDescription(named.id, pt)}
          </div>
          {/* THE PRESSURE LINE (addendum item 6) — the native `title` already says "under pressure"
              (screen readers, and browsers that show a title on hover alone), but this custom
              tooltip is what actually PAINTS on hover/focus here (see this module's own header on
              why); a word only the accessibility tree carries is a word most readers never see. */}
          {named.id === 'hardware' && hardwareCritical === true && (
            <div style={{ fontSize: 10.5, color: 'var(--accent-red)', marginTop: 3, fontWeight: 600 }}>
              {pt ? 'Sob pressão agora' : 'Under pressure right now'}
            </div>
          )}
        </div>,
        document.body,
      )}
      {menu && (
        <PanelContextMenu at={menu.at} entries={menuEntries} onClose={() => setMenu(null)} />
      )}
      {more && (
        <PanelTileDropdown
          at={more}
          label={pt ? `${overflow.length} mais` : `${overflow.length} more`}
          tiles={overflow.map(id => panelTile(id, pt, harness))}
          onPick={id => onOpen(id as PanelId)}
          onClose={() => setMore(null)}
        />
      )}
      {eyeAt && (
        <PanelTileDropdown
          at={eyeAt}
          label={pt ? `${hidden.length} ocultos` : `${hidden.length} hidden`}
          tiles={hidden.map(id => panelTile(id, pt, harness, pt ? 'Restaurar' : 'Restore'))}
          onPick={id => onReveal(id as PanelId)}
          onClose={() => setEyeAt(null)}
        />
      )}
    </div>
  )
}

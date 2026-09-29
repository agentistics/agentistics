import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowDown, ArrowRight, ChevronUp, EyeOff, Maximize2, Minimize2, Minus, MoreHorizontal, Pin, Settings, X,
} from 'lucide-react'
import type { PanelBarEntry, PanelBarId } from '../../lib/panelBar'
import { hasDragPayload, readDragPayload, setDragPayload } from '../../lib/dragReorder'
import { panelMoveEntry, type PanelMenuIconId } from '../../lib/panelMenu'
import type { PanelDropTarget } from '../../lib/panelSlots'
import { resolveBandDrag, resolveBandHeight } from '../../lib/shellBand'
import { isDragEndEvent, PANEL_GAP } from '../../lib/panelLayout'
import { targetLabel } from '../../lib/terminalTarget'
import { panelIconFor } from '../../lib/panelIcons'
import { panelTitle } from '../../lib/panelMeta'
import { PanelGapDots } from './PanelGap'
import { paneDomId, usePaneId } from '../../lib/paneScope'

/**
 * bandControls.tsx — ONE height, ONE padding, ONE icon/label size for every control drawn on the
 * bottom band's own bar, the right slot's fixed-header switcher and the Studio bar (design item 3,
 * screenshot 1 — "the buttons are non-standard sizes and it is very confusing").
 *
 * BEFORE THIS FILE, the same idea existed at least THREE times and had already drifted from itself:
 * `ShellBand.tsx`'s `labeledBtn` (a bordered pill, height 22, no `boxSizing`, so its rendered box was
 * really 24px once the 1px border either side is added back), `SessionPanel.tsx`'s
 * `studioBandLabeledBtn`/`studioBandIconBtn` (byte-for-byte copies of the same numbers, kept as a
 * SECOND definition rather than an import), and `Studio.tsx`'s `LabeledIconButton` (the same 22px
 * height, but `border: 'none'` and `background: 'transparent'` — a ghost button standing next to
 * bordered pills of a different actual height). None of the three disagreed on purpose; they just
 * never shared a body. `SessionPanel.tsx` even exported a `Segment` component with a comment saying
 * exactly this ("a second hand-rolled copy of it is exactly the drift this whole lift-up was meant
 * to remove") and then nothing ever imported it — `ShellBand.tsx`'s own segmented tablists
 * (`targetSwitch`/`dockedTargetSwitch`) hand-rolled their buttons anyway.
 *
 * THE FIX IS `boxSizing: 'border-box'` PLUS AN EXPLICIT `height` ON EVERY BOX THAT CAN CARRY ONE —
 * including the segment's own WRAPPER, not only the pills beside it. A wrapper sized by its content
 * (`padding: 3` around a 22px button) measures 28px tall while a standalone pill beside it measures
 * 22-24px: same "control", visibly different heights, which is the whole complaint. Fixing the
 * wrapper's height explicitly and giving its tabs `height: '100%'` is what makes
 * `getBoundingClientRect().height` agree across every control this file exports.
 */

/**
 * BandResizeHandle — THE ONE GRIP, ALWAYS THE BAND'S FIRST CHILD, ALWAYS ITS TOP EDGE.
 *
 * Owner report: "dependendo da aba q eu to o item de indicacao de reposicionamento muda de lugar,
 * ele deveria estar SEMPRE no topo, na borda superior da barra inferior." Measured: `ShellBand`'s
 * own desktop branch already rendered its `role="separator"` handle as the ROOT's first child, above
 * the bar row — correct, and why Claude Code/Shell always looked right. `StudioBand` and
 * `SimpleDockedBand` (Contents/Hardware) each rendered their OWN copy of the same markup, but as the
 * bar row's SIBLING placed AFTER it, inside a `{open && (…)}` fragment — one row lower, level with
 * the toolbar, because that is genuinely where it sat in the DOM. Three copies that happened to
 * agree only for one of the three panels is not a rule, it is a coincidence; this component is the
 * rule, and every caller now renders it before its own bar row (see `StudioBand`/`SimpleDockedBand`/
 * `ShellBand`'s own docked branch).
 *
 * Presentation only — `useBandDrag` below is the one state machine that decides WHAT a drag on it
 * means; this component never reads `columnHeight` or persists anything itself, so a caller cannot
 * forget to gate it on `open`/`fullscreen` and get away with a HANDLE that draws but does nothing.
 *
 * FLOATING-PANELS DESIGN (`sdd/brief.md`): the bottom band is now its OWN panel, no longer docked
 * INSIDE the conversation's card, so this handle is rendered as the GAP between the two panels — a
 * sibling BEFORE the band's own bordered box, never its first child — and wears the same three-dot
 * grip (`PanelGapDots`/`.ag-panel-gap`) every other gap in the workspace does, in place of the
 * single pill this used to share with `AsideResizer`'s own edge. The hit area's height is `PANEL_GAP`
 * (`lib/panelLayout.ts`), the same figure every inner seam in the workspace uses, full width —
 * only the visual and its position moved.
 */
export function BandResizeHandle({ label, onMouseDown, onTouchStart, onKeyDown }: {
  /** The full sentence — this handle's accessible name, band-specific ("Resize the Studio", "Resize
   *  Contents", `ShellBand`'s own `t.resize`). */
  label: string
  onMouseDown: (e: React.MouseEvent) => void
  onTouchStart: (e: React.TouchEvent) => void
  onKeyDown: (e: React.KeyboardEvent) => void
}) {
  const pane = usePaneId()
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label={label}
      tabIndex={0}
      className="ag-panel-gap"
      // A stable id — the ONE thing a T-junction (`PanelGap.tsx`'s `armGap`) needs to replay a
      // synthetic `mousedown` on THIS band's own resize handle, arming its window-level listener
      // exactly as a genuine press would. Whichever band is docked right now (Studio/Shell/a
      // SimpleDockedBand tab) renders its own `BandResizeHandle`, so this id always names whichever
      // one is actually on screen — never a specific band type's own handle.
      id={paneDomId('ag-gap-band-height', pane)}
      onMouseDown={onMouseDown}
      onTouchStart={onTouchStart}
      onKeyDown={onKeyDown}
      style={{ height: PANEL_GAP, flexShrink: 0, cursor: 'row-resize', background: 'transparent' }}
    ><PanelGapDots orientation="horizontal" /></div>
  )
}

/**
 * useBandDrag — the ONE drag-resize state machine behind every `BandResizeHandle`: track the
 * pointer, resolve the wanted height against `resolveBandDrag`, apply it, and escalate to the
 * band's own "full screen" the instant the drag crosses `BAND_FULLSCREEN_OVERSHOOT_PX` past the
 * column's ceiling. `StudioBand`, `SimpleDockedBand` and `ShellBand`'s own docked branch drove this
 * by hand — three copies of the identical mouse/touch machinery (`shellBand.ts`'s own header already
 * says the RESOLVER must be shared "or a second, hand-rolled copy … is exactly the drift this
 * repository's own CLAUDE.md exists to prevent"; this closes the gesture that drives it too),
 * differing only in what `apply`/`onFullscreen` do once resolved.
 *
 * Returns ready-made handlers to spread onto a `BandResizeHandle` — never a bag of refs a caller has
 * to wire up three ways, which is what let the three copies drift from each other in the first
 * place (`ShellBand` alone remembered the `!fullscreen` re-entry guard; it turns out to be
 * unnecessary — the SAME PIXEL of nulling `dragRef` after the first escalation already stops every
 * later `move` from doing anything at all, including a second `apply`/`onFullscreen` call).
 */
export function useBandDrag({
  renderedHeight, columnHeight, apply, onFullscreen, enabled = true,
}: {
  /** What is ACTUALLY on screen right now — the drag's own start point (never the persisted
   *  preference alone, which is stale while `full`; see each caller's own `renderedHeight`). */
  renderedHeight: number
  /** The centre column's own measured height — `0` reads as "never snap", exactly as
   *  `resolveBandHeight` already treats it. */
  columnHeight: number
  /** Applies (and, per caller, persists) the resolved `{height, full}` — `StudioBand`'s/
   *  `SimpleDockedBand`'s shared `applyHeight`, or `ShellBand`'s own `setBand`. */
  apply: (next: { height: number; full: boolean }) => void
  /**
   * The escalation once the drag crosses the overshoot threshold — `StudioBand`'s/
   * `SimpleDockedBand`'s `() => onFullscreenChange(true)`, or `ShellBand`'s own
   * `() => onOpenFullscreen(target)`.
   *
   * ABSENT where the band has nowhere to escalate TO — `ShellBand`'s own `onOpenFullscreen` is
   * optional, and a caller with no dedicated screen to navigate to must not have its drag SPENT the
   * instant the column fills: `resolveBandDrag` keeps clamping at `full: true` and the band simply
   * cannot grow further, exactly as before this hook existed.
   */
  onFullscreen?: () => void
  /** `false` on a placement that never shows this handle at all (`ShellBand`'s own mobile sheet) —
   *  the effect still runs every render (hooks run unconditionally), it just attaches no listeners,
   *  mirroring `ShellBand`'s own former `if (isMobile) return` guard. */
  enabled?: boolean
}): {
  onMouseDown: (e: React.MouseEvent) => void
  onTouchStart: (e: React.TouchEvent) => void
  onKeyDown: (e: React.KeyboardEvent) => void
} {
  const dragRef = useRef<{ startY: number; startH: number } | null>(null)
  // The drag's own start height must read whatever is on screen AT THE MOMENT THE GESTURE BEGINS,
  // never a value captured once at mount — a ref kept current on every render is what lets
  // `onMouseDown`/`onTouchStart` (plain callbacks, not effects) read it without becoming a dependency
  // that would tear the drag's own `useEffect` down and rebuild it on every pixel of movement.
  const startRef = useRef(renderedHeight)
  startRef.current = renderedHeight
  /**
   * LATEST-REF PATTERN, same reasoning as `PanelGap.tsx`'s own copy of it: `columnHeight`/`apply`/
   * `onFullscreen` are read through a ref so the effect below can stay REGISTERED ONCE for the whole
   * gesture — every caller passes a fresh `apply` closure each render, and `apply` itself triggers
   * the state update that causes that re-render, so keeping them as effect DEPENDENCIES tore this
   * effect's window listeners down and rebuilt them on every single `mousemove`. Harmless for an
   * ordinary drag (teardown and resubscribe happen back to back); the shape of bug it exposes is a
   * T-junction (`PanelGap.tsx`'s `armGap`) arming this band drag alongside an aside drag off one
   * synthetic `mousedown` — a release landing in the gap between one side's teardown and its
   * resubscribe left the band height still tracking the pointer after the button came up.
   */
  const propsRef = useRef({ columnHeight, apply, onFullscreen })
  propsRef.current = { columnHeight, apply, onFullscreen }
  useEffect(() => {
    if (!enabled) return
    const move = (clientY: number) => {
      const d = dragRef.current
      if (!d) return
      const p = propsRef.current
      // Grows UPWARD: every band this hook serves is docked at the bottom, so dragging up must
      // make it taller.
      const resolved = resolveBandDrag(d.startH + (d.startY - clientY), p.columnHeight)
      p.apply(resolved)
      if (resolved.fullscreen && p.onFullscreen) {
        p.onFullscreen()
        // The gesture is SPENT — nulling here is what makes every later `move` in this same drag a
        // no-op, so neither `apply` nor `onFullscreen` fires twice for one crossing.
        dragRef.current = null
      }
    }
    const onMouse = (e: MouseEvent) => move(e.clientY)
    const onTouch = (e: TouchEvent) => { const p = e.touches[0]; if (p) move(p.clientY) }
    // Every event that must end a drag (`isDragEndEvent`), not `mouseup`/`touchend` alone — a
    // `pointercancel` or the window losing focus mid-drag left this exact ref non-null forever
    // before this was added.
    const end = (e: Event) => { if (isDragEndEvent(e.type)) dragRef.current = null }
    window.addEventListener('mousemove', onMouse)
    window.addEventListener('mouseup', end)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
    window.addEventListener('blur', end)
    window.addEventListener('touchmove', onTouch)
    window.addEventListener('touchend', end)
    window.addEventListener('touchcancel', end)
    return () => {
      window.removeEventListener('mousemove', onMouse)
      window.removeEventListener('mouseup', end)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      window.removeEventListener('blur', end)
      window.removeEventListener('touchmove', onTouch)
      window.removeEventListener('touchend', end)
      window.removeEventListener('touchcancel', end)
    }
    // Registered ONCE per `enabled` — never on `columnHeight`/`apply`/`onFullscreen`, which is the
    // whole point of the latest-ref pattern above.
  }, [enabled])
  return {
    onMouseDown: e => { e.preventDefault(); dragRef.current = { startY: e.clientY, startH: startRef.current } },
    onTouchStart: e => {
      const p = e.touches[0]
      if (p) dragRef.current = { startY: p.clientY, startH: startRef.current }
    },
    // The keyboard step never escalates to full screen — same as every caller's own handler before
    // this fix, and consistent with `resolveBandHeight` (no `fullscreen` field) rather than
    // `resolveBandDrag` (which the pointer path alone uses).
    onKeyDown: e => {
      if (e.key === 'ArrowUp') { e.preventDefault(); apply(resolveBandHeight(startRef.current + 24, columnHeight)) }
      if (e.key === 'ArrowDown') { e.preventDefault(); apply(resolveBandHeight(startRef.current - 24, columnHeight)) }
    },
  }
}

/** The one height every desktop control in this family shares. Mobile targets are always 44px
 *  (the house rule), never this figure — every component below takes `isMobile` and switches. */
export const BAND_CONTROL_H = 26

/** The standard clip-to-nothing technique — a node stays in the accessibility tree (and so in the
 *  element's accessible NAME) while painting no pixels. Used by `PanelBar`'s `compact` mode: an
 *  unlit tab's full label is still what a screen reader announces, only no longer beside the icon. */
const VISUALLY_HIDDEN: React.CSSProperties = {
  position: 'absolute', width: 1, height: 1, padding: 0, margin: -1,
  overflow: 'hidden', clip: 'rect(0,0,0,0)', whiteSpace: 'nowrap', border: 0,
}

const pillBase: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 5, flexShrink: 0,
  boxSizing: 'border-box', border: '1px solid var(--border-subtle)', borderRadius: 6,
  background: 'var(--bg-elevated)', color: 'var(--text-secondary)', cursor: 'pointer',
  fontFamily: 'inherit', fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap',
}

/**
 * An icon plus a short visible word, in a bordered pill — "Mover para a direita", "Tela cheia",
 * "Encerrar shell", "Recolher"/"Expandir", "Mostrar/Ocultar árvore", "Árvore à direita/esquerda".
 * The ONE control every labelled action button in the band/Studio-bar family renders through.
 */
export function BandLabeledButton({
  label, visibleText, isMobile, onClick, pressed, children,
}: {
  /** The full sentence — the tooltip, and what a screen reader announces. */
  label: string
  /** The short word actually painted next to the icon. */
  visibleText: string
  isMobile: boolean
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void
  /** Present only for a toggle (the tree collapse/expand); omitted for a plain action. */
  pressed?: boolean
  children: ReactNode
}) {
  return (
    <button
      className="ag-tap-icon"
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      {...(pressed !== undefined ? { 'aria-pressed': pressed } : {})}
      style={{
        ...pillBase,
        height: isMobile ? 44 : BAND_CONTROL_H,
        padding: isMobile ? '0 12px' : '0 8px',
      }}
    >
      {children}
      <span>{visibleText}</span>
    </button>
  )
}

/**
 * The segmented tablist's own wrapper — "Claude Code | Shell | Studio", the right slot's header
 * switcher, "which terminal". `height` is fixed and `boxSizing: 'border-box'` on the wrapper itself,
 * so its own padding is spent INSIDE that figure rather than added on top of it — the exact defect
 * this file's header describes (a 28px box next to 22-24px pills).
 */
export function BandSegment({ label, isMobile, children, onDragOver, onDrop, dropHighlight }: {
  label: string
  isMobile: boolean
  children: ReactNode
  /** Drag support (spec §3), all optional — `ShellBand`'s fixed two-way switch never passes these. */
  onDragOver?: (e: React.DragEvent<HTMLDivElement>) => void
  onDrop?: (e: React.DragEvent<HTMLDivElement>) => void
  dropHighlight?: boolean
}) {
  return (
    <div
      role="tablist" aria-label={label}
      {...(onDragOver ? { onDragOver } : {})}
      {...(onDrop ? { onDrop } : {})}
      style={{
        display: 'flex', alignItems: 'center', gap: 3, padding: '0 3px', flexShrink: 0,
        boxSizing: 'border-box', height: isMobile ? 44 : BAND_CONTROL_H,
        borderRadius: 8, background: 'var(--bg-elevated)',
        border: dropHighlight ? '1px solid var(--anthropic-orange)' : '1px solid var(--border-subtle)',
      }}
    >
      {children}
    </div>
  )
}

/**
 * PanelBar — the ONE panel switcher (design item 1: "the drawing moves the header's panel tab menu
 * ... DOWN into the bottom terminal bar, where Claude Code | Shell | Studio already lives"). It used
 * to be `App.tsx`'s `SessionHeaderSwitcher`, rendered in the fixed header; it now renders inside the
 * bottom band's own bar (`ShellBand`'s desktop bar and `StudioBand`'s bar both mount it), which is
 * why it lives here rather than in a page file — both bands import this component, neither imports
 * the other.
 *
 * `entries`/`onPick` decide everything about WHAT is offered and WHAT clicking it does — this
 * component only draws them, through `panelBarEntries` (`lib/panelBar.ts`) and whatever plumbing the
 * caller wires the click to. The first-open dot (`studioSeen`) stays on the Studio entry's icon
 * alone, exactly as it did in the header.
 *
 * NARROWED, AFTER THE RIGHT ICON RAIL: `entries` now only ever names panels PLACED AT THE BOTTOM —
 * see `lib/panelBar.ts`'s own header on why a bar embedded in the bottom band no longer also offers
 * rail panels. Every id/label/icon comes from the shared `panelMeta.ts`/`panelIcons.tsx` tables now,
 * rather than a fifth copy of the same five (now fourteen) entries.
 */
/**
 * useBandDropTarget — THE WHOLE BOTTOM BAND, made a drop target (fixing "nao ta dando pra arrastar
 * da barra da direita ate a barra inferior, so da barra inferior pra barra da direita").
 *
 * THE ACTUAL BUG, found by reproducing the owner's own gesture (press the rail icon, drag across
 * the screen, release over the band) rather than by a precise element-to-element test: only
 * `PanelBar`'s own `<BandSegment>` — the small pill-shaped tab strip inside each band's header row
 * — was ever wired as a drop target (`onDrop`, gated on `dropHere`, in `PanelBar` above). Everything
 * ELSE the band visibly covers — the terminal stream, the Studio's file tree, the resize grip, the
 * empty space around the pill — had no drag handling AT ALL, so a drop landing anywhere but that
 * one small strip was silently ignored. `bottom → rail` never had this problem because the RAIL's
 * own drop target is its ENTIRE column (`PanelRail.tsx`'s outer `role="tablist"` div plus every
 * icon inside it) — there is no narrow pill to miss there. Verified live: dropping precisely onto
 * the bottom band's own tab strip already worked before this fix; dropping onto the Studio's file
 * tree three rows below it, which is what "the bottom band" looks like to someone not aiming at a
 * specific pixel, did nothing at all.
 *
 * `StudioBand`, `SimpleDockedBand` and `ShellBand`'s docked branch each spread this onto their own
 * OUTERMOST element — the same root box whose height they are already measuring for the resize
 * handle — so a drop anywhere within the band's visible bounds resolves as "dropped on this bar"
 * (`{ placement: 'bottom' }`), the same target a drop on the tab strip's own empty space already
 * produced. `onDrop` is OPTIONAL, same convention as `PanelBar`'s: a caller that never wires it
 * renders a band with no drop handling, exactly as before.
 *
 * NATIVE LISTENERS, NEVER REACT PROPS (rail-loose-ends, item 2) — and this is not a style choice,
 * it is the only thing that actually reaches an OPEN Studio's Monaco surface. `StudioHost.tsx`
 * carries the Studio's own DOM node through `createPortal`, physically `appendChild`-ed into
 * whichever slot currently shows it (`StudioBand`'s own `contentRef`) — the standard "portal into a
 * node you move yourself" trick, load-bearing for keeping Monaco's buffers alive across a move. Per
 * React's own documented portal contract, a **synthetic** event fired inside that portal bubbles
 * through the portal's REACT ancestry (`StudioHost` → `SessionsPage`, where it is mounted as a
 * SIBLING of `StudioBand`, never a descendant) — NOT through the DOM ancestry a reader can see on
 * screen. So `onDrop`/`onDropCapture` react props on `StudioBand`'s own root, however they are
 * phrased, can NEVER fire for an event that originated inside the Studio's portaled content: React
 * is not even looking at that subtree when it walks the fiber tree for this dispatch, regardless of
 * where the DOM node has been moved to. Verified two ways: (1) `onDrop` (bubble, the pre-fix shape)
 * never reached this root from Monaco's surface, matching the swallowed-drop report exactly; (2)
 * `onDropCapture` (capture, the FIRST fix attempted here) did not reach it either, even after
 * disabling the one Monaco feature that was originally blamed (`dropIntoEditor`) — ruling out "some
 * descendant calls stopPropagation" as the explanation, since a capture listener on an ANCESTOR runs
 * before any descendant gets a chance regardless. A raw `element.addEventListener(type, fn, true)`
 * on this SAME root node, by contrast, sees the event correctly (confirmed directly), because it
 * follows the real DOM tree the portal was physically moved into — exactly where the reader's mouse
 * is. So this hook now attaches genuine native listeners to the band's root via a ref, in the
 * capture phase, instead of returning JSX props — the DOM tree is the one thing every panel's
 * content, portaled or not, actually shares with this band, and native listeners are the only thing
 * that reads it. `StudioBand`/`SimpleDockedBand`/`ShellBand`'s docked branch each pass `ref` to
 * their own OUTERMOST element instead of spreading `handlers` — `SimpleDockedBand`'s own children
 * are plain React descendants (never portaled), so this fix changes nothing about how they behave,
 * only how the listener is attached.
 *
 * THE ONE EXCEPTION IS THE BAND'S OWN TAB STRIP (`role="tablist"`), and it is excluded ON PURPOSE:
 * `PanelBar`'s own tabs already resolve a POSITIONED drop (spec §3 — "drop precisely on a tab" lands
 * the panel next to that tab, not merely appended) through their own bubble-phase `onDrop` +
 * `stopPropagation` (`BandSegmentTab`, below — genuine React children, not portaled, so React's own
 * bubble dispatch reaches them exactly as documented), and `BandSegment`'s own wrapper already
 * resolves a drop on the strip's blank space the identical way `PanelBar` always has. Capturing
 * ahead of THOSE would consume the event before either one ever got to run, collapsing every
 * positioned drop into a plain append — the exact defect `[planted-revert coverage]` pins in
 * `panelSlots.test.ts` for the pure arithmetic, now true of the DOM wiring too if this exclusion
 * were dropped. So the native drop listener defers (returns without acting) whenever the event's
 * target sits inside a `[role="tablist"]`, letting it fall through to the tab strip's own React
 * handlers exactly as before this pass. `dragover` still marks the WHOLE band highlighted while a
 * drag is over ANY of it, tab strip included — "what lights up is exactly what accepts the drop"
 * (`StudioBand`'s own header) — it only skips `stopPropagation` there, so the tab strip's own
 * per-tab highlight keeps working underneath it.
 *
 * GUARDED BY `hasDragPayload`, never by droppability alone: a FOREIGN drag (an OS file, browser
 * text) is left entirely alone — no `preventDefault`, no `stopPropagation` — so this never turns
 * off some other drop behaviour a panel's content might genuinely want for a drag this app did not
 * originate.
 */
export function useBandDropTarget(onDrop?: (dragPanel: PanelBarId, target: PanelDropTarget) => void): {
  dropHighlight: boolean
  /** Attach to the band's own OUTERMOST element — a plain callback ref, never a React prop bag,
   *  for the reason this function's own header explains at length. */
  ref: (el: HTMLElement | null) => void
} {
  const [over, setOver] = useState(false)
  // The LATEST `onDrop`, read from inside the native listeners — a plain prop reference would make
  // the callback ref below (which attaches once per DOM node, not once per render) close over a
  // stale function if the caller ever passes a new one.
  const onDropRef = useRef(onDrop)
  onDropRef.current = onDrop
  const cleanupRef = useRef<(() => void) | null>(null)

  const ref = useCallback((el: HTMLElement | null) => {
    cleanupRef.current?.()
    cleanupRef.current = null
    if (!el) return
    const onTabStrip = (e: DragEvent): boolean =>
      e.target instanceof Element && e.target.closest('[role="tablist"]') !== null
    const onDragOverNative = (e: DragEvent) => {
      if (!hasDragPayload(e)) return
      e.preventDefault()
      setOver(true)
      // Let it keep descending to the tab strip's own dragover (its per-tab highlight) — only
      // the DROP action is exclusive to one handler or the other, not the highlight.
      if (!onTabStrip(e)) e.stopPropagation()
    }
    const onDragLeaveNative = (e: DragEvent) => {
      if (!hasDragPayload(e)) return
      if (e.currentTarget === e.target) setOver(false)
    }
    const onDropNative = (e: DragEvent) => {
      if (!hasDragPayload(e)) return
      if (onTabStrip(e)) return
      e.preventDefault()
      e.stopPropagation()
      setOver(false)
      const key = readDragPayload(e)
      if (key) onDropRef.current?.(key as PanelBarId, { placement: 'bottom' })
    }
    el.addEventListener('dragover', onDragOverNative, true)
    el.addEventListener('dragleave', onDragLeaveNative, true)
    el.addEventListener('drop', onDropNative, true)
    cleanupRef.current = () => {
      el.removeEventListener('dragover', onDragOverNative, true)
      el.removeEventListener('dragleave', onDragLeaveNative, true)
      el.removeEventListener('drop', onDropNative, true)
    }
    // Attaches once per DOM NODE (mount/unmount of the element itself), never per render — a
    // `useEffect` keyed on `onDrop`'s identity would tear the listeners down and rebuild them on
    // every render where the caller passes a fresh inline function, and keying on `elRef.current`
    // instead does not reliably re-run when only the ref (not a render) changes.
  }, [])

  // `onDrop` absent entirely: no listeners are ever attached (the ref callback still runs, finds
  // nothing to do beyond its own cleanup) — same convention as the old bubble-prop shape, a caller
  // that never wires it renders a band with no drop handling.
  if (!onDrop) return { dropHighlight: false, ref: () => {} }
  return { dropHighlight: over, ref }
}

export function PanelBar({
  entries, lang, studioSeen, harness, onPick, compact = false, onDrop, onMove, onHide,
}: {
  entries: readonly PanelBarEntry[]
  lang: 'pt' | 'en'
  studioSeen: boolean
  /** Names the `cli` tab after what is actually on that session's screen (`targetLabel`). */
  harness?: string
  onPick: (id: PanelBarId) => void
  /**
   * BELOW ~1100PX (`lib/panelBar.ts`'s own `bandBarCompact`), every UNLIT tab drops its visible word
   * and keeps only its icon — the tooltip (`title`) still carries the full sentence. The LIT tab
   * ALWAYS keeps its label: it is the one fact the bar exists to state at a glance.
   */
  compact?: boolean
  /**
   * A drag ended here (spec §3) — either on a specific tab or on this bar's own empty space.
   * OPTIONAL: a caller that never wires it simply renders a non-draggable bar (nothing in this
   * component assumes drag is available).
   */
  onDrop?: (dragPanel: PanelBarId, target: PanelDropTarget) => void
  /**
   * The right-click menu's own move verb (addendum, 2026-09-21) — "move to the rail", since every
   * bottom-band tab's other placement is the rail. OPTIONAL, same reasoning as `onDrop`: a caller
   * that never wires it renders tabs with no context menu at all.
   */
  onMove?: (id: PanelBarId) => void
  /** The right-click menu's own "Ocultar" verb (spec §5). OPTIONAL, same reasoning as `onMove` —
   *  a caller that never wires it simply never offers it. */
  onHide?: (id: PanelBarId) => void
}) {
  const pt = lang === 'pt'
  const [dragOver, setDragOver] = useState<PanelBarId | 'bar' | null>(null)
  const [menu, setMenu] = useState<{ id: PanelBarId; at: { x: number; y: number } } | null>(null)
  const dropHere = onDrop && ((e: React.DragEvent, target: PanelDropTarget) => {
    e.preventDefault()
    const key = readDragPayload(e)
    if (key) onDrop(key as PanelBarId, target)
    setDragOver(null)
  })
  const labelFor = (id: PanelBarId): string => {
    if (id === 'cli') return targetLabel('cli', harness, lang)
    if (id === 'shell') return targetLabel('shell', harness, lang)
    return panelTitle(id, pt)
  }
  const iconFor = (id: PanelBarId): ReactNode => {
    if (id === 'studio') {
      return (
        <span style={{ position: 'relative', display: 'flex' }}>
          {panelIconFor('studio', 14)}
          {!studioSeen && (
            <span aria-hidden="true" style={{
              position: 'absolute', top: -2, right: -2, width: 6, height: 6,
              borderRadius: '50%', background: 'var(--anthropic-orange)',
            }} />
          )}
        </span>
      )
    }
    return panelIconFor(id, 14, harness)
  }
  return (
    <BandSegment
      label={pt ? 'O que mostrar' : 'What to show'} isMobile={false}
      {...(dropHere ? {
        onDragOver: (e: React.DragEvent) => { e.preventDefault(); setDragOver(s => s ?? 'bar') },
        onDrop: (e: React.DragEvent) => dropHere(e, { placement: 'bottom' }),
      } : {})}
      dropHighlight={dragOver === 'bar'}
    >
      {entries.map(({ id, on }) => {
        const label = labelFor(id)
        // An unlit tab in compact mode still carries the FULL text as its accessible name (a screen
        // reader gets no less than before), only painted off-screen rather than beside the icon.
        const hideLabel = compact && !on
        return (
          <BandSegmentTab
            key={id}
            on={on}
            // Stops propagation unconditionally — this bar now renders inside the bottom band's own
            // whole-row collapse toggle (`ShellBand`/`StudioBand`), so an unstopped click would both
            // pick the tab AND collapse the band underneath it.
            onClick={e => { e.stopPropagation(); onPick(id) }}
            icon={iconFor(id)}
            label={hideLabel ? <span style={VISUALLY_HIDDEN}>{label}</span> : <span>{label}</span>}
            title={label}
            {...(onMove || onHide ? {
              onContextMenu: (e: React.MouseEvent<HTMLButtonElement>) => {
                e.preventDefault()
                setMenu({ id, at: { x: e.currentTarget.getBoundingClientRect().left, y: e.currentTarget.getBoundingClientRect().bottom + 4 } })
              },
            } : {})}
            {...(dropHere ? {
              draggable: true,
              onDragStart: (e: React.DragEvent<HTMLButtonElement>) => setDragPayload(e, id),
              onDragEnd: () => setDragOver(null),
              onDragOver: (e: React.DragEvent<HTMLButtonElement>) => {
                e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'move'; setDragOver(id)
              },
              onDrop: (e: React.DragEvent<HTMLButtonElement>) => { e.stopPropagation(); dropHere(e, { panel: id }) },
              dropHighlight: dragOver === id,
            } : {})}
          />
        )
      })}
      {menu && (onMove || onHide) && (
        <PanelContextMenu
          at={menu.at}
          entries={(() => {
            const move = onMove
              ? panelMoveEntry({ panel: menu.id, placement: 'bottom', lang, panelName: labelFor(menu.id) })
              : null
            return [
              ...(move ? [{ id: move.id, label: move.label, icon: <ArrowRight size={14} />, onSelect: () => onMove!(menu.id) }] : []),
              ...(onHide ? [{ id: 'hide', label: pt ? 'Ocultar' : 'Hide', icon: <EyeOff size={14} />, onSelect: () => onHide(menu.id) }] : []),
            ]
          })()}
          onClose={() => setMenu(null)}
        />
      )}
    </BandSegment>
  )
}

/**
 * One tab inside a `BandSegment` — `height: '100%'` fills the wrapper's own fixed height exactly,
 * rather than repeating a second number that could drift from it.
 *
 * DRAG (spec §3) is entirely OPTIONAL here — `ShellBand`'s own `cli`/`shell` segmented switch uses
 * this same component for a fixed two-way choice that is never reordered, so every drag prop is
 * only ever passed by `PanelBar`'s own call site, never required.
 */
export function BandSegmentTab({
  on, onClick, icon, label, isMobile, title, draggable, onDragStart, onDragOver, onDragEnd, onDrop,
  dropHighlight, onContextMenu,
}: {
  on: boolean
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void
  icon?: ReactNode
  label: ReactNode
  isMobile?: boolean
  /** The fuller tooltip sentence. The tab's ACCESSIBLE NAME is always its visible text content
   *  (`label`), never this — a tag folded into `label` (design item 1's "the tag is also part of
   *  the tab's accessible name") would otherwise be lost the moment a caller also set `aria-label`. */
  title?: string
  draggable?: boolean
  onDragStart?: (e: React.DragEvent<HTMLButtonElement>) => void
  onDragOver?: (e: React.DragEvent<HTMLButtonElement>) => void
  onDragEnd?: (e: React.DragEvent<HTMLButtonElement>) => void
  onDrop?: (e: React.DragEvent<HTMLButtonElement>) => void
  /** Is a drag currently hovering THIS tab as its drop target? */
  dropHighlight?: boolean
  /** Right-click / Menu key / Shift+F10 — `PanelBar`'s own context menu (addendum, 2026-09-21).
   *  OPTIONAL, same as the drag props: `ShellBand`'s fixed two-way switch never passes it. */
  onContextMenu?: (e: React.MouseEvent<HTMLButtonElement>) => void
}) {
  return (
    <button
      role="tab"
      aria-selected={on}
      onClick={onClick}
      type="button"
      {...(title !== undefined ? { title } : {})}
      {...(draggable ? { draggable: true, onDragStart, onDragOver, onDragEnd, onDrop } : {})}
      {...(onContextMenu ? { onContextMenu } : {})}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0,
        height: '100%', padding: isMobile ? '0 14px' : '0 9px',
        borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit', border: 'none',
        fontSize: 11, fontWeight: 650, whiteSpace: 'nowrap',
        background: on ? 'var(--bg-surface)' : 'transparent',
        color: on ? 'var(--text-primary)' : 'var(--text-tertiary)',
        boxShadow: dropHighlight ? 'inset 0 0 0 1.5px var(--anthropic-orange)' : undefined,
      }}
    >
      {icon}
      {label}
    </button>
  )
}

/**
 * THE ONE PLACE `lib/panelMenu.ts`'s ICON IDS BECOME REAL ICONS — every menu built from
 * `panelMenuEntries` (`ShellBand`'s own gear, `Studio.tsx`'s own gear, the right slot's own move
 * menu) resolves through this, so an id and its picture cannot disagree between callers the way
 * `PanelRightOpen`'s inward-pointing chevron once disagreed with "Move to the right". See that
 * module's own header for the convention this renders: arrows for a move, `Maximize2`/`Minimize2`
 * for full screen (now `PanelFixedControls`' own fixed button rather than a menu row), never reused
 * for anything else.
 */
export function panelMenuIconFor(id: PanelMenuIconId, size = 14): ReactNode {
  switch (id) {
    case 'arrow-right': return <ArrowRight size={size} />
    case 'arrow-down': return <ArrowDown size={size} />
    case 'maximize': return <Maximize2 size={size} />
    case 'minimize': return <Minimize2 size={size} />
    case 'x': return <X size={size} />
  }
}

export interface BandOverflowEntry {
  id: string
  label: string
  icon: ReactNode
  onSelect: () => void
}

/**
 * BandOverflowMenu — the "⋯" that holds a bottom bar's SECONDARY actions (design item 7: "with the
 * panel segment moving into this bar it must not become a wall of buttons"). Move/Full
 * screen/End shell/Show-hide tree used to sit inline as their own `BandLabeledButton`s, each with an
 * icon AND a visible word (the previous pass's own fix for "the buttons are non-standard sizes") —
 * which is exactly what made the bar too wide once the panel segment grew from three entries to
 * five (owner's screenshot: "segment + Mover para a direita + Tela cheia + Encerrar shell + Recolher
 * — too wide"). The entries KEEP their labels here, inside the menu, where width is not the
 * constraint — only the TRIGGER collapses them.
 *
 * Absent entirely when `entries` is empty, rather than a "⋯" that opens onto nothing: a control
 * whose one outcome is an empty menu teaches nothing, same rule as everywhere else in this file.
 */
export function BandOverflowMenu({ label, entries, isMobile = false, icon }: {
  label: string
  entries: readonly BandOverflowEntry[]
  isMobile?: boolean
  /** The trigger's own icon — `MoreHorizontal` ("⋯", the band's generic overflow) unless the caller
   *  names a more specific one, e.g. `Studio.tsx`'s own gear (`Settings`) for its layout menu, which
   *  is a DIFFERENT menu from the band's own "⋯" and reads as one at a glance only if its trigger
   *  does not share that glyph. */
  icon?: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', key)
    }
  }, [open])
  // FOCUS THE FIRST ITEM ON OPEN — Tab alone would still reach every item (they are plain buttons),
  // but a menu that opens with focus still on its trigger makes a keyboard user press Tab once just
  // to find out the menu is there at all.
  useEffect(() => {
    if (open) menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
  }, [open])
  if (entries.length === 0) return null
  // ARROW-KEY ROVING between the items, Home/End to the ends — the same shape a native <select> or
  // any desktop menu offers, on top of the Tab order every plain <button> already gives for free.
  const roveFocus = (delta: 1 | -1) => {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])
    const i = items.indexOf(document.activeElement as HTMLButtonElement)
    const next = i === -1 ? (delta === 1 ? 0 : items.length - 1) : (i + delta + items.length) % items.length
    items[next]?.focus()
  }
  return (
    <div ref={ref} style={{ position: 'relative', flexShrink: 0, display: 'flex' }}>
      <button
        className="ag-tap-icon"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={e => { e.stopPropagation(); setOpen(o => !o) }}
        style={{
          // The 44px mobile touch target is PROJECTED by `.ag-tap-icon` (`index.css`'s
          // invisible-hitbox rule), never painted here — a literal `width/height: isMobile ? 44`
          // on an icon button is the exact shape `touchTarget.lint.test.ts` refuses, the same rule
          // `SessionsPage.tsx`'s own `rightSlotIconBtn` already follows.
          ...pillBase,
          width: BAND_CONTROL_H, height: BAND_CONTROL_H, padding: 0,
        }}
      >{icon ?? <MoreHorizontal size={14} />}</button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={label}
          onKeyDown={e => {
            if (e.key === 'ArrowDown') { e.preventDefault(); roveFocus(1) }
            else if (e.key === 'ArrowUp') { e.preventDefault(); roveFocus(-1) }
            else if (e.key === 'Home') { e.preventDefault(); menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')[0]?.focus() }
            else if (e.key === 'End') {
              e.preventDefault()
              const items = menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')
              items?.[items.length - 1]?.focus()
            }
          }}
          style={{
            position: 'absolute', top: '100%', right: 0, marginTop: 4, zIndex: 30, minWidth: 200,
            background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8,
            padding: 4, boxShadow: 'var(--ag-shadow-pop)',
          }}
        >
          {entries.map(e => (
            <button
              key={e.id}
              role="menuitem"
              type="button"
              onClick={ev => { ev.stopPropagation(); setOpen(false); e.onSelect() }}
              style={{
                display: 'flex', alignItems: 'center', width: '100%', gap: 8,
                minHeight: isMobile ? 44 : 30, padding: '6px 10px',
                borderRadius: 6, border: 'none', textAlign: 'left',
                background: 'transparent', fontFamily: 'inherit', fontSize: 12, fontWeight: 500,
                color: 'var(--text-primary)', cursor: 'pointer',
              }}
              onMouseEnter={ev => { ev.currentTarget.style.background = 'var(--bg-elevated)' }}
              onMouseLeave={ev => { ev.currentTarget.style.background = 'transparent' }}
            >
              {e.icon}
              {e.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * PanelFixedControls — the ONE cluster of per-panel controls (owner, 2026-09-19: "botões que
 * ficaram fixos pra qualquer aba que for aberta: tela cheia, minimizar... vamos ter apenas 1 icone
 * de engrenagem, ele sera o responsavel pelas configurações das abas de cada uma em individual").
 * Every panel that draws its own chrome — the bottom band's own bar (`ShellBand`, and the new
 * Contents/Hardware bands), the right slot's small header (`SessionsPage`'s `rightSlotBar`), and
 * the Studio's own toolbar in the right slot (`Studio.tsx`) — renders THIS, in THIS fixed order,
 * so a reader never has to relearn where a control lives from one panel to the next:
 *
 *   [gear, only with something to say] → [pin, right-slot panels only]
 *   → [full screen, only where offered] → [minimize, ALWAYS, and ALWAYS LAST]
 *
 * MINIMIZE IS THE RIGHTMOST CONTROL, ALWAYS (owner, 2026-09-25: "quando eu subo a barra, o botao de
 * minimizar vai pra esquerda ... o usuario instintivamente vai subir reto pra minimizar, ele deve se
 * manter a direita no mesmo local"). A collapsed band shows only its reopen chevron, at the far
 * right; the open band used to put the gear to the RIGHT of the minus, so opening the band moved
 * the control the pointer had just used one slot to the left. With minimize last it occupies the
 * same pixel collapsed and open, and the pointer that opened the band can close it without moving.
 * The owner's own order is "config, maximizar, minimizar"; pin, which only a right-slot header
 * draws, sits beside the gear so it never comes between the pointer and minimize either.
 *
 * PIN = FLOAT (owner, 2026-09-27; it replaced the narrow-overlay pass's "keep this overlay open").
 * Pressed on a docked panel — right slot or bottom band — it turns the panel into a floating window
 * over the session area (`lib/floatingPanels.ts`); pressed on that window's header (`active`) it
 * docks the panel back. `pinned` is `undefined` wherever there is nothing to float: on a phone,
 * where nothing floats. The PRESSED state is the pin's own glyph swap (`Pin`, filled when active
 * via `fill: currentColor` — never colour alone, which a colour-blind reader could miss).
 *
 * FULL SCREEN IS NEVER A MENU ROW ANY MORE. It used to be a row inside the same "⋯"/gear menu that
 * also offered move and close, which is what let a reader miss it entirely under two clicks for a
 * control the owner wanted reachable in one. `fullscreen` is `undefined` wherever a panel/slot pair
 * genuinely has nowhere to send it (never present and refusing) — see `fullscreenModeFor` in
 * `lib/panelMenu.ts` for which panels can and cannot.
 *
 * MINIMIZE IS THE LITERAL `−` WHILE THE PANEL IS OPEN, AND AN UP CHEVRON WHILE IT IS COLLAPSED.
 * The `−` came from the owner ("o minimizar laranja vira um `−` literal"), and for one release it was
 * drawn in BOTH states on the window-control reading that minimize never signals current state. On
 * a collapsed bottom band that meant a minimize button on a bar that was already minimized, which
 * the owner reported twice ("o - ainda aparece na barra mesmo com ela fechada"). The callers already
 * switched the LABEL to "Expandir" while collapsed; the glyph now agrees with its own label, and
 * matches what the owner asked for before the `−` existed: "setinha pra cima pra abrir". ALWAYS THE ACCENT
 * ORANGE — never the neutral secondary-text colour every other icon in this file uses, and never
 * buried in the gear. `collapsed` is kept as a prop (some callers still read it for their OWN
 * layout) but no longer changes this glyph. It does NOT decide whether the control is
 * drawn — a panel that can only ever be told to go away (the four right-slot panels that close
 * outright, `panelMenu.ts`'s own `close-right`) simply never reads `collapsed: true`, since there
 * is nothing left on screen to reopen it from once it has gone. `onMinimize` is OPTIONAL for
 * exactly ONE caller (`Studio.tsx`'s own toolbar, bottom-docked): `StudioBand`'s own outer bar
 * ALREADY draws this exact control there (`panelMenu.ts`'s `collapse-bottom`), so a second one here
 * would be the same duplication this whole feature exists to remove — see that call site's own
 * comment. Every other caller always provides it.
 *
 * THE GEAR HOLDS WHATEVER IS LEFT — move, close, panel-specific settings — and is ABSENT, never a
 * disabled trigger, when `gearEntries` is empty (`BandOverflowMenu`'s own rule).
 */
export function PanelFixedControls({
  lang, panelName, fullscreen, collapsed = false, onMinimize, minimizeLabel, pinned, gearLabel,
  gearEntries, isMobile = false,
}: {
  lang: 'pt' | 'en'
  /** The panel's own display name — folded into every button's accessible name/tooltip so two
   *  adjacent controls (e.g. Contents beside Hardware) never read as the same button twice over. */
  panelName: string
  /** Absent wherever this panel/slot pair has nowhere to send full screen. */
  fullscreen?: { active: boolean; onToggle: () => void }
  /** Is the panel this cluster belongs to CURRENTLY collapsed (still assigned, screen released) —
   *  the bottom band's own reading. `false` (the default) for a panel that closes outright instead
   *  of collapsing in place, which never has a "currently collapsed" state to report. */
  collapsed?: boolean
  /** Absent for exactly one caller — see this component's own header. */
  onMinimize?: () => void
  minimizeLabel?: string
  /** Absent wherever this cluster is not a RIGHT-SLOT header — see this component's own PIN
   *  paragraph. */
  pinned?: { active: boolean; onToggle: () => void }
  gearLabel: string
  gearEntries: readonly BandOverflowEntry[]
  isMobile?: boolean
}) {
  const pt = lang === 'pt'
  // The 44px mobile touch target is PROJECTED by `.ag-tap-icon` (`index.css`'s invisible-hitbox
  // rule), never painted here — a literal `width/height: isMobile ? 44` on an icon button is the
  // exact shape `touchTarget.lint.test.ts` refuses, the same rule `BandOverflowMenu`'s own trigger
  // and `SessionsPage.tsx`'s own `rightSlotIconBtn` already follow.
  const iconBtn: React.CSSProperties = {
    display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
    width: BAND_CONTROL_H, height: BAND_CONTROL_H, padding: 0,
    borderRadius: 6, border: 'none', background: 'transparent', cursor: 'pointer',
  }
  return (
    <>
      <BandOverflowMenu label={gearLabel} icon={<Settings size={14} />} entries={gearEntries} isMobile={isMobile} />
      {pinned && (
        <button
          className="ag-tap-icon"
          type="button"
          aria-pressed={pinned.active}
          onClick={e => { e.stopPropagation(); pinned.onToggle() }}
          title={pinned.active
            ? (pt ? `Encaixar ${panelName} de volta` : `Dock ${panelName} back`)
            : (pt ? `Soltar ${panelName} como janela` : `Float ${panelName} as a window`)}
          aria-label={pinned.active
            ? (pt ? `Encaixar ${panelName} de volta` : `Dock ${panelName} back`)
            : (pt ? `Soltar ${panelName} como janela` : `Float ${panelName} as a window`)}
          style={{ ...iconBtn, color: pinned.active ? 'var(--anthropic-orange)' : 'var(--text-secondary)' }}
        ><Pin size={14} {...(pinned.active ? { fill: 'currentColor' } : {})} /></button>
      )}
      {fullscreen && (
        <button
          className="ag-tap-icon"
          type="button"
          onClick={e => { e.stopPropagation(); fullscreen.onToggle() }}
          title={fullscreen.active
            ? (pt ? `Sair da tela cheia — ${panelName}` : `Exit full screen — ${panelName}`)
            : (pt ? `${panelName} em tela cheia` : `${panelName} full screen`)}
          aria-label={fullscreen.active
            ? (pt ? `Sair da tela cheia — ${panelName}` : `Exit full screen — ${panelName}`)
            : (pt ? `${panelName} em tela cheia` : `${panelName} full screen`)}
          style={{ ...iconBtn, color: 'var(--text-secondary)' }}
        >{fullscreen.active ? <Minimize2 size={14} /> : <Maximize2 size={14} />}</button>
      )}
      {onMinimize && (
        <button
          className="ag-tap-icon"
          type="button"
          onClick={e => { e.stopPropagation(); onMinimize() }}
          title={minimizeLabel}
          aria-label={minimizeLabel}
          style={{ ...iconBtn, color: 'var(--anthropic-orange)' }}
        >{collapsed ? <ChevronUp size={14} /> : <Minus size={14} />}</button>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------------------------
// PanelContextMenu — the icon-level right-click menu
// ---------------------------------------------------------------------------------------------

export interface PanelContextMenuEntry {
  id: string
  label: string
  icon: ReactNode
  onSelect: () => void
}

/**
 * PanelContextMenu — right-click on a rail icon or a bottom-band tab (owner feedback, 2026-09-21:
 * "a engrenagem pode sumir tbm se a opcao for somente 'mover pra baixo' ou 'mover para direita' pq
 * agora com arrasta e solta nao tem mais necessidade de ter uma engrenagem so pra isso"). It holds
 * exactly what a GEAR whose only row was ever a move verb used to hold — that row moved HERE, not
 * away, because drag reaches neither the keyboard nor a phone and the spec's own rule (§9) is that
 * every verb reachable by drag is also reachable by click. The gear stays exactly where a panel has
 * something ELSE to say (the Studio's tree options, the Shell's "end this shell", a genuine close);
 * this menu is additional there too, never a replacement for that gear's own entries.
 *
 * KEYBOARD-REACHABLE FOR FREE: the `contextmenu` DOM event already fires for the Menu key and
 * `Shift+F10` on a focused element, with no extra wiring — a component that answers `onContextMenu`
 * on a focusable element (every rail icon and bar tab already is one, `role="tab"`) is reachable
 * that way without a second, bespoke keyboard path to drift from the pointer one.
 *
 * PORTALED, `position: fixed`, ANCHORED TO THE TRIGGERING ELEMENT'S OWN RECT rather than
 * `event.clientX/clientY` — a keyboard-fired `contextmenu` reports those inconsistently across
 * browsers (often 0,0 or the viewport corner), while the element's `getBoundingClientRect()` is
 * always where the reader is actually looking. Portaled for the same reason the rail's own tooltip
 * is now portaled: the rail's `overflow: hidden` would otherwise clip a menu opening to its left.
 */
export function PanelContextMenu({ at, entries, onClose }: {
  at: { x: number; y: number } | null
  entries: readonly PanelContextMenuEntry[]
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!at) return
    const away = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose() }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', key)
    }
  }, [at, onClose])
  useEffect(() => {
    if (at) ref.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
  }, [at])
  if (!at || entries.length === 0) return null
  const width = 220
  const left = Math.min(at.x, window.innerWidth - width - 8)
  const top = Math.min(at.y, window.innerHeight - entries.length * 34 - 16)
  return createPortal(
    <div
      ref={ref} role="menu"
      style={{
        position: 'fixed', left, top, width, zIndex: 1300,
        borderRadius: 10, border: '1px solid var(--border-subtle)',
        background: 'var(--bg-elevated)', boxShadow: 'var(--ag-shadow-menu)',
        padding: 4, display: 'grid', gap: 1,
      }}
    >
      {entries.map(entry => (
        <button
          key={entry.id} type="button" role="menuitem"
          onClick={e => { e.stopPropagation(); entry.onSelect(); onClose() }}
          style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px',
            borderRadius: 6, border: 'none', background: 'transparent', cursor: 'pointer',
            fontFamily: 'inherit', fontSize: 12, color: 'var(--text-primary)', textAlign: 'left',
          }}
        >{entry.icon}{entry.label}</button>
      ))}
    </div>,
    document.body,
  )
}

// ---------------------------------------------------------------------------------------------
// PanelTileDropdown — the rail's overflow "more" list (§4) and the config area's eye list (§5)
// ---------------------------------------------------------------------------------------------

export interface PanelTile {
  id: string
  icon: ReactNode
  title: string
  /** The panel's own one-line description (`panelDescription`) — same copy the rail's tooltip
   *  shows, so a reader who has hovered an icon before recognizes the sentence here too. */
  description: string
  /** The verb button's own label, e.g. "Restaurar" for the eye's list — omitted for the overflow
   *  list, where the whole tile IS the pick (spec §4: "An item picked there opens as usual"). */
  verbLabel?: string
}

/**
 * PanelTileDropdown — ONE shared component behind two different questions (design §4's "more"
 * button and §5's eye), because both ask "here is a short list of panels the rail currently has no
 * room/reason to show as an icon — pick one." Tiles read exactly like the mobile "More" sheet's own
 * (`App.tsx`'s `allTiles.map`): a square, an icon, a title, ONE extra line — here the panel's own
 * description instead of that sheet's badge, since these tiles answer "what is this panel" rather
 * than "how many of something does it hold."
 *
 * Closes on pick, on `Esc`, and on a click outside — spec §4's own three rules, shared by §5's list
 * since nothing about "why" the list is showing changes how it should close.
 *
 * Anchored to the TRIGGER's own rect (`at`), never the click point — same reasoning as
 * `PanelContextMenu`'s own header: a keyboard-opened dropdown has no meaningful click point, and the
 * rail's `overflow: hidden` would clip this in place exactly as it clipped the tooltip before that
 * bug was fixed, so this is portaled the same way.
 */
export function PanelTileDropdown({ at, tiles, onPick, onClose, label }: {
  at: { x: number; y: number } | null
  tiles: readonly PanelTile[]
  onPick: (id: string) => void
  onClose: () => void
  /** The dropdown's own accessible name — "N ocultos" / "N mais" — read by a screen reader on open. */
  label: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!at) return
    const away = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose() }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', key)
    }
  }, [at, onClose])
  useEffect(() => {
    if (at) ref.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
  }, [at])
  if (!at || tiles.length === 0) return null
  const cols = Math.min(2, tiles.length)
  const tileW = 132
  const width = cols * tileW + (cols - 1) * 6 + 16
  const rows = Math.ceil(tiles.length / cols)
  const rowH = 92
  const height = Math.min(rows, 3) * rowH + (Math.min(rows, 3) - 1) * 6 + 16
  const left = Math.min(at.x, window.innerWidth - width - 8)
  const top = Math.min(at.y, window.innerHeight - height - 8)
  return createPortal(
    <div
      ref={ref} role="menu" aria-label={label}
      style={{
        position: 'fixed', left, top, width, maxHeight: height, zIndex: 1300,
        borderRadius: 12, border: '1px solid var(--border-subtle)',
        background: 'var(--bg-elevated)', boxShadow: 'var(--ag-shadow-menu)',
        padding: 8, display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: 6,
        overflowY: 'auto',
      }}
    >
      {tiles.map(tile => (
        <button
          key={tile.id} type="button" role="menuitem"
          onClick={e => { e.stopPropagation(); onPick(tile.id); onClose() }}
          title={`${tile.title} — ${tile.description}`}
          style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center',
            gap: 4, padding: '10px 8px', borderRadius: 8, minHeight: rowH,
            border: '1px solid var(--border-subtle)', background: 'var(--bg-surface)',
            color: 'var(--text-primary)', cursor: 'pointer', fontFamily: 'inherit',
          }}
        >
          {tile.icon}
          <span style={{ fontSize: 11, fontWeight: 700, lineHeight: 1.2 }}>{tile.title}</span>
          <span style={{
            fontSize: 9.5, color: 'var(--text-tertiary)', lineHeight: 1.3,
            display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
          }}>{tile.description}</span>
          {tile.verbLabel && (
            <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--anthropic-orange)', marginTop: 2 }}>
              {tile.verbLabel}
            </span>
          )}
        </button>
      ))}
    </div>,
    document.body,
  )
}

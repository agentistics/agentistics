/**
 * SessionStatsMenu — what THIS conversation has spent, in a dropdown beside the session's controls.
 *
 * The dashboard has a strip of figures for the whole machine; this is the same question asked of
 * the session you have open. Asked for directly, and the first line of it is the one that decides
 * when to start a new conversation: how full the context window is.
 *
 * Every rule about what the numbers MEAN lives in `sessionStats.ts`. This file draws them, and its
 * only judgement is how to say "not available" — twice, differently:
 *
 *   `harness`    this assistant cannot produce it at all (`HARNESS_CAPABILITIES`)
 *   `unrecorded` the conversation is not in the local store yet
 *
 * They send a reader to two different places, so they are two sentences and never one dash.
 */

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { sessionOpened, sessionTime } from '../../lib/sessionTime'
import { asideCache, asideKey } from '../../lib/asideCache'
import { Activity, BarChart3, ChevronDown, ChevronRight, ChevronUp, ListChecks, PanelRight, X } from 'lucide-react'
import { fmt, fmtCost, type CostBasis, type HarnessId, type SessionMeta } from '@agentistics/core'
import { HARNESS_LABELS } from '../../lib/harness'
import { sessionStats, statReason, type SessionStats } from '../../lib/sessionStats'
import { replyCost, replyCostExceeds } from '../../lib/replyCost'
import { useIdlePrefs } from '../../lib/idleSessionsPrefs'
import { costBasisLabel, viewCost } from '../../lib/costBasis'
import { sessionReferences, type SessionReference } from '../../lib/sessionReferences'
import { useArtifactLive } from '../../lib/artifactsStore'
import { scrollIsOutside } from '../../lib/popoverScroll'
import { modelDisplay } from '../../lib/modelDisplay'
import { usePlanLimits } from '../../lib/planLimits'
import { PlanLimitsBlock } from '../PlanLimitMeter'

/**
 * The trigger button's own percentage colour — a THREE-tier ramp, deliberately not the same as the
 * expanded bar's two (see the bar's own comment for why they may not share one). The button sat
 * fixed and neutral at 96% no matter what, which is the one figure on this whole panel that says
 * what to do next (finish up, rather than keep extending a conversation about to be compacted) —
 * reported as "a % não muda de cor de acordo com quanto de contexto já foi consumido". `>= 0.85`
 * matches the bar's own red threshold; `>= 0.6` gives the badge a step before the window is
 * actually a problem, since it is read constantly rather than only once the menu is opened.
 */
function contextTone(fraction: number): string {
  return fraction >= 0.85 ? 'var(--accent-red)' : fraction >= 0.6 ? 'var(--anthropic-orange)' : 'var(--text-secondary)'
}

/**
 * The composer's ring gauge's own colour — the SAME two thresholds `contextTone` uses (0.6, 0.85),
 * so the ring and the badge never disagree about what counts as "getting full". The LOW tier
 * differs on purpose: `contextTone` reads neutral there because it sits beside other icon-sized
 * text in a busy header row, where a green digit at 12% usage would be one more colour competing
 * for attention. The ring is a DEDICATED gauge with nothing else on it, so green earns its keep —
 * it is what says "plenty of room left" at a glance, the same reading a fuel gauge gives.
 */
function contextRingTone(fraction: number): string {
  return fraction >= 0.85 ? 'var(--accent-red)' : fraction >= 0.6 ? 'var(--anthropic-orange)' : 'var(--accent-green)'
}

/**
 * ContextRing — the composer's own circular gauge (design item 3): an SVG ring that fills
 * CLOCKWISE with the session's context-window usage, the percentage centred inside it. Clockwise
 * from 12 o'clock is `rotate(-90deg)` on the progress stroke plus a DECREASING `strokeDashoffset`
 * (a full circumference offset is empty, `0` is full) — the standard SVG technique, chosen over a
 * conic-gradient so the same markup renders identically in every browser this app already supports
 * without a vendor-prefixed fallback.
 */
function ContextRing({ fraction, size = 26, stroke = 3 }: { fraction: number; size?: number; stroke?: number }) {
  const radius = (size - stroke) / 2
  const circumference = 2 * Math.PI * radius
  const filled = Math.min(1, Math.max(0, fraction))
  const color = contextRingTone(fraction)
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ display: 'block', flexShrink: 0 }}>
      <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--border)" strokeWidth={stroke} />
      <circle
        cx={size / 2} cy={size / 2} r={radius} fill="none" stroke={color} strokeWidth={stroke}
        strokeDasharray={circumference} strokeDashoffset={circumference * (1 - filled)}
        strokeLinecap="round" transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: 'stroke-dashoffset 0.3s, stroke 0.3s' }}
      />
    </svg>
  )
}

export interface SessionStatsMenuProps {
  harness: string
  sessionId: string
  /** The store's record for this conversation, or `undefined` when it has none yet. */
  meta: SessionMeta | undefined
  /**
   * The card's figures ALREADY computed, for a session with no store record whose numbers come from
   * elsewhere — a NATIVE session's engine usage (`nativeStats.ts`). Wins over `meta` when given.
   */
  stats?: SessionStats
  lang: 'pt' | 'en'
  currency: 'USD' | 'BRL'
  brlRate: number
  /**
   * The model and effort this session was STARTED with, off the fleet row.
   *
   * Deliberately separate from `SessionStats.model`, which is what the STORE observed the
   * conversation using. They usually agree and are not the same claim: one is what agentop asked
   * for, the other what the transcript recorded. Absent means no flag was passed and the harness's
   * own default is in force, which the card says in words.
   */
  startedModel?: string
  startedEffort?: string
  /**
   * Size the trigger for a finger, and open the card where a narrow screen can hold it.
   *
   * The desktop's 30px button and its 300px panel anchored to the button's right edge are correct
   * in a 1400px strip and wrong in a 390px bar — the target is under the 44px rule this repo holds
   * everything else to, and a fixed-width panel hanging off a control near the right edge is a
   * panel with a piece off the screen.
   */
  touch?: boolean
  /**
   * `'button'` (default) is the header's own bordered pill. `'tab'` was the workspace strip's old
   * hanging "Filtros"-style pill — RETIRED (design item 4/3, owner 2026-09-27: the header tab moved
   * into the composer) and kept only so a stray caller does not silently fall back to `'button'`;
   * nothing in this product renders it any more. `'gauge'` is the CURRENT desktop composer control:
   * a small circular ring (`ContextRing`, above) rather than a bordered pill, opening its card
   * UPWARD from the composer through a PORTAL (`createPortal` to `document.body`, `position:
   * fixed`) rather than `position: absolute` inside this component's own box — the composer sits at
   * the bottom of the conversation panel's `overflow` clip, and an absolutely-positioned dropdown
   * would be cut off by it exactly where a reader needs to see it. The dropdown CARD is untouched
   * across every variant — same content, same open/close behaviour — only the trigger's shape and
   * the card's anchor change.
   */
  variant?: 'button' | 'tab' | 'gauge'
  /**
   * The dropdown's own ceiling in `'tab'` mode — `metricsTabBounds(...).panelMaxWidth`
   * (`lib/sessionsFiltersPanel.ts`), the room clear of BOTH asides. Ignored in `'button'`/`'gauge'`
   * mode. Defaults to the card's ordinary 300px when not given.
   */
  panelMaxWidth?: number
  /**
   * The basis the DASHBOARD is on, which is where this card opens.
   *
   * The card can be switched to the other one to compare, and that switch is LOCAL: it lasts as
   * long as the card is open and changes nothing global. The dashboard's basis is a decision about
   * how the user reads their money; looking at one session in the other basis for a moment is not.
   */
  costBasis?: CostBasis
  /**
   * `C/A` for THIS session's harness — `planAllocation(basis).byHarness[harness]`.
   *
   * Per-harness and never the aggregate: a session is one harness's spend, and pricing it against
   * a factor that also covers a subscription paying for something else is not an allocation of
   * anything. `null` (or absent) means no plan covers this harness, and then there is NO toggle —
   * an offer whose only outcome is "no registered plan" is the dead control this product refuses
   * everywhere else.
   */
  planFactor?: number | null
  /**
   * OPEN THE WHOLE READING — the same figures with everything the store also knows: the token
   * split with its account, every tool with its output volume, each subagent invocation, the
   * workflow runs, the hour distribution.
   *
   * A CALLBACK and not a flag, because this card does not know where "everything" opens. In the
   * sessions workspace it is a tab in the right aside, where the numbers sit beside the
   * conversation they are about; on a surface with no aside there is nothing to open and the
   * caller passes nothing, so the link is ABSENT rather than inert — the same rule the fleet's
   * verbs keep. The caller also withholds it when the store has no record of this conversation,
   * which is the same fact that decides whether the tab exists at all.
   */
  onOpenFull?: () => void
  /**
   * The DELIVERY this session is filed under — its NAME, straight off the fleet row.
   *
   * A name and not an id because that is what the row carries: the id lives on the session record
   * the server holds and never reaches the wire. `findTask` resolves a ref by title, so the name IS
   * a ref the board accepts — see `lib/sessionTaskLink.ts`. Absent when the session is filed under
   * nothing, and then NOTHING is drawn: no dash, no empty row.
   */
  task?: string
  /**
   * Open that delivery. A CALLBACK for the same reason `onOpenFull` is one — this card does not
   * know how the surface around it navigates. Absent where there is nowhere to go, and then the
   * delivery is NAMED rather than offered as a control that does nothing.
   */
  onOpenTask?: (ref: string) => void
  /**
   * Open the aside's LIVE tab, on the step `ref` names when there is one.
   *
   * A CALLBACK for the same reason the two above are. Absent where the aside cannot be opened, and
   * then the "Live" reference is ABSENT rather than inert.
   */
  onOpenLive?: (ref?: string) => void
  /**
   * The id the artifacts store describes this session under — the FLEET ROW's id, which is not
   * `sessionId` (that one is the conversation's, when it has one).
   *
   * The card reads what the session is doing right now from `artifactsStore` itself rather than
   * having every caller subscribe: the desktop card is drawn from `App.tsx`, a very large component
   * that would otherwise re-render each time a tool call starts. Absent, the Live reference is a
   * plain link to the feed.
   */
  rowId?: string
}

export function SessionStatsMenu({
  harness, sessionId, meta, stats, lang, currency, brlRate, startedModel, startedEffort, touch = false,
  variant = 'button', panelMaxWidth, costBasis = 'api', planFactor = null, onOpenFull, task, onOpenTask, onOpenLive, rowId,
}: SessionStatsMenuProps) {
  const pt = lang === 'pt'
  // PLAN.LIMITS: this harness's plan windows, when it reported any (none → nothing drawn).
  const planSnap = usePlanLimits()
  const plan = planSnap.limits?.find(l => l.harness === harness)
  const [open, setOpen] = useState(false)

  /**
   * How many times this conversation has been COMPACTED — read only when the card is opened, and
   * cached, because it is a scan of the whole transcript (70 ms on a real 39 MB one).
   *
   * It belongs beside the context gauge: the gauge says how full THIS window is, the count says how
   * many windows came before it. Absent, never zero, whenever it could not be established.
   */
  type Facts = { compactions?: number; unavailable?: string }
  const factsKey = asideKey(sessionId, 'conversation')
  const [facts, setFacts] = useState<Facts | null>(
    () => asideCache.read<Facts>(factsKey).value ?? null,
  )
  useEffect(() => {
    if (!open) return
    const hit = asideCache.read<Facts>(factsKey)
    if (hit.value && !hit.stale) { setFacts(hit.value); return }
    let alive = true
    fetch(`/api/fleet/conversation?id=${encodeURIComponent(sessionId)}&lang=${pt ? 'pt' : 'en'}`)
      .then(r => r.json())
      .then((d: Facts) => { asideCache.write(factsKey, d); if (alive) setFacts(d) })
      .catch(() => { if (alive) setFacts(f => f ?? { unavailable: pt ? 'Não foi possível ler.' : 'Could not read it.' }) })
    return () => { alive = false }
  }, [open, factsKey, sessionId, pt])
  /**
   * THE BASIS THIS CARD IS SHOWING — local, and paired with the dashboard every time it opens.
   *
   * The toggle exists so one session can be read in the other basis for a moment; it is not a
   * decision about how the user reads their money, which is what the dashboard's switch is. So it
   * is re-seeded from `costBasis` on every open, and closing the card is what puts it back — there
   * is nothing to put back, because nothing global was ever changed.
   */
  const [basisHere, setBasisHere] = useState<CostBasis>(costBasis)
  useEffect(() => { if (open) setBasisHere(costBasis) }, [open, costBasis])

  const boxRef = useRef<HTMLDivElement | null>(null)
  /**
   * THE CARD'S OWN ELEMENT — needed by the outside-click check below for exactly one variant.
   * `'gauge'` PORTALS its card to `document.body` (see `panel`'s own header), so it is never a DOM
   * descendant of `boxRef` — the trigger's wrapper — and the plain `boxRef.contains(target)` test
   * every other variant relies on always reads a click INSIDE the portaled card as outside, closing
   * it before whatever was pressed (a Block's toggle, the cost-basis switch, a reference row) ever
   * runs. Attached on every variant for one shared check rather than a `'gauge'`-only branch.
   */
  const panelRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => {
      const t = e.target as Node
      if (boxRef.current?.contains(t) || panelRef.current?.contains(t)) return
      setOpen(false)
    }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', esc)
    }
  }, [open])

  /**
   * THE PANEL'S OWN HEIGHT CEILING — genuinely measured, never a fixed guess. The card is
   * `position: absolute` with a `top` offset relative to `boxRef`'s own box, so how much of the
   * viewport is actually left below it depends on where the TRIGGER sits on the page, not on this
   * file's own `top` constant alone — a trigger sitting low in a short window can have almost no
   * room under it at all. Left unbounded, the panel's last sections ("No repositório", the "Ver
   * tudo no painel" link) simply clip off the bottom of the viewport with no way to reach them —
   * reported: "o card dos stats da sessao estao passando pra baixo da pagina e nao ta exibindo
   * tudo corretamente." Measured when the card opens, and again on every `resize` while it stays
   * open (the same reactive shape `useViewportWidth` already uses for the sibling Filtros panel),
   * because the trigger's own position on the page is not something this component can know from a
   * CSS constant alone. Floored well above zero so a trigger pushed off-screen never yields a
   * negative or unusably thin panel.
   */
  const [maxPanelHeight, setMaxPanelHeight] = useState<number | null>(null)
  useEffect(() => {
    if (!open || variant === 'gauge') return
    const measure = () => {
      const triggerTop = boxRef.current?.getBoundingClientRect().top ?? 0
      const panelTop = triggerTop + (touch ? 48 : 36)
      setMaxPanelHeight(Math.max(160, window.innerHeight - panelTop - 16))
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [open, touch, variant])

  /**
   * THE GAUGE'S OWN DROP-UP ANCHOR — `'gauge'` is the one variant whose card must ESCAPE its
   * trigger's own ancestry: the composer sits at the bottom of the conversation panel's `overflow`
   * clip, so a card positioned `absolute` inside this component's box (as every other variant's
   * is) would be cut off by that clip rather than floating above the composer where a reader needs
   * to see it. `position: fixed` measured off the trigger's OWN `getBoundingClientRect()` — the
   * same "measure the real box, never guess" rule `maxPanelHeight` and the sibling Filtros panel
   * both already follow — with `bottom` (not `top`) because this card opens UPWARD.
   */
  const [gaugeAnchor, setGaugeAnchor] = useState<{ left: number; bottom: number; maxHeight: number } | null>(null)
  useEffect(() => {
    if (!open || variant !== 'gauge') return
    const measure = () => {
      const r = boxRef.current?.getBoundingClientRect()
      if (!r) return
      const width = 300
      setGaugeAnchor({
        // Clamped to the viewport on both sides — the trigger sits near the composer's own edge,
        // and an unclamped left would hang the card's far edge off the screen on a narrow window.
        left: Math.min(Math.max(8, r.left), window.innerWidth - width - 8),
        bottom: window.innerHeight - r.top + 8,
        maxHeight: Math.max(160, r.top - 16),
      })
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [open, variant])

  /**
   * A PORTALED PANEL NEEDS ITS OWN SCROLL RULE (`popoverScroll.ts`'s own header) — a capture-phase
   * `window` scroll listener is the usual way to close a popover the page scrolled away from, but
   * capture phase means it also fires when the CARD's own content scrolls (the "In the repository"
   * block, on a long reading past the fold), and closing on that beats the very click a reader was
   * scrolling toward. `scrollIsOutside` is the same test `PickerMenu`/`BoardArrange`/`ChipSelect`
   * already share for their own portaled panels. Scoped to `'gauge'`, the one variant that portals.
   */
  useEffect(() => {
    if (!open || variant !== 'gauge') return
    const onScroll = (e: Event) => { if (scrollIsOutside(panelRef.current, e.target)) setOpen(false) }
    window.addEventListener('scroll', onScroll, true)
    return () => window.removeEventListener('scroll', onScroll, true)
  }, [open, variant])

  const h = harness as HarnessId
  const s = stats ?? sessionStats(h, sessionId, meta)
  const money = (usd: number) => fmtCost(usd, currency, brlRate)
  /**
   * The plan side is offered only when it can actually be produced for THIS harness — see
   * `planFactor`. `viewCost` is what applies it, and it refuses rather than inventing: a basis it
   * cannot produce comes back as the API figure flagged, and `costBasisLabel` then says API.
   */
  const canSwitchBasis = typeof planFactor === 'number' && Number.isFinite(planFactor)
  const inBasis = (usd: number) =>
    viewCost(usd, { basis: basisHere, factor: canSwitchBasis ? planFactor : null, allocated: true })
  const cost = s.costUSD === null ? null : inBasis(s.costUSD)
  const label = (HARNESS_LABELS as Record<string, string>)[harness] ?? harness
  const reply = replyCost(h, meta)
  const replyThreshold = useIdlePrefs().replyCostThreshold
  const replyWarn = replyCostExceeds(reply.lastTurn, replyThreshold)

  /** The sentence for an absent figure — see the header. */
  const na = (metric: Parameters<typeof statReason>[1]) =>
    statReason(h, metric) === 'harness'
      ? (pt ? `${label} não reporta isso` : `${label} does not report this`)
      : (pt ? 'ainda não registrado' : 'not recorded yet')

  const contextGlyph = (
    <>
      <BarChart3
        size={touch ? 18 : (variant === 'tab' ? 12 : 14)}
        {...(s.context && !open ? { color: contextTone(s.context.fraction) } : {})}
      />
      {/* The context percentage rides the BUTTON, because it is the one figure that changes what
          you do next — a conversation near its window is one to finish rather than extend. It is
          absent, not zero, when it cannot be known. Its OWN colour follows how full the window
          is (`contextTone`, the same ramp the bar inside uses) rather than the button's open/
          closed state — that state still wins while the menu is open, where the accent border
          already says "this is active" and a red 96% fighting it for attention reads as a fault. */}
      {s.context && (
        <span style={{ fontWeight: 650, ...(open ? {} : { color: contextTone(s.context.fraction) }) }}>
          {Math.floor(s.context.fraction * 100)}%
        </span>
      )}
    </>
  )

  /**
   * THE REFERENCES — what the session is doing right now comes off the artifacts store (the page
   * that reads the conversation publishes it; see `ArtifactsState.live`), and everything else is
   * this card's own props. The Live row is offered only where the caller can open that tab.
   */
  const live = useArtifactLive(rowId)
  const references = sessionReferences({
    pt, task, canOpenTask: Boolean(onOpenTask), canOpenLive: Boolean(onOpenLive), live,
    canOpenFull: Boolean(onOpenFull),
  })
  const press = (r: SessionReference) => {
    const a = r.action
    if (a === null) return
    if (a.type === 'task') onOpenTask?.(a.ref)
    else if (a.type === 'live') onOpenLive?.(a.ref)
    else onOpenFull?.()
  }

  // THE DROPDOWN — computed ONCE, read by BOTH triggers below. Its CONTENT never changes with
  // `variant` (design item 4 — "keeping its existing dropdown unchanged"); only its HORIZONTAL
  // ANCHOR does, and only because the trigger itself moved. The `'button'` trigger sits at the
  // header's own right edge, so the card opens LEFTWARD from it (`right: 0`) — the only direction
  // with room.
  //
  // THE `'tab'` TRIGGER ALSO OPENS LEFTWARD NOW (owner, 2026-09-20 — the tabs moved to the top
  // right): it sits immediately BEFORE "Filtros", which itself sits flush against the ARTIFACTS
  // aside, so a card opening rightward (toward Filtros, then the aside) would swallow both. It
  // opens `right: 0` instead, into the session's own content on the LEFT, clamped to
  // `panelMaxWidth` — the room `metricsTabBoundsRight` (`lib/sessionsFiltersPanel.ts`) already
  // measured clear of both asides on that side. Same anchor as `'button'`, different reason: that
  // one has nowhere else to go from the header's own right edge; this one now shares the same
  // right-hand neighbourhood as the button used to.
  /**
   * ONE STYLE OBJECT, branched by variant — `'gauge'` is `position: fixed` off the measured
   * `gaugeAnchor` (dropping UPWARD, escaping the composer's own overflow clip via the portal
   * below); every other variant keeps the original `position: absolute` anchored to this
   * component's own box. The CARD's own visual chrome (padding, radius, border, shadow) is shared
   * across all three — only the anchor and the ceiling differ.
   */
  const panelStyle: React.CSSProperties = variant === 'gauge'
    ? {
        position: 'fixed', zIndex: 1200,
        left: gaugeAnchor?.left ?? -9999, bottom: gaugeAnchor?.bottom ?? -9999,
        width: 'min(300px, calc(100vw - 16px))',
        padding: 12, borderRadius: 12,
        background: 'var(--bg-elevated)', border: '1px solid var(--border)',
        boxShadow: '0 -12px 32px rgba(0,0,0,0.4)',
        ...(gaugeAnchor ? { maxHeight: gaugeAnchor.maxHeight, overflowY: 'auto' as const } : {}),
      }
    : {
        position: 'absolute', top: touch ? 48 : 36, zIndex: 60, right: 0,
        // On a phone it is measured from the VIEWPORT, not given a fixed width: this control sits
        // near the right edge of a 390px bar, so a 300px panel anchored to it would hang a piece
        // of itself off the screen.
        ...(touch
          ? { width: 'min(300px, calc(100vw - 24px))' }
          : { width: variant === 'tab' ? (panelMaxWidth ?? 300) : 300 }),
        padding: 12, borderRadius: 12,
        background: 'var(--bg-elevated)', border: '1px solid var(--border)',
        boxShadow: '0 12px 32px rgba(0,0,0,0.4)',
        // See `maxPanelHeight`'s own comment: a card that does not fit between its trigger and
        // the bottom of the viewport scrolls internally instead of silently clipping.
        ...(maxPanelHeight !== null ? { maxHeight: maxPanelHeight, overflowY: 'auto' as const } : {}),
      }
  const panelCard = open && (
      <div ref={panelRef} style={panelStyle}>
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
            <span style={{
              fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em',
              color: 'var(--text-tertiary)',
            }}>{pt ? 'Esta sessão' : 'This session'}</span>
            <button
              onClick={() => setOpen(false)}
              aria-label={pt ? 'Fechar' : 'Close'}
              style={{
                marginLeft: 'auto', display: 'flex', width: 22, height: 22, borderRadius: 6,
                alignItems: 'center', justifyContent: 'center', border: 'none',
                background: 'transparent', color: 'var(--text-tertiary)', cursor: 'pointer',
              }}
            ><X size={13} /></button>
          </div>

          {/* HOW THIS SESSION IS RUNNING — before the numbers, because it is what the numbers are
              OF. `model` has two sources and they are not the same claim: what agentop was asked to
              start (the spawn ALIAS, "opus") and what the transcript recorded ("claude-opus-5-5").
              The OBSERVED one wins, through `modelLabel` ("Opus 5.5"); the alias is only the fallback
              for a session that has not said anything yet. An absent flag is said in words — a blank
              cell would read as "none". */}
          <Block title={pt ? 'Como está rodando' : 'How it is running'}>
            <Line
              k={pt ? 'Modelo' : 'Model'}
              v={modelDisplay(harness, s.model, startedModel) ?? (pt ? 'padrão do harness' : 'the harness default')}
            />
            <Line
              k={pt ? 'Esforço' : 'Effort'}
              v={startedEffort ?? (pt ? 'padrão do harness' : 'the harness default')}
            />
            {/* A count of what has already been thrown away, beside the gauge of what is left. */}
            <Line
              k={pt ? 'Compactações' : 'Compactions'}
              v={facts?.compactions !== undefined
                ? fmt(facts.compactions)
                : facts === null ? '…' : '—'}
            />
            {facts?.compactions === undefined && facts?.unavailable && (
              <Absent text={facts.unavailable} />
            )}
          </Block>

          {/* CONTEXT — a bar, and the bar SATURATES while the label keeps counting. A session can
              genuinely exceed the documented window, and a clamped label would hide exactly that. */}
          <Block title={pt ? 'Contexto' : 'Context'}>
            {s.context ? (
              <>
                <div style={{
                  height: 6, borderRadius: 3, background: 'var(--bg-base)', overflow: 'hidden',
                  marginBottom: 5,
                }}>
                  <div style={{
                    height: '100%', width: `${Math.min(100, s.context.fraction * 100)}%`,
                    // Deliberately its OWN two-tier rule, not `contextTone`: a FILLED bar reads fine
                    // starting orange at any size (that is just "how much is used"), while the badge
                    // above stays neutral until there is something worth noticing — sharing one scale
                    // would either paint this bar grey at low usage (looks broken) or paint the badge
                    // orange from the first token (a colour that means nothing once it never changes).
                    background: s.context.fraction >= 0.85 ? 'var(--accent-red)' : 'var(--anthropic-orange)',
                    transition: 'width 0.3s',
                  }} />
                </div>
                <Line
                  k={`${Math.floor(s.context.fraction * 100)}%`}
                  v={`${fmt(s.context.used)} / ${fmt(s.context.window)}`}
                />
              </>
            ) : <Absent text={na('contextWindow')} />}
          </Block>

          <Block title={pt ? 'Plano' : 'Plan'}>
            {plan ? <PlanLimitsBlock limits={plan} now={planSnap.now} lang={lang} header details forecast /> : (
              <Absent text={pt
                ? `${(HARNESS_LABELS as Record<string, string>)[harness] ?? harness} ainda não informou os limites do plano — eles aparecem aqui assim que informar.`
                : `${(HARNESS_LABELS as Record<string, string>)[harness] ?? harness} has not reported plan limits yet — they will appear here when available.`} />
            )}
          </Block>

          {/* COST PER REPLY — every reply resends the whole conversation, so the context of the last
              turn is what one more message costs in tokens. A calm sentence past the threshold,
              never a modal; absent figures are said, not zeroed. */}
          <Block title={pt ? 'Custo por resposta' : 'Cost per reply'}>
            {reply.lastTurn === null && reply.average === null ? <Absent text={na('contextWindow')} /> : (
              <>
                <Line k={pt ? 'Última resposta' : 'Last reply'} v={reply.lastTurn === null ? (pt ? 'não informado' : 'not reported') : `${fmt(reply.lastTurn)} tok`} />
                <Line k={pt ? 'Média da sessão' : 'Session average'} v={reply.average === null ? (pt ? 'não informado' : 'not reported') : `${fmt(reply.average)} tok`} />
                {replyWarn && (
                  <div role="status" style={{ marginTop: 6, fontSize: 11, lineHeight: 1.5, color: 'var(--text-secondary)' }}>
                    {pt
                      ? `Esta sessão custa ${fmt(reply.lastTurn ?? 0)} tokens por resposta; considere passar o bastão para uma sessão nova.`
                      : `This session costs ${fmt(reply.lastTurn ?? 0)} tokens per reply; consider handing over to a fresh session.`}
                  </div>
                )}
              </>
            )}
          </Block>

          <Block title="Tokens">
            {s.tokens && s.conversation ? (
              <>
                <Line k={pt ? 'Total (com cache)' : 'Total (with cache)'}
                  v={fmt(s.tokens.input + s.tokens.output + s.tokens.cacheRead + s.tokens.cacheWrite)} />
                <Line k={pt ? 'Sem cache (i/o)' : 'Without cache (i/o)'}
                  v={`${fmt(s.conversation.input)} / ${fmt(s.conversation.output)}`} />
                <Line k={pt ? 'Cache lido / escrito' : 'Cache read / write'}
                  v={`${fmt(s.tokens.cacheRead)} / ${fmt(s.tokens.cacheWrite)}`} />
              </>
            ) : <Absent text={na('tokens')} />}
          </Block>

          <Block title={pt ? 'Custo' : 'Cost'}>
            {/* THE TOGGLE IS ONLY HERE WHEN A PLAN COVERS THIS HARNESS. Without a factor the plan
                side could only ever answer "no registered plan", and a control whose one outcome is
                a refusal teaches the same wrong thing as a missing one. */}
            {canSwitchBasis && (
              <div role="group" aria-label={pt ? 'Base do custo' : 'Cost basis'} style={{
                display: 'flex', gap: 2, padding: 2, marginBottom: 6, borderRadius: 7,
                background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)',
              }}>
                {(['api', 'plan'] as const).map(b => {
                  const on = basisHere === b
                  return (
                    <button
                      key={b}
                      onClick={() => setBasisHere(b)}
                      aria-pressed={on}
                      style={{
                        flex: 1, minHeight: touch ? 32 : 22, borderRadius: 5, border: 'none',
                        cursor: 'pointer', fontFamily: 'inherit', fontSize: 10.5,
                        fontWeight: on ? 700 : 500,
                        background: on ? 'var(--bg-surface)' : 'transparent',
                        color: on ? 'var(--anthropic-orange)' : 'var(--text-tertiary)',
                      }}
                    >
                      {b === 'api' ? 'API' : (pt ? 'Plano' : 'Plan')}
                    </button>
                  )
                })}
              </div>
            )}
            {cost === null
              ? <Absent text={na('cost')} />
              : <Line k={costBasisLabel(cost, pt)} v={money(cost.usd)} />}
          </Block>

          {/* ASKED FOR: how long this session has been going. Two figures, not one, and the pair is
              the point — `sessionTime` is the same helper the dashboard's longest-session card uses,
              so the two surfaces cannot disagree about what "active" means.
              ACTIVE is the time the conversation was actually working; ELAPSED is wall clock from
              its first turn to its last. On a session left open overnight they differ by hours, and
              reporting only the second would say a session cost twelve hours when it cost forty
              minutes. Absent rather than zero when the record has no timing at all — a conversation
              the store has not seen yet is not one that took no time. */}
          <Block title={pt ? 'Tempo' : 'Time'}>
            {/* WHEN IT WAS OPENED comes first and stands on its own: it is a fact about the record
                (`start_time`), true the moment the conversation exists, and it must not wait for
                a duration the way the two figures below do. */}
            {(() => {
              const opened = sessionOpened(meta?.start_time, lang)
              const timed = meta && (meta.duration_minutes ?? 0) > 0 ? sessionTime(meta, lang) : null
              if (!opened && !timed) return <Absent text={pt ? 'ainda não registrado' : 'not recorded yet'} />
              return (
                <>
                  {opened && <Line k={pt ? 'Aberta em' : 'Opened'} v={opened} />}
                  {timed && timed.active !== null && <Line k={pt ? 'Ativo' : 'Active'} v={timed.active} />}
                  {timed && <Line k={pt ? 'Decorrido' : 'Elapsed'} v={timed.elapsed} />}
                </>
              )
            })()}
          </Block>

          <Block title={pt ? 'Mensagens' : 'Messages'}>
            {s.messages ? (
              <Line k={pt ? 'Suas / do agente' : 'Yours / the agent’s'}
                v={`${fmt(s.messages.user)} / ${fmt(s.messages.assistant)}`} />
            ) : <Absent text={pt ? 'ainda não registrado' : 'not recorded yet'} />}
          </Block>

          <Block title="Subagents">
            {s.subagents ? (
              s.subagents.count === 0
                ? <Line k={pt ? 'Nenhum rodou' : 'None ran'} v="—" />
                : (
                  <>
                    <Line k={pt ? 'Rodaram' : 'Ran'} v={fmt(s.subagents.count)} />
                    <Line k="Tokens" v={fmt(s.subagents.tokens)} />
                    {/* The same basis as the card's own cost row: two money figures in one card
                        under two different bases is a card that cannot be added up. */}
                    <Line k={pt ? 'Custo' : 'Cost'} v={money(inBasis(s.subagents.costUSD).usd)} />
                  </>
                )
            ) : <Absent text={na('agents')} />}
          </Block>

          <Block title={pt ? 'No repositório' : 'In the repository'} last={references.length === 0}>
            {s.git ? (
              <>
                <Line k="Commits" v={fmt(s.git.commits)} />
                <Line k={pt ? 'Linhas' : 'Lines'} v={`+${fmt(s.git.added)} / −${fmt(s.git.removed)}`} />
                <Line k={pt ? 'Arquivos' : 'Files'} v={fmt(s.git.files)} />
              </>
            ) : <Absent text={na('gitLines')} />}
          </Block>

          {/* EVERY LINK OUT OF THIS CARD, TOGETHER, AT THE FOOT. They used to be scattered — the
              delivery at the top, "see everything in the panel" at the bottom — which meant the
              card had two different places to look for "where does this go", each with its own
              styling. Which rows exist, in what order and with what words is `sessionReferences`
              (pure, tested); this only draws them. Empty means NO heading at all: a title over
              nothing is the dead control this product refuses. */}
          {references.length > 0 && (
            <Block title={pt ? 'Referências' : 'References'} last>
              {references.map(r => (
                <ReferenceRow
                  key={r.id} r={r} touch={touch}
                  onPress={() => { press(r); setOpen(false) }}
                />
              ))}
            </Block>
          )}
        </div>
  )
  // The GAUGE's card is a PORTAL to `document.body` — it must escape the composer's own overflow
  // clip, which an absolutely-positioned descendant never could. Every other variant stays exactly
  // where it always rendered, as a child of this component's own box.
  const panel = variant === 'gauge' ? (panelCard && createPortal(panelCard, document.body)) : panelCard

  if (variant === 'gauge') {
    // THE COMPOSER'S CONTEXT GAUGE (design item 3) — a ring, not a pill, because this trigger sits
    // among icon buttons (attach, dictate) rather than in a text-heavy strip. ABSENT ENTIRELY, not
    // a bare icon, when the session has no measurable context: a control with nothing to show is
    // the confident-zero shape this product refuses everywhere else, and `s.context` is the one
    // fact that decides whether the ring has anything to draw at all.
    if (!s.context) return null
    const pct = Math.floor(s.context.fraction * 100)
    // OWNER FEEDBACK (2026-09-27): the first pass read too small to make out at a glance — a control
    // read constantly, unlike the dropdown it opens. 30px (up from 26) with the SAME stroke keeps
    // the ring itself a fine line rather than a fat one, and the number goes up to 11px/700 at the
    // circle's own new size — the two together are what makes it legible rather than merely present.
    // The "%" sign is dropped from the FACE (three digits plus a percent sign no longer fit at this
    // size without shrinking the digits back down) and kept in the accessible name instead — a
    // sighted reader already knows a context gauge reads in percent, the same reason a battery icon
    // needs no unit beside its number.
    const GAUGE_SIZE = 30
    return (
      <div ref={boxRef} style={{ position: 'relative', flexShrink: 0, display: 'flex' }}>
        <button
          onClick={() => setOpen(v => !v)}
          aria-expanded={open}
          aria-label={pt ? `Métricas desta sessão — contexto em ${pct}%` : `This session’s metrics — context at ${pct}%`}
          title={pt ? `Métricas desta sessão — contexto em ${pct}%` : `This session’s metrics — context at ${pct}%`}
          style={{
            position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: GAUGE_SIZE, height: GAUGE_SIZE, padding: 0, borderRadius: '50%', flexShrink: 0,
            border: open ? '1px solid var(--anthropic-orange)' : '1px solid transparent',
            background: 'transparent', cursor: 'pointer',
          }}
        >
          <ContextRing fraction={s.context.fraction} size={GAUGE_SIZE} stroke={3} />
          <span style={{
            position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 11, fontWeight: 700, color: 'var(--text-primary)',
            fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.03em',
          }}>
            {pct}
          </span>
        </button>
        {panel}
      </div>
    )
  }

  if (variant === 'tab') {
    // THE SAME PILL THE "FILTROS" TAB WEARS (design item 4, screenshot 7) — hanging BELOW the
    // workspace strip rather than sitting IN it, so the header carries only the title and the
    // right-slot switcher.
    return (
      <div ref={boxRef} style={{ position: 'relative', flexShrink: 0 }}>
        <button
          onClick={() => setOpen(v => !v)}
          aria-expanded={open}
          aria-label={pt ? 'Métricas desta sessão' : 'This session’s metrics'}
          title={pt ? 'Métricas desta sessão' : 'This session’s metrics'}
          style={{
            display: 'flex', alignItems: 'center', gap: 5, padding: '2px 10px 3px',
            border: '1px solid var(--border)', borderTop: 'none',
            borderRadius: '0 0 8px 8px', background: 'var(--bg-surface)',
            color: open ? 'var(--anthropic-orange)' : 'var(--text-tertiary)',
            cursor: 'pointer', fontFamily: 'inherit', fontSize: 10.5,
          }}
        >
          {contextGlyph}
          {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </button>
        {panel}
      </div>
    )
  }

  return (
    <div ref={boxRef} style={{ position: 'relative', flexShrink: 0 }}>
      <button
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
        aria-label={pt ? 'Métricas desta sessão' : 'This session’s metrics'}
        title={pt ? 'Métricas desta sessão' : 'This session’s metrics'}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
          height: touch ? 44 : 30, minWidth: touch ? 44 : 0, padding: touch ? '0 8px' : '0 10px',
          borderRadius: 9, cursor: 'pointer', flexShrink: 0,
          border: touch && !open ? 'none' : '1px solid ' + (open ? 'var(--anthropic-orange)' : 'var(--border-subtle)'),
          background: open ? 'var(--anthropic-orange-dim)' : (touch ? 'transparent' : 'var(--bg-elevated)'),
          color: open ? 'var(--anthropic-orange)' : 'var(--text-secondary)',
          fontFamily: 'inherit', fontSize: 12,
        }}
      >
        {contextGlyph}
      </button>
      {panel}
    </div>
  )
}

function Block({ title, children, last }: { title: string; children: React.ReactNode; last?: boolean }) {
  return (
    <div style={{
      paddingBottom: last ? 0 : 8, marginBottom: last ? 0 : 8,
      borderBottom: last ? 'none' : '1px solid var(--border-subtle)',
    }}>
      <p style={{
        margin: '0 0 5px', fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
        letterSpacing: '0.05em', color: 'var(--text-tertiary)',
      }}>{title}</p>
      {children}
    </div>
  )
}

function Line({ k, v }: { k: string; v: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 11.5, lineHeight: 1.7 }}>
      <span style={{ color: 'var(--text-tertiary)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{k}</span>
      <span style={{ marginLeft: 'auto', color: 'var(--text-primary)', fontWeight: 600, whiteSpace: 'nowrap' }}>{v}</span>
    </div>
  )
}

const REF_ICON: Record<SessionReference['id'], React.ReactNode> = {
  task: <ListChecks size={12} style={{ flexShrink: 0 }} />,
  live: <Activity size={12} style={{ flexShrink: 0 }} />,
  full: <PanelRight size={12} style={{ flexShrink: 0 }} />,
}

/**
 * ONE reference: icon, the row's name, a second line, and a chevron when pressing does something.
 *
 * The same visual language the delivery link always had — orange, 11.5px, a trailing chevron — with
 * a second line added, because "Live" and "Delivery" are names for a KIND of place and what the
 * reader needs is which one. A row with nowhere to go (a delivery on a surface that cannot
 * navigate) is drawn as a quiet line without the chevron, not as a control that does nothing.
 */
function ReferenceRow({ r, touch, onPress }: { r: SessionReference; touch: boolean; onPress: () => void }) {
  const inner = (
    <>
      <span style={{ display: 'flex', flexShrink: 0, paddingTop: 2, color: r.action ? 'var(--anthropic-orange)' : 'var(--text-tertiary)' }}>
        {REF_ICON[r.id]}
      </span>
      <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1, gap: 1 }}>
        <span style={{
          fontSize: 11.5, fontWeight: 600, lineHeight: 1.4,
          color: r.action ? 'var(--anthropic-orange)' : 'var(--text-primary)',
        }}>{r.label}</span>
        {(r.detail || r.detailVerb) && (
          <span style={{
            display: 'flex', gap: 5, minWidth: 0, fontSize: 10.5, lineHeight: 1.4,
            color: 'var(--text-tertiary)', fontWeight: 400,
          }}>
            {r.detailVerb && (
              <span style={{ flexShrink: 0, fontWeight: 700, color: 'var(--anthropic-orange)' }}>{r.detailVerb}</span>
            )}
            {r.detail && (
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {r.detail}
              </span>
            )}
          </span>
        )}
      </span>
      {r.action && <ChevronRight size={12} style={{ flexShrink: 0, color: 'var(--anthropic-orange)' }} />}
    </>
  )
  const base: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 8, width: '100%', boxSizing: 'border-box',
    padding: '4px 0', textAlign: 'left', fontFamily: 'inherit',
    // 44px is the MOBILE number, and a reference is a control, not a read-only line.
    minHeight: touch ? 44 : 0,
  }
  return r.action ? (
    <button
      onClick={onPress}
      data-reference={r.id}
      style={{ ...base, border: 'none', background: 'transparent', cursor: 'pointer', color: 'inherit' }}
    >{inner}</button>
  ) : (
    <div data-reference={r.id} style={base}>{inner}</div>
  )
}

/** N/A with its REASON. Never a dash on its own — that is the confident zero in another costume. */
function Absent({ text }: { text: string }) {
  return <p style={{ margin: 0, fontSize: 11, lineHeight: 1.5, color: 'var(--text-tertiary)' }}>{text}</p>
}

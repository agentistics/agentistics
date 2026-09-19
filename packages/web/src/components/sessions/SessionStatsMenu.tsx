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
import { sessionTime } from '../../lib/sessionTime'
import { asideCache, asideKey } from '../../lib/asideCache'
import { BarChart3, ChevronDown, ChevronRight, ChevronUp, ListChecks, PanelRight, X } from 'lucide-react'
import { fmt, fmtCost, type CostBasis, type HarnessId, type SessionMeta } from '@agentistics/core'
import { HARNESS_LABELS } from '../../lib/harness'
import { sessionStats, statReason } from '../../lib/sessionStats'
import { costBasisLabel, viewCost } from '../../lib/costBasis'
import { sessionTaskLink } from '../../lib/sessionTaskLink'

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

export interface SessionStatsMenuProps {
  harness: string
  sessionId: string
  /** The store's record for this conversation, or `undefined` when it has none yet. */
  meta: SessionMeta | undefined
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
   * `'button'` (default) is the header's own bordered pill, unchanged. `'tab'` is the SAME visual
   * language as the workspace strip's own "Filtros" tab (design item 4, screenshot 7) — a small
   * pill hanging BELOW the strip rather than sitting IN it, reached from `App.tsx`'s
   * `sessionMetricsBounds` wrapper. Only the TRIGGER changes shape; the dropdown card below it is
   * untouched — same position, same content, same open/close behaviour — because the brief asks for
   * the button to move, not for the card it opens to be rebuilt.
   */
  variant?: 'button' | 'tab'
  /**
   * The dropdown's own ceiling in `'tab'` mode — `metricsTabBounds(...).panelMaxWidth`
   * (`lib/sessionsFiltersPanel.ts`), the room clear of BOTH asides. Ignored in `'button'` mode,
   * where the card has always opened leftward from the header's own right edge with no neighbour
   * to clear. Defaults to the card's ordinary 300px when not given.
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
}

export function SessionStatsMenu({
  harness, sessionId, meta, lang, currency, brlRate, startedModel, startedEffort, touch = false,
  variant = 'button', panelMaxWidth, costBasis = 'api', planFactor = null, onOpenFull, task, onOpenTask,
}: SessionStatsMenuProps) {
  const pt = lang === 'pt'
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

  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', esc)
    }
  }, [open])

  const h = harness as HarnessId
  const s = sessionStats(h, sessionId, meta)
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

  // THE DROPDOWN — computed ONCE, read by BOTH triggers below. Its CONTENT never changes with
  // `variant` (design item 4 — "keeping its existing dropdown unchanged"); only its HORIZONTAL
  // ANCHOR does, and only because the trigger itself moved. The `'button'` trigger sits at the
  // header's own right edge, so the card opens LEFTWARD from it (`right: 0`) — the only direction
  // with room. The `'tab'` trigger sits right after "Filtros", a short distance from the LEFT
  // aside, so the same leftward card would swallow that aside whole; it opens RIGHTWARD instead
  // (`left: 0`), toward the session's own content, clamped to `panelMaxWidth` — the room
  // `metricsTabBounds` (`lib/sessionsFiltersPanel.ts`) already measured clear of BOTH asides.
  const panel = open && (
      <div style={{
          position: 'absolute', top: touch ? 48 : 36, zIndex: 60,
          ...(variant === 'tab' ? { left: 0 } : { right: 0 }),
          // On a phone it is measured from the VIEWPORT, not given a fixed width: this control sits
          // near the right edge of a 390px bar, so a 300px panel anchored to it would hang a piece
          // of itself off the screen.
          ...(touch
            ? { width: 'min(300px, calc(100vw - 24px))' }
            : { width: variant === 'tab' ? (panelMaxWidth ?? 300) : 300 }),
          padding: 12, borderRadius: 12,
          background: 'var(--bg-elevated)', border: '1px solid var(--border)',
          boxShadow: '0 12px 32px rgba(0,0,0,0.4)',
        }}>
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

          {/* WHICH DELIVERY THIS SESSION BELONGS TO — first, because it is the only line here that
              is about the WORK rather than about the spend, and it is the one you follow out of
              this card. Absent entirely for a session filed under nothing: the alternative is a row
              saying "—", which is the confident zero in another costume. */}
          {(() => {
            const link = sessionTaskLink(task, Boolean(onOpenTask))
            if (link.kind === 'none') return null
            return (
              <Block title={pt ? 'Entrega' : 'Delivery'}>
                {link.kind === 'link' ? (
                  <button
                    onClick={() => { onOpenTask?.(link.title); setOpen(false) }}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 6, width: '100%',
                      // 44px is the MOBILE number, and this is a control, not a read-only line.
                      minHeight: touch ? 44 : 0, padding: 0,
                      border: 'none', background: 'transparent', color: 'var(--anthropic-orange)',
                      fontFamily: 'inherit', fontSize: 11.5, fontWeight: 600,
                      cursor: 'pointer', textAlign: 'left',
                    }}
                  >
                    <ListChecks size={12} style={{ flexShrink: 0 }} />
                    <span style={{
                      minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>{link.title}</span>
                    <ChevronRight size={12} style={{ marginLeft: 'auto', flexShrink: 0 }} />
                  </button>
                ) : (
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: 6,
                    fontSize: 11.5, lineHeight: 1.7, color: 'var(--text-primary)', fontWeight: 600,
                  }}>
                    <ListChecks size={12} style={{ flexShrink: 0, color: 'var(--text-tertiary)' }} />
                    <span style={{
                      minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>{link.title}</span>
                  </div>
                )}
              </Block>
            )
          })()}

          {/* HOW THIS SESSION IS RUNNING — before the numbers, because it is what the numbers are
              OF. `model` has two sources and they are not the same claim: what agentop was asked to
              start (the row) and what the transcript recorded (the store). The row wins when it has
              one, and an absent flag is said in words — a blank cell would read as "none". */}
          <Block title={pt ? 'Como está rodando' : 'How it is running'}>
            <Line
              k={pt ? 'Modelo' : 'Model'}
              v={startedModel ?? s.model ?? (pt ? 'padrão do harness' : 'the harness default')}
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
            {meta && (meta.duration_minutes ?? 0) > 0 ? (() => {
              const t = sessionTime(meta, lang)
              return (
                <>
                  {t.active !== null && <Line k={pt ? 'Ativo' : 'Active'} v={t.active} />}
                  <Line k={pt ? 'Decorrido' : 'Elapsed'} v={t.elapsed} />
                </>
              )
            })() : <Absent text={pt ? 'ainda não registrado' : 'not recorded yet'} />}
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

          <Block title={pt ? 'No repositório' : 'In the repository'} last>
            {s.git ? (
              <>
                <Line k="Commits" v={fmt(s.git.commits)} />
                <Line k={pt ? 'Linhas' : 'Lines'} v={`+${fmt(s.git.added)} / −${fmt(s.git.removed)}`} />
                <Line k={pt ? 'Arquivos' : 'Files'} v={fmt(s.git.files)} />
              </>
            ) : <Absent text={na('gitLines')} />}
          </Block>

          {/* THE WAY TO THE FULL READING. This card is what a 300px popover can hold; the panel
              holds the rest, and saying so here is what stops the two being built twice. It names
              WHERE it opens — a link that moves something on the other side of the screen without
              saying so reads as a control that did nothing. */}
          {onOpenFull && (
            <button
              onClick={() => { onOpenFull(); setOpen(false) }}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, width: '100%',
                marginTop: 10, paddingTop: 10,
                // 44px is the MOBILE number — this is the one CONTROL in a card of read-only
                // lines, so it is the one thing here that has to be a target.
                minHeight: touch ? 44 : 0,
                borderTop: '1px solid var(--border-subtle)', borderLeft: 'none',
                borderRight: 'none', borderBottom: 'none',
                background: 'transparent', color: 'var(--anthropic-orange)',
                fontFamily: 'inherit', fontSize: 11.5, fontWeight: 600,
                cursor: 'pointer', textAlign: 'left',
              }}
            >
              <PanelRight size={12} style={{ flexShrink: 0 }} />
              <span style={{ minWidth: 0 }}>
                {pt ? 'Ver tudo no painel' : 'See everything in the panel'}
              </span>
              <ChevronRight size={12} style={{ marginLeft: 'auto', flexShrink: 0 }} />
            </button>
          )}
        </div>
  )

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

/** N/A with its REASON. Never a dash on its own — that is the confident zero in another costume. */
function Absent({ text }: { text: string }) {
  return <p style={{ margin: 0, fontSize: 11, lineHeight: 1.5, color: 'var(--text-tertiary)' }}>{text}</p>
}

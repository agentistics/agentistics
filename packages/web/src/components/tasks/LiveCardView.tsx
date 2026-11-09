/**
 * LiveCardView — the Live card, OPTION A (owner, 06/11): one block per question, in reading order —
 * what it is, whose it is, how it is, what it waits for, who runs it, where it is on the way, how
 * long, when it ends, what it did last.
 *
 *   title / context line / role + state / waiting reason / harness·model·effort · account /
 *   6-segment stage bar / time row / two estimate boxes / last action
 *
 * It draws what `liveCardModel` decided; it owns no rule of its own.
 */

import React from 'react'
import { ArrowLeft, Check, CalendarClock, CircleDashed, Clock, CornerDownRight, ExternalLink } from 'lucide-react'
import type { FleetRow } from '../../lib/fleet'
import { accountDisplayName } from '../../lib/planLimits'
import { describeLastAction, shortTitle } from '@agentistics/core'
import type { LiveSortId } from '@agentistics/core'
import { RoleChip } from '../sessions/RoleChip'
import { surface } from './board'
import { LivePriorityChip } from './LivePriorityChip'
import {
  cardPills, isQueued, queuePosition, STAGE_LABEL, type LiveCard, type LiveStage, type RuntimeFacts,
} from './liveDeliveryModel'
import { blockLines, cardPercent, cardStateWord, stepSourceNote, ciChecklist, etaBoxes, queueLines, stageBar, timeRow, waitingReason } from './liveCardModel'
import { LiveOdometer } from './LiveOdometer'
import { openSessionWord, SESSION_LINK_WORD, type SessionLink } from './liveSessionLinks'

const STATE_COLOR = {
  working: 'var(--accent-green, #3ecf8e)', waiting: 'var(--text-tertiary)',
  'needs-you': 'var(--accent-red, #ff5f5f)', down: 'var(--accent-red, #ff5f5f)', none: 'var(--text-tertiary)',
} as const
const MUTED = 'var(--text-tertiary)'

export interface LiveCardViewProps {
  c: LiveCard
  cards: readonly LiveCard[]
  nowMs: number
  pt: boolean
  fleet: readonly FleetRow[]
  accountLabels: Record<string, string>
  runtime?: Record<string, RuntimeFacts>
  /** The leader this worker answers to, as a person reads it ("Motor"). */
  leaderName: string | null
  role: 'leader' | 'worker'
  mobile: boolean
  onOpen: (c: LiveCard) => void
  /** The column it just came from: a small pill says so for a few seconds after a move. */
  cameFrom?: LiveStage | null
  /** Inside the Publicado accordion the card is the expanded body of a row: no outer border radius games. */
  embedded?: boolean
  /** The order the columns are drawn in — a queued card's "1º / 2º" is its place in THAT order. */
  sort?: LiveSortId
  /** "abrir sessão" links (author / QA / leader). The card itself is a button, so each link is a role=link span. */
  links?: readonly SessionLink[]
  onOpenSession?: (id: string) => void
}

export function LiveCardView(p: LiveCardViewProps) {
  const { c, nowMs, pt, mobile } = p
  const d = c.d
  const queued = isQueued(c)
  const pos = queuePosition(p.cards, c, p.sort)
  const agent = c.agents[0]
  const pills = cardPills(c, a => (a.accountId ? accountDisplayName(p.accountLabels, a.harness, a.accountId) : null), pt ? 'conta' : 'account', p.runtime, pt)
  const stateWord = cardStateWord(c, pt)
  const reason = waitingReason(c, p.fleet, pt)
  const bar = stageBar(d.stage, d.block?.originStage)
  const time = timeRow(c, nowMs, pt)
  const boxes = etaBoxes(d, pt)
  const block = d.block ? blockLines(d.block, d.stageSinceMs, nowMs, pt) : null
  const titleOf = (id: string) => p.fleet.find(r => r.id === id)?.title
  const last = describeLastAction(d.lastAction, pt ? 'pt' : 'en', titleOf)
  const ctx = [d.subtaskId ? d.taskTitle : null, p.leaderName ? `${pt ? 'líder' : 'leader'} ${p.leaderName}` : null].filter(Boolean).join(' · ')
  const stageColor = STAGE_LABEL[d.stage].color
  const pct = cardPercent(d, pt)
  const ci = d.stage === 'ci' && d.ci ? ciChecklist(d.ci, pt) : null
  const queue = queued ? queueLines(d, pt, (h, a) => accountDisplayName(p.accountLabels, h, a)) : null

  return (
    <button
      type="button" data-live-card={d.key} data-stage={d.stage} data-alert={c.alert ? '1' : undefined} data-queued={queued ? '1' : undefined}
      onClick={() => p.onOpen(c)}
      style={{
        ...surface, display: 'grid', gap: 5, textAlign: 'left', width: '100%', padding: mobile ? '10px 12px' : '8px 9px',
        cursor: 'pointer', fontFamily: 'inherit', color: 'var(--text-primary)', minWidth: 0, boxSizing: 'border-box',
        border: queued ? '1px dashed var(--border)' : `1px solid ${c.alert ? 'var(--accent-red, #ff5f5f)' : 'var(--border)'}`,
        ...(queued ? { opacity: 0.7 } : {}),
        ...(p.embedded ? { borderTopLeftRadius: 0, borderTopRightRadius: 0, borderTop: 0 } : {}),
      }}
    >
      {p.cameFrom && (
        <span data-live-came-from style={{ display: 'inline-flex', alignItems: 'center', gap: 4, width: 'fit-content', fontSize: 10.5, padding: '2px 7px', borderRadius: 999, border: `1px solid ${stageColor}`, color: stageColor }}>
          <ArrowLeft size={10} aria-hidden />{pt ? 'veio de' : 'came from'} {STAGE_LABEL[p.cameFrom][pt ? 'pt' : 'en']} · {pt ? 'agora' : 'now'}
        </span>
      )}
      <span style={{ display: 'flex', alignItems: 'flex-start', gap: 6, minWidth: 0 }}>
        <span title={d.title} data-live-title style={{ flex: 1, minWidth: 0, fontWeight: 650, fontSize: 12, lineHeight: 1.3, overflowWrap: 'anywhere' }}>{shortTitle(d.title)}</span>
        {d.old && <span data-live-old title={pt ? 'Revisão de antes do fluxo, sem ninguém nela há mais de 72 h.' : 'A review from before the flow, with nobody on it for over 72 h.'} style={{ flexShrink: 0, fontSize: 10, padding: '1px 6px', borderRadius: 999, border: '1px solid var(--border)', color: 'var(--text-tertiary)' }}>{pt ? 'antiga' : 'old'}</span>}
        <LivePriorityChip priority={d.priority} pt={pt} />
      </span>
      {ctx && <span style={{ fontSize: 11, color: MUTED, overflowWrap: 'anywhere', lineHeight: 1.3 }}>{ctx}</span>}

      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 11.5, minWidth: 0 }}>
        <span data-live-role={p.role}><RoleChip role={p.role} pt={pt} /></span>
        <span aria-hidden style={{ width: 7, height: 7, borderRadius: '50%', background: queued ? MUTED : STATE_COLOR[c.liveState], flexShrink: 0 }} />
        <b data-live-state style={{ fontWeight: 600 }}>{stateWord}{agent && c.agents.length > 1 ? ` · ${c.agents.length}` : ''}</b>
        {queued && <span data-live-queued style={{ color: MUTED, letterSpacing: '.04em', fontSize: 10.5 }}>{pt ? 'NA FILA' : 'QUEUED'}{pos ? ` · ${pos}${pt ? 'º' : pos === 1 ? 'st' : pos === 2 ? 'nd' : pos === 3 ? 'rd' : 'th'}` : ''}</span>}
      </span>
      {reason && <span data-live-reason style={{ display: 'flex', gap: 5, alignItems: 'flex-start', fontSize: 11.5, color: 'var(--accent-yellow, #e5b341)', lineHeight: 1.3, overflowWrap: 'anywhere' }}><Clock size={12} aria-hidden style={{ flexShrink: 0, marginTop: 1 }} /><span>{reason}</span></span>}

      {block && (
        <span data-live-block style={{ display: 'grid', gap: 1, fontSize: 11.5, padding: '5px 7px', borderRadius: 6, background: 'rgba(229,72,77,.10)', border: '1px solid rgba(229,72,77,.35)' }}>
          <b style={{ fontWeight: 600, color: 'var(--accent-red, #ff5f5f)', overflowWrap: 'anywhere' }}>{block.reason}</b>
          <span>{block.unlocker}{block.since ? ` · ${block.since}` : ''}</span>
          {block.origin && <span style={{ color: MUTED }}>{block.origin}</span>}
        </span>
      )}
      {d.blockedReason && !block && <span style={{ fontSize: 11, color: 'var(--accent-red, #ff5f5f)', overflowWrap: 'anywhere' }}>{d.blockedReason}</span>}

      {(pills.runtime || pills.account) && (
        // ONE plain grey line — "claude · sonnet · high · conta Vini" — exactly as the approved preview draws it; the
        // two coloured, bordered pills this replaced were the QA's MED 8.
        <span data-live-pill="runtime" style={{ fontSize: 11, color: MUTED, overflowWrap: 'anywhere', lineHeight: 1.3 }}>
          {[pills.runtime, pills.account].filter(Boolean).join(' · ')}
        </span>
      )}

      {!queued && (
        <>
          <span aria-hidden data-live-bar style={{ display: 'flex', gap: 3, marginTop: 3 }}>
            {bar.map(s => (
              <i key={s.stage} data-seg={s.state} style={{
                flex: 1, height: 5, borderRadius: 3, transition: 'background .4s ease',
                background: s.state === 'cur' && pct ? `linear-gradient(to right, ${s.color} ${pct.pct}%, #2a2f3c ${pct.pct}%)` : s.color,
                opacity: s.state === 'todo' ? 0.9 : 1,
              }} />
            ))}
          </span>
          {pct && (
            <span data-live-pct title={stepSourceNote(d, pt) ?? undefined} style={{ display: 'flex', gap: 6, alignItems: 'baseline', fontSize: 11, color: MUTED }}>
              <LiveOdometer value={pct.pct} color={stageColor} />
              <span>{pt ? 'desta etapa' : 'of this stage'} · {pt ? 'passo' : 'step'} {pct.step} {pt ? 'de' : 'of'} {pct.of}: <span style={{ color: 'var(--text-secondary)' }}>{pct.label}</span></span>
            </span>
          )}
          <span data-live-time title={time.title} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 10.5, color: MUTED, flexWrap: 'wrap' }}>
            <span style={{ color: stageColor === MUTED ? MUTED : undefined }}>{time.inStage}{time.stageNo ? ` (${time.stageNo})` : ''}</span>
            <span>{time.total}</span>
          </span>
        </>
      )}
      {queue?.staged && <span data-live-staged style={{ fontSize: 11, color: 'var(--text-secondary)', overflowWrap: 'anywhere', lineHeight: 1.3 }}>{queue.staged}</span>}
      {queue?.wait && <span data-live-queue-wait data-queue-kind={d.queue?.hold?.kind ?? (d.queue?.approved ? 'approved' : 'asking')} style={{ display: 'flex', gap: 5, alignItems: 'flex-start', fontSize: 11.5, color: 'var(--anthropic-orange-light)', lineHeight: 1.3, overflowWrap: 'anywhere' }}><CalendarClock size={12} aria-hidden style={{ flexShrink: 0, marginTop: 1 }} /><span>{queue.wait}</span></span>}
      {queue?.slot && <span data-live-queue-slot title={queue.slotRaw ?? undefined} style={{ fontSize: 10.5, color: queue.slotOk === false ? 'var(--accent-yellow, #e5b341)' : MUTED, overflowWrap: 'anywhere' }}>{queue.slot}</span>}
      {queued && <span data-live-time title={time.title} style={{ fontSize: 10.5, color: MUTED }}>{time.inStage}</span>}

      {boxes && !queued && (
        <span data-live-etas style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 5 }}>
          {boxes.map((b, i) => (
            // The publication box is ORANGE in the approved preview (the time everything is leading to); the next-stage box stays neutral.
            <span key={i} title={b.title} data-live-eta={i === 0 ? 'next' : 'publish'} data-tone={b.tone} style={{ background: i === 1 ? 'var(--anthropic-orange-dim)' : 'var(--bg-elevated, rgba(255,255,255,.04))', borderRadius: 6, padding: '4px 7px', minWidth: 0 }}>
              <small style={{ display: 'block', fontSize: 9.5, color: MUTED, lineHeight: 1.25 }}>{b.label}</small>
              <b style={{ fontSize: b.tone === 'late' ? 10.5 : 12, fontWeight: 600, lineHeight: 1.25, color: b.tone === 'late' ? 'var(--accent-yellow, #e5b341)' : b.tone === 'none' ? MUTED : i === 1 ? 'var(--anthropic-orange-light)' : undefined, overflowWrap: 'anywhere' }}>{b.value}</b>
            </span>
          ))}
        </span>
      )}

      {ci && (
        <span data-live-cisig style={{ display: 'grid', gap: 3, fontSize: 11, color: MUTED, background: 'var(--bg-elevated, rgba(255,255,255,.04))', borderRadius: 6, padding: '5px 8px' }}>
          <span style={{ color: 'var(--text-secondary)' }}>{pt ? 'vai para Publicado sozinho quando chegar o sinal:' : 'moves to Published by itself when the signal arrives:'}</span>
          {ci.map(l => (
            <span key={l.key} data-ci-line={l.key} data-done={l.done ? '1' : '0'} style={{ display: 'flex', alignItems: 'center', gap: 5, color: l.done ? 'var(--accent-green, #26b573)' : MUTED }}>
              {l.done ? <Check size={11} aria-hidden /> : <CircleDashed size={11} aria-hidden />}{l.text}
            </span>
          ))}
        </span>
      )}
      {p.links && p.links.length > 0 && p.onOpenSession && (
        <span data-live-session-links style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 10px', paddingTop: 5, borderTop: '1px dashed var(--border)' }}>
          {p.links.map(l => (
            <span
              key={l.id} role="link" tabIndex={0} data-live-session-link={l.role}
              aria-label={`${openSessionWord(pt)} — ${SESSION_LINK_WORD[l.role][pt ? 'pt' : 'en']}`}
              onClick={e => { e.stopPropagation(); p.onOpenSession!(l.id) }}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); p.onOpenSession!(l.id) } }}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--anthropic-orange-light)', cursor: 'pointer', minHeight: mobile ? 32 : undefined, textDecoration: 'underline', textUnderlineOffset: 2 }}
            ><ExternalLink size={11} aria-hidden />{SESSION_LINK_WORD[l.role][pt ? 'pt' : 'en']} · {openSessionWord(pt)}</span>
          ))}
        </span>
      )}
      {last && !queued && (
        <span title={pt ? 'última ação' : 'last action'} data-live-last style={{ display: 'flex', gap: 5, alignItems: 'flex-start', paddingTop: 5, borderTop: '1px dashed var(--border)', fontSize: 11, color: MUTED, overflowWrap: 'anywhere' }}><CornerDownRight size={11} aria-hidden style={{ flexShrink: 0, marginTop: 2 }} /><span>{last}</span></span>
      )}
    </button>
  )
}

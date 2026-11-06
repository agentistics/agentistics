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
import type { FleetRow } from '../../lib/fleet'
import { accountDisplayName } from '../../lib/planLimits'
import { humanizeAction, shortTitle } from '@agentistics/core'
import { RoleChip } from '../sessions/RoleChip'
import { harnessColor, pill, surface } from './board'
import {
  cardPills, isQueued, queuePosition, STAGE_LABEL, type LiveCard, type RuntimeFacts,
} from './liveDeliveryModel'
import { blockLines, cardStateWord, etaBoxes, stageBar, timeRow, waitingReason } from './liveCardModel'

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
  /** Inside the Publicado accordion the card is the expanded body of a row: no outer border radius games. */
  embedded?: boolean
}

export function LiveCardView(p: LiveCardViewProps) {
  const { c, nowMs, pt, mobile } = p
  const d = c.d
  const queued = isQueued(c)
  const pos = queuePosition(p.cards, c)
  const agent = c.agents[0]
  const pills = cardPills(c, a => (a.accountId ? accountDisplayName(p.accountLabels, a.harness, a.accountId) : null), pt ? 'conta' : 'account', p.runtime, pt)
  const stateWord = cardStateWord(c, pt)
  const reason = waitingReason(c, p.fleet, pt)
  const bar = stageBar(d.stage, d.block?.originStage)
  const time = timeRow(c, nowMs, pt)
  const boxes = etaBoxes(d, pt)
  const block = d.block ? blockLines(d.block, d.stageSinceMs, nowMs, pt) : null
  const titleOf = (id: string) => p.fleet.find(r => r.id === id)?.title
  const last = d.lastAction ? humanizeAction(d.lastAction.text, pt ? 'pt' : 'en', titleOf) : null
  const ctx = [d.subtaskId ? d.taskTitle : null, p.leaderName ? `${pt ? 'líder' : 'leader'} ${p.leaderName}` : null].filter(Boolean).join(' · ')
  const stageColor = STAGE_LABEL[d.stage].color

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
      <span title={d.title} data-live-title style={{ fontWeight: 650, fontSize: 12, lineHeight: 1.3, overflowWrap: 'anywhere' }}>{shortTitle(d.title)}</span>
      {ctx && <span style={{ fontSize: 11, color: MUTED, overflowWrap: 'anywhere', lineHeight: 1.3 }}>{ctx}</span>}

      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 11.5, minWidth: 0 }}>
        <span data-live-role={p.role}><RoleChip role={p.role} pt={pt} /></span>
        <span aria-hidden style={{ width: 7, height: 7, borderRadius: '50%', background: queued ? MUTED : STATE_COLOR[c.liveState], flexShrink: 0 }} />
        <b data-live-state style={{ fontWeight: 600 }}>{stateWord}{agent && c.agents.length > 1 ? ` · ${c.agents.length}` : ''}</b>
        {queued && <span data-live-queued style={{ color: MUTED, letterSpacing: '.04em', fontSize: 10.5 }}>{pt ? 'NA FILA' : 'QUEUED'}{pos ? ` · ${pos}${pt ? 'º' : pos === 1 ? 'st' : pos === 2 ? 'nd' : pos === 3 ? 'rd' : 'th'}` : ''}</span>}
      </span>
      {reason && <span data-live-reason style={{ fontSize: 11.5, color: 'var(--accent-yellow, #e5b341)', lineHeight: 1.3, overflowWrap: 'anywhere' }}>⏳ {reason}</span>}

      {block && (
        <span data-live-block style={{ display: 'grid', gap: 1, fontSize: 11.5, padding: '5px 7px', borderRadius: 6, background: 'rgba(229,72,77,.10)', border: '1px solid rgba(229,72,77,.35)' }}>
          <b style={{ fontWeight: 600, color: 'var(--accent-red, #ff5f5f)', overflowWrap: 'anywhere' }}>{block.reason}</b>
          <span>{block.unlocker}{block.since ? ` · ${block.since}` : ''}</span>
          {block.origin && <span style={{ color: MUTED }}>{block.origin}</span>}
        </span>
      )}
      {d.blockedReason && !block && <span style={{ fontSize: 11, color: 'var(--accent-red, #ff5f5f)', overflowWrap: 'anywhere' }}>{d.blockedReason}</span>}

      {(pills.runtime || pills.account) && (
        <span style={{ display: 'flex', flexWrap: 'wrap', gap: 4, minWidth: 0 }}>
          {pills.runtime && <span data-live-pill="runtime" style={{ ...pill(harnessColor(agent?.harness ?? d.harnesses[0] ?? '')), maxWidth: '100%', overflowWrap: 'anywhere', whiteSpace: 'normal' }}>{pills.runtime}</span>}
          {pills.account && <span data-live-pill="account" style={{ ...pill(), maxWidth: '100%', overflowWrap: 'anywhere', whiteSpace: 'normal' }}>{pills.account}</span>}
        </span>
      )}

      {!queued && (
        <>
          <span aria-hidden data-live-bar style={{ display: 'flex', gap: 3, marginTop: 3 }}>
            {bar.map(s => <i key={s.stage} data-seg={s.state} style={{ flex: 1, height: 5, borderRadius: 3, background: s.color, opacity: s.state === 'todo' ? 0.9 : 1 }} />)}
          </span>
          <span data-live-time title={time.title} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 10.5, color: MUTED, flexWrap: 'wrap' }}>
            <span style={{ color: stageColor === MUTED ? MUTED : undefined }}>{time.inStage}{time.stageNo ? ` (${time.stageNo})` : ''}</span>
            <span>{time.total}</span>
          </span>
        </>
      )}
      {queued && <span data-live-time title={time.title} style={{ fontSize: 10.5, color: MUTED }}>{time.inStage}</span>}

      {boxes && !queued && (
        <span data-live-etas style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 5 }}>
          {boxes.map((b, i) => (
            <span key={i} title={b.title} data-live-eta={i === 0 ? 'next' : 'publish'} data-tone={b.tone} style={{ background: 'var(--bg-elevated, rgba(255,255,255,.04))', borderRadius: 6, padding: '4px 7px', minWidth: 0 }}>
              <small style={{ display: 'block', fontSize: 9.5, color: MUTED, lineHeight: 1.25 }}>{b.label}</small>
              <b style={{ fontSize: b.tone === 'late' ? 10.5 : 12, fontWeight: 600, lineHeight: 1.25, color: b.tone === 'late' ? 'var(--accent-yellow, #e5b341)' : b.tone === 'none' ? MUTED : undefined, overflowWrap: 'anywhere' }}>{b.value}</b>
            </span>
          ))}
        </span>
      )}

      {last && !queued && (
        <span title={pt ? 'última ação' : 'last action'} data-live-last style={{ paddingTop: 5, borderTop: '1px dashed var(--border)', fontSize: 11, color: MUTED, overflowWrap: 'anywhere' }}>↳ {last}</span>
      )}
    </button>
  )
}

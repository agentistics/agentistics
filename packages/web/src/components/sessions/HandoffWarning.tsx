import { useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { ArrowRightLeft, Crown, X } from 'lucide-react'
import { fmtCost, type HandoffLevel, type HandoffPanel } from '@agentistics/core'
import { useEscapeOwner } from '../../lib/overlayStack'
import { handoffPanelActions as actions, useHandoffPanel } from '../../lib/handoffPanel'
import { ConfirmModal } from '../../pages/settings/primitives'
import { LEADER_METER_TONE, leaderMeterState, leaderMeterStateLabel } from '../../lib/leaderMeter'
import type { SessionChatProps } from './SessionChat'
import './handoffWarning.css'

/** One palette for the meter, its popover and the composer band — the leader meter's states. */
const tones: Record<HandoffLevel, string> = { normal: LEADER_METER_TONE.normal, near: LEADER_METER_TONE.attention, due: LEADER_METER_TONE.critical, overdue: LEADER_METER_TONE.critical }
export function handoffLevelLabel(level: HandoffLevel, pt: boolean): string {
  return ({ normal: pt ? 'Longe do corte' : 'Below the cut', near: pt ? 'Chegando perto do ponto de passar' : 'Approaching the handoff point', due: pt ? 'Hora de passar' : 'Time to hand off', overdue: pt ? 'Passou do ponto' : 'Past the handoff point' })[level]
}
const tokens = (v: number | null, pt: boolean) => v === null ? '—' : `${Math.round(v / 1000).toLocaleString(pt ? 'pt-BR' : 'en-US')}${pt ? ' mil' : 'k'}`
const money = (v: number | null) => v === null ? '—' : fmtCost(v)
const percent = (v: number | null, pt: boolean) => {
  if (v === null) return '—'
  if (v > 0 && v < 0.1) return pt ? '<0,1%' : '<0.1%'
  return `+${v.toLocaleString(pt ? 'pt-BR' : 'en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`
}

export function HandoffQuotaCell({ value, label, pt }: { value: number | null; label: string; pt: boolean }) {
  return <span role="cell" data-label={label}>{percent(value, pt)}</span>
}

/** Explain unavailable estimates once for the entire comparison. */
export function HandoffQuotaNote({ panel: p, pt }: { panel: Pick<HandoffPanel, 'quotaUnavailableReason' | 'projections'>; pt: boolean }) {
  const missing = p.projections.some(r => r.fiveHourPct === null || r.weekPct === null)
  const explanation = !missing
    ? (pt ? 'Quota estimada pelo consumo medido da conta.' : 'Quota estimated from measured account consumption.')
    : p.quotaUnavailableReason === 'account-unknown'
      ? (pt ? 'Não foi possível identificar a conta desta sessão.' : 'The account for this session could not be identified.')
      : p.quotaUnavailableReason === 'no-meter'
        ? (pt ? 'Não há limites de uso disponíveis para esta conta.' : 'No usage limits are available for this account.')
        : p.quotaUnavailableReason === 'missing-window'
          ? (pt ? 'A conta não informa uma das janelas de uso.' : 'The account does not report one of the usage windows.')
          : p.projections.some(r => r.costUSD === null)
            ? (pt ? 'Faltam dados de contexto ou preço para estimar o consumo.' : 'Context or pricing data is missing to estimate consumption.')
            : (pt ? 'Ainda não há consumo com preço e horário suficientes para estimar as janelas sem dados.' : 'There is not enough timestamped, priced usage yet to estimate the unavailable windows.')
  return <small>{pt ? 'Percentual da janela de contexto. Ajuste em Configurações › Sessões.' : 'Percentage of the context window. Adjust in Settings › Sessions.'} {explanation}</small>
}

/** The header's leader indicator itself (option B): crown in a filled circle, then the context
 *  figure, both in the state's colour. Presentational so every state can be rendered in a test. */
export function LeaderMeterButton({ panel: p, pt, buttonRef, onClick }: { panel: Pick<HandoffPanel, 'level' | 'contextTokens' | 'cutTokens'>; pt: boolean; buttonRef?: RefObject<HTMLButtonElement | null>; onClick?: () => void }) {
  const face = leaderMeterState(p.level, p.contextTokens)
  const stateLabel = face === 'none' ? leaderMeterStateLabel(face, pt) : handoffLevelLabel(p.level, pt)
  const role = pt ? 'Líder' : 'Leader'
  return <button ref={buttonRef} type="button" className="handoff-meter" data-state={face} style={{ '--handoff-tone': LEADER_METER_TONE[face] } as CSSProperties}
    aria-label={`${role} · ${p.contextTokens === null ? stateLabel : `${tokens(p.contextTokens, pt)} ${pt ? 'de' : 'of'} ${tokens(p.cutTokens, pt)} · ${stateLabel}`}`}
    title={`${role} · ${stateLabel}`} onClick={onClick}>
    <span className="handoff-meter-crown" aria-hidden="true"><Crown size={14} strokeWidth={2.25} /></span>
    <span className="handoff-meter-value">{tokens(p.contextTokens, pt)}</span>
  </button>
}

export function HandoffMeter({ id, pt, act }: { id: string; pt: boolean; act: SessionChatProps['act'] }) {
  const state = useHandoffPanel(id)
  const p = state.panel
  const anchor = useRef<HTMLButtonElement>(null)
  const [position, setPosition] = useState({ top: 0, left: 0 })
  const closePopover = () => actions.acknowledge(id)
  useEscapeOwner(state.popover, closePopover)
  useEffect(() => {
    if (!state.popover) return
    const place = () => { const r = anchor.current?.getBoundingClientRect(); if (r) setPosition({ top: r.bottom + 8, left: Math.max(12, Math.min(r.right - 340, window.innerWidth - 352)) }) }
    place(); window.addEventListener('resize', place); window.addEventListener('scroll', closePopover, true)
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', closePopover, true) }
  }, [id, state.popover])
  if (!p) return null
  const collapsed = state.collapsed && (p.level === 'due' || p.level === 'overdue') && p.config.warnings[p.level]
  return <>
    <LeaderMeterButton panel={p} pt={pt} buttonRef={anchor} onClick={() => collapsed ? actions.expand(id) : actions.open(id)} />
    {state.popover && createPortal(<div className="handoff-popover" role="status" style={{ top: position.top, left: position.left, '--handoff-tone': tones[p.level] } as CSSProperties}>
      <strong>{handoffLevelLabel(p.level, pt)}</strong>
      <p>{tokens(p.contextTokens, pt)} {pt ? 'de' : 'of'} {tokens(p.cutTokens, pt)}. {pt ? 'Próxima resposta: ' : 'Next reply: '}{money(p.nextReplyUSD)}; {pt ? 'numa nova sessão: ' : 'in a new session: '}{money(p.successorReplyUSD)}.</p>
      <div className="handoff-actions"><button type="button" className="primary" onClick={() => actions.open(id)}>{pt ? 'Ver as contas' : 'See the numbers'}</button><button type="button" onClick={closePopover}>Ok</button></div>
    </div>, document.body)}
    <HandoffLivePanel panel={p} open={state.open} pt={pt} act={act} />
  </>
}

export function HandoffBand({ id, pt }: { id: string; pt: boolean }) {
  const state = useHandoffPanel(id)
  const p = state.panel
  const enabled = !!p && (p.level === 'due' || p.level === 'overdue') && p.config.warnings[p.level]
  const visible = enabled && !state.collapsed
  const ratio = p && p.nextReplyUSD !== null && p.successorReplyUSD !== null && p.successorReplyUSD > 0 ? p.nextReplyUSD / p.successorReplyUSD : null
  return <div className={`handoff-band-wrap ${visible ? 'visible' : ''}`} inert={!visible} aria-hidden={!visible}>
    <div className="handoff-band-clip"><div className="handoff-band" style={{ '--handoff-tone': tones[p?.level ?? 'due'] } as CSSProperties}>
      <div className="handoff-band-copy"><strong>{p?.level === 'overdue' ? (pt ? 'Passou do ponto de passar o líder' : 'Leader handoff is overdue') : (pt ? 'Hora de passar o líder' : 'Time to hand off the leader')}</strong><span>{tokens(p?.contextTokens ?? null, pt)} {pt ? 'de' : 'of'} {tokens(p?.cutTokens ?? null, pt)}{ratio !== null ? (pt ? ` · cada resposta custa ~${ratio.toLocaleString(pt ? 'pt-BR' : 'en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}× uma sessão nova` : ` · each reply costs ~${ratio.toLocaleString(pt ? 'pt-BR' : 'en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}× a new session`) : ''}</span></div>
      <div className="handoff-actions"><button type="button" onClick={() => actions.open(id)}>{pt ? 'Ver as contas' : 'See the numbers'}</button><button type="button" className="primary" onClick={() => { actions.open(id); window.dispatchEvent(new CustomEvent('agentistics:handoff-confirm', { detail: id })) }}>{pt ? 'Passar agora' : 'Hand off now'}</button><button type="button" className="icon" aria-label={pt ? 'Lembrar depois' : 'Remind me later'} onClick={() => actions.dismiss(id, true)}><X size={16} /></button></div>
    </div></div>
  </div>
}

export function HandoffLivePanel({ panel: p, open, pt, act }: { panel: HandoffPanel; open: boolean; pt: boolean; act: SessionChatProps['act'] }) {
  const [confirm, setConfirm] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [extraDraft, setExtraDraft] = useState(String(p.config.extraPercent))
  useEffect(() => { setExtraDraft(String(p.config.extraPercent)) }, [p.config.extraPercent])
  function simulate() {
    const value = Number(extraDraft)
    if (extraDraft.trim() !== '' && Number.isInteger(value) && value >= 0 && value <= 100) actions.simulate(p.sessionId, value)
    else setExtraDraft(String(p.config.extraPercent))
  }
  useEffect(() => {
    const ask = (e: Event) => { if ((e as CustomEvent).detail === p.sessionId) setConfirm(true) }
    window.addEventListener('agentistics:handoff-confirm', ask)
    return () => window.removeEventListener('agentistics:handoff-confirm', ask)
  }, [p.sessionId])
  useEffect(() => { if (!open) { setConfirm(false); setError('') } }, [open])
  async function handoff() {
    setSending(true); setError('')
    try {
      // Ask the existing leader to prepare its durable brief and use the verified --handoff flow.
      const out = await act({ id: p.sessionId, action: 'prompt', text: pt
        ? 'Quero passar a liderança agora. Prepare o arquivo durável de passagem com estado, decisões, sessões ativas e fila. Use o fluxo existente agentop session --handoff (handoff:true), preserve a configuração e diga ao sucessor para fechar este líder depois de assumir.'
        : 'Hand off leadership now. Prepare the durable handoff file with state, decisions, active sessions and queue. Use the existing agentop session --handoff (handoff:true) flow, preserve the configuration, and tell the successor to close this leader after taking over.' })
      if (!out.ok) { setError(out.message); return }
      actions.close(p.sessionId)
    } catch { setError(pt ? 'Não foi possível solicitar a passagem. Tente novamente.' : 'Could not request the handoff. Try again.') }
    finally { setSending(false) }
  }
  const labels = { continue: pt ? 'Continuar aqui' : 'Continue here', extra: pt ? `Continuar +${p.config.extraPercent}%` : `Continue +${p.config.extraPercent}%`, handoff: pt ? 'Passar para uma sessão nova' : 'Hand off to a new session' }
  return createPortal(<ConfirmModal focusPanel className="handoff-dialog" open={open} maxWidth={640} mobileSheet tone="default" icon={<ArrowRightLeft size={18} />}
    title={pt ? 'Continuar ou passar o líder?' : 'Continue or hand off the leader?'}
    message={handoffLevelLabel(p.level, pt)} confirmLabel="" cancelLabel="" onConfirm={() => {}} onCancel={() => actions.close(p.sessionId)}
    footer={<div className="handoff-panel-footer">{confirm && <p role="status">{pt ? 'O líder vai preparar a passagem e abrir o sucessor pelo fluxo existente. O trabalho em andamento será registrado no arquivo de passagem.' : 'The leader will prepare the handoff and open the successor through the existing flow. Work in flight will be recorded in the handoff file.'}</p>}<div className="handoff-actions"><button type="button" onClick={() => actions.close(p.sessionId)} disabled={sending}>{pt ? 'Fechar' : 'Close'}</button><button type="button" onClick={() => actions.dismiss(p.sessionId, true)} disabled={sending}>{pt ? 'Lembrar em +50 mil' : 'Remind me in +50k'}</button><button type="button" className="primary" disabled={sending} onClick={() => confirm ? void handoff() : setConfirm(true)}>{sending ? (pt ? 'Solicitando…' : 'Requesting…') : confirm ? (pt ? 'Confirmar passagem' : 'Confirm handoff') : (pt ? 'Passar agora' : 'Hand off now')}</button></div></div>}>
    <div className="handoff-live-panel">
      <div className="handoff-summary">
        <div><small>{pt ? 'Conversa agora' : 'Context now'}</small><strong>{tokens(p.contextTokens, pt)}</strong><small>{pt ? 'corte: ' : 'cut: '}{tokens(p.cutTokens, pt)}</small></div>
        <div><small>{pt ? 'Já gasto nesta sessão' : 'Spent this session'}</small><strong>{money(p.spentUSD)}</strong><small>{p.replies ?? '—'} {pt ? 'respostas' : 'replies'}</small></div>
        <div><small>{pt ? 'Próxima resposta' : 'Next reply'}</small><strong>{money(p.nextReplyUSD)}</strong><small>{pt ? 'numa nova: ' : 'in a new session: '}{money(p.successorReplyUSD)}</small></div>
      </div>
      <p>{pt ? `Próximas ${p.projectionReplies} respostas · estimativas em US$` : `Next ${p.projectionReplies} replies · estimates in USD`}</p>
      <div className="handoff-projection-table" role="table" aria-label={pt ? 'Comparação de custo' : 'Cost comparison'}>
        <div className="handoff-projection-heading" role="row"><span role="columnheader">{pt ? 'Caminho' : 'Path'}</span><span role="columnheader">{pt ? 'Custo' : 'Cost'}</span><span role="columnheader">{pt ? 'Janela 5 h' : '5 h window'}</span><span role="columnheader">{pt ? 'Semana' : 'Week'}</span></div>
        {p.projections.map(r => <div className={`handoff-projection ${r.kind}`} role="row" key={r.kind}>
          <span role="cell"><strong>{labels[r.kind]}</strong><small>{r.kind === 'handoff' ? (pt ? 'inclui o custo da passagem' : 'includes handoff overhead') : tokens(r.contextTokens, pt)}</small></span>
          <span role="cell" data-label={pt ? 'Custo' : 'Cost'}>{money(r.costUSD)}</span><HandoffQuotaCell value={r.fiveHourPct} label={pt ? 'Janela 5 h' : '5 h window'} pt={pt} /><HandoffQuotaCell value={r.weekPct} label={pt ? 'Semana' : 'Week'} pt={pt} />
        </div>)}
      </div>
      <label className="handoff-simulation"><span>{pt ? 'Simular continuar mais' : 'Simulate continuing another'}</span><input type="number" min={0} max={100} step={1} value={extraDraft} onChange={e => setExtraDraft(e.target.value)} onBlur={simulate} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); simulate() } }} /> %</label>
      <HandoffQuotaNote panel={p} pt={pt} />
      <div className="handoff-receives"><strong>{pt ? 'O que a sessão nova recebe' : 'What the new session receives'}</strong>
        <p>{pt ? 'Um arquivo durável com o estado do trabalho, suas decisões, sessões ativas e a fila. O líder prepara esse resumo antes de abrir o sucessor.' : 'A durable file with work state, your decisions, active sessions and the queue. The leader prepares this summary before starting the successor.'}</p>
        {p.handoffPath && <p>{p.handoffPath}</p>}
        <p>{pt ? 'Contexto base estimado: ' : 'Estimated base context: '}{tokens(p.successorBaseTokens, pt)} · {pt ? 'Custo da passagem: ' : 'Handoff overhead: '}{money(p.handoffOverheadUSD)} · {pt ? 'Equilíbrio em respostas: ' : 'Break-even replies: '}{p.breakEvenReplies ?? '—'}</p>
        <p>{pt ? 'Trabalho em andamento: ' : 'Work in flight: '}{p.workInFlight.length ? p.workInFlight.map(w => w === 'main-response' ? (pt ? 'resposta principal' : 'main response') : w === 'background-work' ? (pt ? 'trabalho em segundo plano' : 'background work') : w).join(', ') : (pt ? 'nenhum detectado' : 'none detected')}.</p>
      </div>
      {error && <p role="alert">{error}</p>}
    </div>
  </ConfirmModal>, document.body)
}

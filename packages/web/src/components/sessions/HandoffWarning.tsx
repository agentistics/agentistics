import { useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { Link } from 'react-router-dom'
import { sessionPath } from '../../lib/sessionRoute'
import { ProgressBar } from '../tasks/TaskProgressBar'
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
export function handoffPanelLabel(panel: Pick<HandoffPanel, 'level' | 'contextTokens'>, pt: boolean): string {
  return panel.contextTokens === null ? leaderMeterStateLabel('none', pt) : handoffLevelLabel(panel.level, pt)
}

export function HandoffNoReading({ pt }: { pt: boolean }) {
  return <p>{pt ? 'Ainda não há uma leitura de contexto para esta sessão. As estimativas aparecerão quando a leitura estiver disponível.' : 'There is no context reading for this session yet. Estimates will appear when a reading is available.'}</p>
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
  const stateLabel = handoffPanelLabel(p, pt)
  const role = pt ? 'Líder' : 'Leader'
  return <button ref={buttonRef} type="button" className="handoff-meter" data-state={face} style={{ '--handoff-tone': LEADER_METER_TONE[face] } as CSSProperties}
    aria-label={`${role} · ${p.contextTokens === null ? stateLabel : `${tokens(p.contextTokens, pt)} ${pt ? 'de' : 'of'} ${tokens(p.cutTokens, pt)} · ${stateLabel}`}`}
    title={`${role} · ${stateLabel}`} onClick={onClick}>
    <span className="handoff-meter-crown" aria-hidden="true"><Crown size={14} strokeWidth={2.25} /></span>
    <span className="handoff-meter-value">{tokens(p.contextTokens, pt)}</span>
  </button>
}

export function HandoffPopoverCopy({ panel: p, pt }: { panel: Pick<HandoffPanel, 'contextTokens' | 'nextReplyUSD' | 'successorReplyUSD'>; pt: boolean }) {
  return p.contextTokens === null ? <HandoffNoReading pt={pt} /> : <p>{pt ? 'Próxima resposta: ' : 'Next reply: '}{money(p.nextReplyUSD)}; {pt ? 'numa nova sessão: ' : 'in a new session: '}{money(p.successorReplyUSD)}.</p>
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
  // The crown always answers: it opens the panel (and brings a dismissed band back). It used to only expand a dismissed
  // band, and while a hand-off was in progress it set `open` on a panel gated off — the owner's click did nothing.
  return <>
    <LeaderMeterButton panel={p} pt={pt} buttonRef={anchor} onClick={() => { if (state.collapsed) actions.expand(id); actions.open(id) }} />
    {state.popover && !p.handoff && createPortal(<div className="handoff-popover" role="status" style={{ top: position.top, left: position.left, '--handoff-tone': LEADER_METER_TONE[leaderMeterState(p.level, p.contextTokens)] } as CSSProperties}>
      <strong>{handoffPanelLabel(p, pt)}</strong>
      <HandoffPopoverCopy panel={p} pt={pt} />
      <div className="handoff-actions"><button type="button" className="primary" onClick={() => actions.open(id)}>{pt ? 'Ver as contas' : 'See the numbers'}</button><button type="button" onClick={closePopover}>Ok</button></div>
    </div>, document.body)}
    <HandoffLivePanel panel={p} open={state.open} pt={pt} act={act} />
  </>
}

export function handoffStageLabel(stage: NonNullable<HandoffPanel['handoff']>['stage'], pt: boolean): string {
  return ({ preparing: pt ? 'Preparando a passagem' : 'Preparing the handoff', 'successor-open': pt ? 'Sucessor aberto' : 'Successor opened', 'taken-over': pt ? 'Sucessor assumiu' : 'Successor took over', closing: pt ? 'Encerrando este líder' : 'Closing this leader' })[stage]
}

/** The hand-off in progress, inside the panel: the same stage words and bar as the composer band, and the successor. */
function HandoffProgress({ handoff: h, pt }: { handoff: NonNullable<HandoffPanel['handoff']>; pt: boolean }) {
  // The panel's title already says "hand-off in progress"; the block leads with the stage.
  return <div className="handoff-progress-status" role="status">
    <strong>{handoffStageLabel(h.stage, pt)}</strong>
    <div className="handoff-progress-track"><ProgressBar percent={h.progress * 100} label={pt ? 'Passagem em andamento' : 'Handoff in progress'} height={5} color="var(--anthropic-orange)" /></div>
    {h.stage === 'preparing' && <p>{pt ? 'O líder recebeu o pedido e ainda não abriu o sucessor. Se ele não reagiu, peça de novo.' : 'The leader got the request and has not opened the successor yet. If it did not react, ask again.'}</p>}
    {h.successorId && <Link className="handoff-successor" to={sessionPath(h.successorId)}>{pt ? 'Ver sucessor' : 'View successor'}</Link>}
  </div>
}

export function HandoffBand({ id, pt }: { id: string; pt: boolean }) {
  const state = useHandoffPanel(id)
  const p = state.panel
  return <HandoffBandView id={id} panel={p} collapsed={state.collapsed} pt={pt} />
}

export function HandoffBandView({ id, panel: p, collapsed = false, pt }: { id: string; panel: HandoffPanel | null; collapsed?: boolean; pt: boolean }) {
  const enabled = !!p && p.contextTokens !== null && (p.level === 'due' || p.level === 'overdue') && p.config.warnings[p.level]
  const visible = !!p?.handoff || (enabled && !collapsed)
  const ratio = p && p.nextReplyUSD !== null && p.successorReplyUSD !== null && p.successorReplyUSD > 0 ? p.nextReplyUSD / p.successorReplyUSD : null
  return <div className={`handoff-band-wrap ${visible ? 'visible' : ''}`} inert={!visible} aria-hidden={!visible}>
    <div className="handoff-band-clip"><div className="handoff-band" style={{ '--handoff-tone': p?.handoff ? 'var(--anthropic-orange)' : tones[p?.level ?? 'due'] } as CSSProperties}>
      {p?.handoff ? <>
        <div className="handoff-band-copy" role="status">
          <strong>{pt ? 'Passagem em andamento' : 'Handoff in progress'}</strong>
          <span>{handoffStageLabel(p.handoff.stage, pt)}</span>
          <div className="handoff-progress-track"><ProgressBar percent={p.handoff.progress * 100} label={pt ? 'Passagem em andamento' : 'Handoff in progress'} height={5} color="var(--handoff-tone)" /></div>
        </div>
        {p.handoff.successorId && <Link className="handoff-successor" to={sessionPath(p.handoff.successorId)}>{pt ? 'Ver sucessor' : 'View successor'}</Link>}
      </> : <><div className="handoff-band-copy"><strong>{p?.level === 'overdue' ? (pt ? 'Passou do ponto de passar o líder' : 'Leader handoff is overdue') : (pt ? 'Hora de passar o líder' : 'Time to hand off the leader')}</strong><span>{tokens(p?.contextTokens ?? null, pt)} {pt ? 'de' : 'of'} {tokens(p?.cutTokens ?? null, pt)}{ratio !== null ? (pt ? ` · cada resposta custa ~${ratio.toLocaleString(pt ? 'pt-BR' : 'en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}× uma sessão nova` : ` · each reply costs ~${ratio.toLocaleString(pt ? 'pt-BR' : 'en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}× a new session`) : ''}</span></div>
      <div className="handoff-actions"><button type="button" onClick={() => actions.open(id)}>{pt ? 'Ver as contas' : 'See the numbers'}</button><button type="button" className="primary" onClick={() => { actions.open(id); window.dispatchEvent(new CustomEvent('agentistics:handoff-confirm', { detail: id })) }}>{pt ? 'Passar agora' : 'Hand off now'}</button><button type="button" className="icon" aria-label={pt ? 'Lembrar depois' : 'Remind me later'} onClick={() => actions.dismiss(id, true)}><X size={16} /></button></div>
      </>}
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
  // The successor opened while the owner was confirming: there is nothing left to confirm.
  const canAsk = !p.handoff || p.handoff.stage === 'preparing'
  useEffect(() => { if (!canAsk) setConfirm(false) }, [canAsk])
  const running = !!p.handoff
  const noReading = p.contextTokens === null
  async function handoff() {
    setSending(true); setError('')
    try {
      // Ask the existing leader to prepare its durable brief and use the verified --handoff flow.
      const out = await act({ id: p.sessionId, action: 'prompt', handoff: true, text: pt
        ? 'Quero passar a liderança agora. Prepare o arquivo durável de passagem com estado, decisões, sessões ativas e fila. Use o fluxo existente agentop session --handoff (handoff:true), preserve a configuração e diga ao sucessor para fechar este líder depois de assumir.'
        : 'Hand off leadership now. Prepare the durable handoff file with state, decisions, active sessions and queue. Use the existing agentop session --handoff (handoff:true) flow, preserve the configuration, and tell the successor to close this leader after taking over.' })
      if (!out.ok) { setError(out.message); return }
      actions.requested(p.sessionId)
      actions.close(p.sessionId)
    } catch { setError(pt ? 'Não foi possível solicitar a passagem. Tente novamente.' : 'Could not request the handoff. Try again.') }
    finally { setSending(false) }
  }
  const labels = { continue: pt ? 'Continuar aqui' : 'Continue here', extra: pt ? `Continuar +${p.config.extraPercent}%` : `Continue +${p.config.extraPercent}%`, handoff: pt ? 'Passar para uma sessão nova' : 'Hand off to a new session' }
  return createPortal(<ConfirmModal focusPanel className="handoff-dialog" open={open} maxWidth={640} mobileSheet tone="default" icon={<ArrowRightLeft size={18} />}
    title={running ? (pt ? 'Passagem em andamento' : 'Handoff in progress') : (pt ? 'Continuar ou passar o líder?' : 'Continue or hand off the leader?')}
    // The state line is the context level; during a hand-off the stage block says it, and with no reading the paragraph below does.
    message={running || noReading ? '' : handoffPanelLabel(p, pt)} confirmLabel="" cancelLabel="" onConfirm={() => {}} onCancel={() => actions.close(p.sessionId)}
    footer={<div className="handoff-panel-footer">{confirm && canAsk && <p role="status">{pt ? 'O líder vai preparar a passagem e abrir o sucessor pelo fluxo existente. O trabalho em andamento será registrado no arquivo de passagem.' : 'The leader will prepare the handoff and open the successor through the existing flow. Work in flight will be recorded in the handoff file.'}</p>}
      {/* "Hand off now" is the one action that needs the context reading (its cost numbers); asking again and the reminder do not. */}
      {noReading && !running && <p role="note">{pt ? '“Passar agora” fica disponível quando houver uma leitura de contexto.' : '“Hand off now” becomes available once there is a context reading.'}</p>}
      <div className="handoff-actions"><button type="button" onClick={() => actions.close(p.sessionId)} disabled={sending}>{pt ? 'Fechar' : 'Close'}</button>
        {!running && <button type="button" onClick={() => actions.dismiss(p.sessionId, true)} disabled={sending}>{pt ? 'Lembrar em +50 mil' : 'Remind me in +50k'}</button>}
        {canAsk && <button type="button" className="primary" disabled={sending || (!running && noReading)} onClick={() => confirm ? void handoff() : setConfirm(true)}>{sending ? (pt ? 'Solicitando…' : 'Requesting…') : confirm ? (pt ? 'Confirmar passagem' : 'Confirm handoff') : running ? (pt ? 'Pedir de novo' : 'Ask again') : (pt ? 'Passar agora' : 'Hand off now')}</button>}</div></div>}>
    <div className="handoff-live-panel">
      {p.handoff && <HandoffProgress handoff={p.handoff} pt={pt} />}
      {running ? null : noReading ? <HandoffNoReading pt={pt} /> : <>
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
      </>}
      {error && <p role="alert">{error}</p>}
    </div>
  </ConfirmModal>, document.body)
}

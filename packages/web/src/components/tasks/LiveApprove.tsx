/**
 * LiveApprove — the owner's answer to a HUMAN GATE, on the Live card (autonomous mode OFF only: with it ON the gate is
 * skipped and recorded, so no card ever carries this). It sits BESIDE the card, never inside it — the card is itself a
 * button. The question was already asked once (one bell per gate and revision); this is where it is answered, with the
 * same door `agentop flow approve` and the MCP `approve` action use: `POST /api/deliveries/<subtask>` with no session
 * proof (the server reads that as the owner).
 */
import { useState } from 'react'
import { approveSentence, type ApproveState } from './liveApproveModel'

export interface LiveApproveProps { subtaskId: string; phase: string; pt: boolean; mobile: boolean }

export function LiveApprove({ subtaskId, phase, pt, mobile }: LiveApproveProps) {
  const [state, setState] = useState<ApproveState>({ kind: 'idle' })
  const send = async (decision: 'approve' | 'reject') => {
    setState({ kind: 'sending', decision })
    try {
      const res = await fetch(`/api/deliveries/${encodeURIComponent(subtaskId)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'approve', phase, decision }),
      })
      const body = await res.json().catch(() => ({})) as { sentence?: string; error?: string }
      setState(res.ok ? { kind: 'done', decision } : { kind: 'failed', sentence: body.sentence ?? body.error ?? String(res.status) })
    } catch (e) {
      setState({ kind: 'failed', sentence: e instanceof Error ? e.message : String(e) })
    }
  }
  const busy = state.kind === 'sending' || state.kind === 'done'
  const btn = (primary: boolean): React.CSSProperties => ({
    minHeight: mobile ? 44 : 28, padding: '0 12px', borderRadius: 6, cursor: busy ? 'default' : 'pointer', fontFamily: 'inherit', fontSize: 12,
    border: `1px solid ${primary ? 'var(--anthropic-orange)' : 'var(--border)'}`,
    background: primary ? 'var(--anthropic-orange-dim)' : 'var(--bg-elevated)', color: 'var(--text-primary)', opacity: busy ? 0.6 : 1,
  })
  return (
    <div data-live-approve={subtaskId} role="group" aria-label={approveSentence(phase, pt)} style={{ display: 'grid', gap: 6, padding: '7px 9px', borderRadius: 8, border: '1px solid var(--anthropic-orange)', background: 'var(--bg-elevated)', minWidth: 0 }}>
      <span style={{ fontSize: 11.5, overflowWrap: 'anywhere', lineHeight: 1.3 }}>{approveSentence(phase, pt)}</span>
      {state.kind === 'done' ? (
        <span data-live-approve-done style={{ fontSize: 11.5, color: 'var(--accent-green, #26b573)' }}>{state.decision === 'approve' ? (pt ? 'aprovado — o líder segue sozinho' : 'approved — the leader carries on') : (pt ? 'reprovado — volta por ajuste' : 'rejected — goes back through ajuste')}</span>
      ) : (
        <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button type="button" data-live-approve-yes disabled={busy} onClick={() => void send('approve')} style={btn(true)}>{pt ? 'Aprovar' : 'Approve'}</button>
          <button type="button" data-live-approve-no disabled={busy} onClick={() => void send('reject')} style={btn(false)}>{pt ? 'Reprovar' : 'Reject'}</button>
        </span>
      )}
      {state.kind === 'failed' && <span data-live-approve-error style={{ fontSize: 11, color: 'var(--accent-red, #ff5f5f)', overflowWrap: 'anywhere' }}>{state.sentence}</span>}
    </div>
  )
}

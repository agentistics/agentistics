/**
 * RelayedComposer — the message field under ANOTHER machine's session screen, on a central.
 *
 * `RelayedScreen` promised it ("answering the session is what the message field is for") and the
 * pane drew none, so the one thing a central can do to a remote session — send it a line — sat in
 * the ⋯ menu where nobody found it. Whether the field exists is `relayedComposerState`, i.e. the
 * verb the MACHINE resolved for this row; the send is the same `act` every other verb uses, which on
 * a central already posts to `/api/team/machine-fleet/act`, and the machine re-checks its consent,
 * its verb allowlist and its sharing rules on arrival. Nothing decided here is trusted there.
 *
 * Every send is AUDITED exactly as `SessionActions` audits one (`recordPromptSend`): `prompt` is the
 * one verb that types free text into a session, and that holds whichever surface typed it.
 */
import { useState } from 'react'
import { Send } from 'lucide-react'
import type { FleetActionId, FleetRow } from '../../lib/fleet'
import { relayedComposerState } from '../../lib/relayedComposer'
import { operatorId, recordPromptSend, resolveAuthor } from '../../lib/promptAudit'
import { useIsMobile } from '../../hooks/useIsMobile'

type ActFn = (req: { id: string; action: FleetActionId; text?: string }) =>
  Promise<{ ok: boolean; message: string; id?: string }>

export function RelayedComposer({ row, act, lang, authorName }: {
  row: FleetRow | undefined
  act: ActFn
  lang: 'pt' | 'en'
  authorName?: string
}) {
  const pt = lang === 'pt'
  const isMobile = useIsMobile()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const state = relayedComposerState(row)

  if (!row || state.kind === 'absent') return null

  if (state.kind === 'refused') {
    return (
      <p style={{ margin: '0 16px 16px', fontSize: 12, color: 'var(--text-tertiary)' }}>
        {state.reason ?? (pt ? 'Esta sessão não aceita mensagem agora.' : 'This session cannot take a message right now.')}
      </p>
    )
  }

  async function send() {
    const line = text.trim()
    if (!line || busy || !row) return
    setBusy(true)
    setMsg(null)
    const out = await act({ id: row.id, action: 'prompt', text: line })
    recordPromptSend({
      author: resolveAuthor({ accountName: authorName, operatorId: operatorId() }),
      sessionId: row.id,
      sessionTitle: row.title,
      harness: row.harness,
      text: line,
      ok: out.ok,
      message: out.message,
    })
    setBusy(false)
    setMsg({ ok: out.ok, text: out.message })
    if (out.ok) setText('')
  }

  const disabled = busy || !text.trim()
  return (
    <form
      onSubmit={e => { e.preventDefault(); void send() }}
      style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '0 16px 16px', flexShrink: 0, minWidth: 0 }}
    >
      {/* WHICH machine's session this writes to — a central shows several machines, and a line sent
          to the wrong one is the accident this names at the moment of typing. */}
      <span style={{ fontSize: 11, color: 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {pt ? 'Enviando para ' : 'Sending to '}
        <strong style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>{row.title}</strong>
        {pt ? ' — entra como se fosse digitado no terminal da máquina.' : ' — arrives as if typed into the machine\'s terminal.'}
      </span>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', minWidth: 0 }}>
        <textarea
          value={text}
          onChange={e => setText(e.target.value)}
          // A phone has no shift key: there Enter breaks the line and the button sends (the rule
          // `TtyChat` and the session composer already follow).
          onKeyDown={e => { if (!isMobile && e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() } }}
          rows={2}
          placeholder={pt ? 'Responder à sessão…' : 'Reply to the session…'}
          aria-label={pt ? 'Mensagem para a sessão' : 'Message to the session'}
          // No inline font-size: `index.css` keeps inputs >= 16px on mobile so iOS does not zoom.
          style={{
            flex: 1, minWidth: 0, resize: 'vertical', padding: '8px 10px', borderRadius: 10,
            border: '1px solid var(--border)', background: 'var(--bg-elevated)',
            color: 'var(--text-primary)', fontFamily: 'inherit', outline: 'none',
          }}
        />
        <button
          type="submit"
          disabled={disabled}
          aria-label={pt ? 'Enviar' : 'Send'}
          // The finger's 44px is PROJECTED by `.ag-tap` (index.css), never painted — see
          // `touchTarget.lint.test.ts`.
          className="ag-tap"
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
            minHeight: 36, minWidth: 36, padding: '0 12px', borderRadius: 10,
            border: '1px solid var(--anthropic-orange)',
            background: disabled ? 'var(--bg-elevated)' : 'var(--anthropic-orange-dim)',
            color: disabled ? 'var(--text-tertiary)' : 'var(--anthropic-orange)',
            cursor: disabled ? 'default' : 'pointer', fontFamily: 'inherit', fontWeight: 600, fontSize: 13,
          }}
        >
          <Send size={14} />{!isMobile && (busy ? (pt ? 'Enviando…' : 'Sending…') : (pt ? 'Enviar' : 'Send'))}
        </button>
      </div>
      {msg && (
        <span role="status" style={{ fontSize: 12, color: msg.ok ? 'var(--text-secondary)' : 'var(--accent-red)' }}>
          {msg.text}
        </span>
      )}
    </form>
  )
}

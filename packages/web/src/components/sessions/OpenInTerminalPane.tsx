/**
 * OpenInTerminalPane.tsx — what the `cli` pane of a STRUCTURED session shows instead of an empty
 * screen (F2.0b follow-up). A row running over its harness's protocol has no terminal of its own;
 * this is the door to the SAME conversation as a TUI. The verb and its refusals are the server's
 * (`terminal` action, offered only on a structured row); the same shell serves every harness.
 */
import { useState } from 'react'
import { Watermark } from './Studio'
import { terminalNeedsConfirm, terminalToast } from '../../lib/terminalSwitch'
import { pushNotification } from '../../lib/notifications'

export interface OpenInTerminal {
  /** The row's state — a mid-turn row asks before its reply is ended. */
  state: string
  /** Performs the `terminal` action; the message is the server's, already localized. */
  open: () => Promise<{ ok: boolean; message: string }>
}

const TXT = {
  en: {
    title: 'Open in terminal',
    body: 'This session runs over its harness’s protocol, so it has no terminal screen of its own. Opening it in a terminal resumes this same conversation as a TUI.',
    confirm: 'This session is in the middle of a reply. Opening it in a terminal ends that reply and resumes the same conversation.',
    busy: 'Opening…', cancel: 'Cancel', go: 'Open in terminal',
  },
  pt: {
    title: 'Abrir no terminal',
    body: 'Esta sessão roda pelo protocolo do harness e não tem uma tela de terminal própria. Abrir no terminal retoma esta mesma conversa como TUI.',
    confirm: 'Esta sessão está no meio de uma resposta. Abrir no terminal encerra essa resposta e retoma a mesma conversa.',
    busy: 'Abrindo…', cancel: 'Cancelar', go: 'Abrir no terminal',
  },
} as const

export function OpenInTerminalPane({
  lang, theme, isMobile, openInTerminal,
}: { lang: 'pt' | 'en'; theme: 'dark' | 'light'; isMobile: boolean; openInTerminal: OpenInTerminal }) {
  const t = TXT[lang]
  const [busy, setBusy] = useState(false)
  const [asking, setAsking] = useState(false)
  async function run() {
    setBusy(true)
    const out = await openInTerminal.open()
    setBusy(false); setAsking(false)
    pushNotification(terminalToast(out, lang))
  }
  const btn = {
    minHeight: isMobile ? 44 : 32, padding: '0 14px', borderRadius: 7, fontFamily: 'inherit', fontSize: 12, fontWeight: 650,
    cursor: busy ? 'default' : 'pointer',
  } as const
  return (
    <div style={{
      position: 'relative', flex: 1, minHeight: 0, borderRadius: 8, overflow: 'hidden',
      border: '1px solid var(--border-subtle)', background: theme === 'light' ? '#ffffff' : '#0e1116',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
    }}>
      <Watermark />
      <div style={{
        position: 'relative', zIndex: 1, display: 'flex', flexDirection: 'column',
        alignItems: 'center', textAlign: 'center', gap: 12, maxWidth: 380,
      }}>
        <div style={{ fontSize: 13, fontWeight: 650, color: 'var(--text-primary)' }}>{t.title}</div>
        <div style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--text-secondary)' }}>{asking ? t.confirm : t.body}</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
          {asking && (
            <button type="button" disabled={busy} onClick={() => setAsking(false)} style={{
              ...btn, border: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)', color: 'var(--text-secondary)',
            }}>{t.cancel}</button>
          )}
          <button
            type="button" disabled={busy}
            onClick={() => { if (!asking && terminalNeedsConfirm(openInTerminal.state)) setAsking(true); else void run() }}
            style={{ ...btn, border: '1px solid var(--anthropic-orange)', background: 'var(--anthropic-orange)', color: '#fff' }}
          >{busy ? t.busy : t.go}</button>
        </div>
      </div>
    </div>
  )
}

import { useEffect, useRef, useState } from 'react'
import { Copy, ExternalLink } from 'lucide-react'
import { ConfirmModal, FieldInput } from '../pages/settings/primitives'
import { cancelMcpSignIn, pasteMcpSignIn, pollMcpSignIn, startMcpSignIn } from '../hooks/useMcpAuth'
import { mcpAuthDone, type McpAuthView } from '../lib/mcpAuth'
import { pushNotification } from '../lib/notifications'
import { McpReopenSessions } from './McpReopenSessions'

export interface McpAuthTarget {
  harness: string
  harnessLabel: string
  server: string
}

const POLL_MS = 1500

/**
 * "Authenticate this MCP server" — the ONE flow, opened from Settings → MCP servers.
 *
 * It explains what will happen, asks, then runs the harness's own OAuth login and shows its link.
 * Same shape as `HarnessInstallDialog` (the app's `ConfirmModal`, nothing starts before the
 * confirm button). The link is a real link, so it works from a phone or a remote browser; Claude
 * Code's flow can also take the address the browser ended on pasted back.
 */
export function McpAuthDialog({ target, pt, onClose, onChanged }: {
  target: McpAuthTarget | null
  pt: boolean
  onClose: () => void
  /** The server's state may have changed: reload the list. */
  onChanged: () => void
}) {
  const lang = pt ? 'pt' : 'en'
  const [flow, setFlow] = useState<McpAuthView | null>(null)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState('')
  const [redirect, setRedirect] = useState('')
  const [sending, setSending] = useState(false)
  const [copied, setCopied] = useState(false)
  const name = target?.harnessLabel ?? ''
  const flowId = flow?.id ?? null
  const phase = flow?.phase ?? null
  const targetKey = target ? `${target.harness}|${target.server}` : null
  const lastKey = useRef<string | null>(null)

  if (targetKey !== lastKey.current) {
    lastKey.current = targetKey
    if (flow) setFlow(null)
    if (error) setError('')
    if (redirect) setRedirect('')
    if (starting) setStarting(false)
  }

  // Poll while the sign-in is in flight; the server reads the pane and asks the harness.
  useEffect(() => {
    if (!flowId || phase === null || mcpAuthDone({ phase })) return
    const t = setInterval(() => {
      void pollMcpSignIn(flowId, lang).then(next => {
        if (!next) return
        setFlow(next)
        if (mcpAuthDone(next)) onChanged()
        if (next.phase === 'connected') announce(next)
      })
    }, POLL_MS)
    return () => clearInterval(t)
  }, [flowId, phase, lang, onChanged])

  // The bell keeps a line of it, so the result is findable after the dialog is closed.
  const announce = (v: McpAuthView) => pushNotification({
    type: 'success',
    title: pt ? 'MCP autenticado' : 'MCP signed in',
    message: pt ? `${v.server} está autenticado no ${name}.` : `${v.server} is signed in on ${name}.`,
  })

  const begin = async () => {
    if (!target) return
    setStarting(true); setError(''); setFlow(null); setRedirect('')
    const out = await startMcpSignIn(target.harness, target.server, lang)
    setStarting(false)
    if (out.ok) setFlow(out.flow)
    else setError(out.message || (pt ? 'Não consegui iniciar a autenticação.' : 'Could not start the sign-in.'))
  }

  const close = () => {
    if (flow && !mcpAuthDone(flow)) void cancelMcpSignIn(flow.id, lang).then(() => onChanged())
    onClose()
  }

  const sendRedirect = async () => {
    if (!flow) return
    setSending(true); setError('')
    const out = await pasteMcpSignIn(flow.id, redirect, lang)
    setSending(false)
    if (out.ok) { setFlow(out.flow); setRedirect(''); if (mcpAuthDone(out.flow)) onChanged(); if (out.flow.phase === 'connected') announce(out.flow) }
    else setError(out.message)
  }

  const server = target?.server ?? ''
  const waiting = starting || phase === 'starting' || phase === 'finishing'

  const title = !target ? ''
    : phase === 'connected' ? (pt ? 'Tudo certo' : 'All set')
      : `${pt ? 'Autenticar' : 'Authenticate'} ${server}?`

  const message = (() => {
    if (!target) return ''
    if (phase === 'connected') {
      return flow?.verified === false
        ? (pt ? `A autenticação de ${server} terminou, mas ${name} não informa se o servidor está respondendo, então não consegui conferir.` : `The sign-in for ${server} finished, but ${name} does not report whether the server is answering, so I could not double-check.`)
        : (pt ? `${server} está autenticado no ${name}.` : `${server} is signed in on ${name}.`)
    }
    if (phase === 'failed' || phase === 'cancelled') return flow?.message ?? error
    if (error && !flow) return error
    if (phase === 'awaiting') {
      return pt
        ? 'Abra a página, entre na conta e autorize o acesso. Esta janela atualiza sozinha.'
        : 'Open the page, sign in and allow access. This window updates by itself.'
    }
    if (waiting) return pt ? 'Iniciando a autenticação…' : 'Starting the sign-in…'
    return pt
      ? `Vamos iniciar a autenticação própria do ${name} para ${server}. Você vai receber um link para abrir no navegador. Nenhuma configuração é alterada.`
      : `We will start ${name}’s own sign-in for ${server}. You will get a link to open in your browser. No configuration is changed.`
  })()

  const confirmLabel =
    phase === 'connected' ? (pt ? 'Fechar' : 'Close')
      : phase === 'awaiting' ? (pt ? 'Abrir página de login' : 'Open sign-in page')
        : waiting ? (pt ? 'Aguarde…' : 'Please wait…')
          : phase === 'failed' || phase === 'cancelled' || (error && !flow) ? (pt ? 'Tentar de novo' : 'Try again')
            : (pt ? 'Autenticar' : 'Authenticate')

  const openUrl = () => { if (flow?.url) window.open(flow.url, '_blank', 'noopener,noreferrer') }
  const copyUrl = async () => {
    if (!flow?.url) return
    try { await navigator.clipboard.writeText(flow.url); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch { /* the link is selectable */ }
  }

  return (
    <ConfirmModal
      open={target !== null}
      title={title}
      message={message}
      confirmLabel={confirmLabel}
      cancelLabel={phase === 'connected' ? (pt ? 'Fechar' : 'Close') : (pt ? 'Cancelar' : 'Cancel')}
      focusCancel={phase === null}
      tone="default"
      onCancel={close}
      onConfirm={() => {
        if (waiting) return
        if (phase === 'connected') { onClose(); return }
        if (phase === 'awaiting') { openUrl(); return }
        void begin()
      }}
    >
      {phase === 'awaiting' && flow?.url && (
        <div data-testid="mcp-auth-link" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <a href={flow.url} target="_blank" rel="noopener noreferrer"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12.5, fontWeight: 600, color: 'var(--anthropic-orange)', textDecoration: 'none', minHeight: 44 }}>
              <ExternalLink size={13} />{pt ? 'Abrir no navegador' : 'Open in the browser'}
            </a>
            <button type="button" onClick={() => void copyUrl()}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 5, minHeight: 44, padding: '0 10px', borderRadius: 7, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', fontFamily: 'inherit', fontSize: 12, cursor: 'pointer' }}>
              <Copy size={12} />{copied ? (pt ? 'Copiado' : 'Copied') : (pt ? 'Copiar link' : 'Copy link')}
            </button>
          </div>
          {flow.pasteBack ? (
            <div>
              <FieldInput
                label={pt ? 'Entrou de outro aparelho?' : 'Signing in from another device?'}
                sub={pt ? 'Se a página final não abrir, copie o endereço dela (começa com http://localhost) e cole aqui.' : 'If the final page does not load, copy its address (it starts with http://localhost) and paste it here.'}
                value={redirect} onChange={setRedirect} mono spellCheck={false} autoComplete="off" placeholder="http://localhost:…/callback?code=…"
              />
              <button type="button" disabled={sending || redirect.trim() === ''} onClick={() => void sendRedirect()}
                style={{ minHeight: 44, padding: '0 14px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text-primary)', fontFamily: 'inherit', fontSize: 12.5, fontWeight: 600, cursor: sending || redirect.trim() === '' ? 'not-allowed' : 'pointer', opacity: sending || redirect.trim() === '' ? 0.5 : 1 }}>
                {pt ? 'Enviar endereço' : 'Send address'}
              </button>
            </div>
          ) : (
            <div style={{ fontSize: 11.5, lineHeight: 1.5, color: 'var(--text-tertiary)' }}>
              {pt
                ? `${name} termina sozinho quando o navegador abre o link neste computador. Se você está em outro aparelho, a conclusão precisa ser feita neste computador.`
                : `${name} finishes by itself once the browser opens the link on this computer. If you are on another device, the sign-in has to be completed on this computer.`}
            </div>
          )}
          {error && <div role="alert" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{error}</div>}
        </div>
      )}
      {phase === 'connected' && target && (
        <McpReopenSessions harness={target.harness} harnessLabel={target.harnessLabel} pt={pt} />
      )}
    </ConfirmModal>
  )
}

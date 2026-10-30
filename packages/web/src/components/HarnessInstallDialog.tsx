import { useRef, useState } from 'react'
import { ConfirmModal } from '../pages/settings/primitives'
import { fetchHarnessStatus, installHarness } from '../hooks/useChatHarnesses'
import { useOpenAccountSignIn } from '../lib/accountSignIn'

export interface HarnessInstallTarget {
  id: string
  label: string
  /** Already installed → this is an update. */
  installed?: boolean
}

type Phase = 'confirm' | 'running' | 'failed' | 'needs-node' | 'success' | 'login-offer'

const VENDOR: Record<string, string> = { claude: 'Anthropic', codex: 'OpenAI', gemini: 'Google', copilot: 'GitHub' }
const MAX_LINES = 8

/**
 * The ONE install flow: Settings → Harnesses and the new-session picker both open this. It explains
 * what will run, asks, then streams the official installer's progress inside the app's own
 * ConfirmModal. Nothing starts before the confirm button.
 */
export function HarnessInstallDialog({ target, pt, onClose, onDone, onSignIn }: {
  target: HarnessInstallTarget | null
  pt: boolean
  onClose: () => void
  onDone: (version?: string) => void
  /** "Sign in now" was pressed: the app is going to Usage → Accounts' sign-in dialog; the host closes what it holds. */
  onSignIn?: () => void
}) {
  const [phase, setPhase] = useState<Phase>('confirm')
  const [lines, setLines] = useState<string[]>([])
  const [failure, setFailure] = useState('')
  const [loginError, setLoginError] = useState('')
  const signingIn = false
  const openSignIn = useOpenAccountSignIn()
  const withNode = useRef(false)

  // The state is per-open: a target change starts a clean confirm.
  const lastId = useRef<string | null>(null)
  if ((target?.id ?? null) !== lastId.current) {
    lastId.current = target?.id ?? null
    if (phase !== 'confirm') setPhase('confirm')
    if (lines.length) setLines([])
    if (failure) setFailure('')
    if (loginError) setLoginError('')
    withNode.current = false
  }

  const update = target?.installed === true
  const name = target?.label ?? ''
  const vendor = target ? VENDOR[target.id] : undefined

  const run = async () => {
    if (!target) return
    setPhase('running'); setLines([]); setFailure('')  // clears the previous failure
    const result = await installHarness(target.id, update, line => setLines(prev => [...prev, line].slice(-MAX_LINES)), { installNode: withNode.current, lang: pt ? 'pt' : 'en' })
    if (result.ok) {
      onDone(result.version)
      // Re-read the status: only an installed assistant that still has no login gets the offer.
      const status = await fetchHarnessStatus(target.id)
      setLoginError('')
      setPhase(status && status.installed && !status.authReady ? 'login-offer' : 'success')
      return
    }
    if (result.code === 'node-required') { setPhase('needs-node'); return }
    setFailure(
      result.code === 'unsupported-platform' ? (pt ? 'Por enquanto a instalação automática funciona no Linux e no macOS.' : 'Automatic install currently works on Linux and macOS.')
        : result.code === 'busy' ? (pt ? 'Outra instalação está em andamento. Espere terminar e tente de novo.' : 'Another install is running. Wait for it to finish and try again.')
        : (result.error ?? (pt ? 'Não consegui terminar. Verifique a internet e tente de novo.' : 'It did not finish. Check your internet connection and try again.')),
    )
    setPhase('failed')
  }

  // The one in-app login is the "Add account" dialog (paste the code); a session at the assistant's
  // own login could end at once with nothing on screen (CONTAS.LOGIN r4), so it is never opened.
  const signIn = () => {
    if (!target) return
    openSignIn(target.id); onSignIn?.(); onClose()
  }

  const message = (() => {
    if (!target) return ''
    if (phase === 'needs-node') {
      return pt
        ? `${name} precisa do Node.js, que não está neste computador. Posso instalar o Node.js só para o seu usuário (instalador oficial de nodejs.org, sem sudo) e depois ${name}.`
        : `${name} needs Node.js, which is not on this computer. I can install Node.js for your user only (official installer from nodejs.org, no sudo), then ${name}.`
    }
    if (phase === 'failed') return failure
    if (phase === 'login-offer') {
      const base = pt ? `${name} foi ${update ? 'atualizado' : 'instalado'}, mas ainda falta entrar na sua conta. Quer entrar agora?` : `${name} was ${update ? 'updated' : 'installed'}, but you still need to sign in. Sign in now?`
      return loginError ? `${base}\n${loginError}` : base
    }
    if (phase === 'success') return pt ? `Pronto! O ${name} está disponível para usar.` : `Done! ${name} is ready to use.`
    if (phase === 'running') return pt ? `${update ? 'Atualizando' : 'Instalando'} ${name}… pode levar alguns minutos.` : `${update ? 'Updating' : 'Installing'} ${name}… this can take a few minutes.`
    const from = vendor ? (pt ? `, da ${vendor},` : ` from ${vendor}`) : ''
    return pt
      ? `Vamos ${update ? 'atualizar' : 'instalar'} o ${name}${from} pelo instalador oficial, como seu usuário. Nenhum sudo será usado.`
      : `We will ${update ? 'update' : 'install'} ${name}${from} using its official installer, as your user. sudo will not be used.`
  })()

  const confirmLabel =
    phase === 'login-offer' ? (signingIn ? (pt ? 'Abrindo…' : 'Opening…') : (pt ? 'Entrar agora' : 'Sign in now'))
    : phase === 'success' ? (pt ? 'Fechar' : 'Close')
    : phase === 'running' ? (pt ? 'Instalando…' : 'Installing…')
    : phase === 'failed' ? (pt ? 'Tentar de novo' : 'Try again')
    : phase === 'needs-node' ? (pt ? 'Instalar Node.js e continuar' : 'Install Node.js and continue')
    : update ? (pt ? 'Atualizar' : 'Update') : (pt ? 'Instalar' : 'Install')

  return (
    <ConfirmModal
      open={target !== null}
      title={target ? phase === 'success' || phase === 'login-offer' ? (pt ? 'Tudo certo' : 'All set') : `${update ? (pt ? 'Atualizar' : 'Update') : (pt ? 'Instalar' : 'Install')} ${name}?` : ''}
      message={message}
      confirmLabel={confirmLabel}
      cancelLabel={phase === 'login-offer' ? (pt ? 'Depois' : 'Later') : (pt ? 'Cancelar' : 'Cancel')}
      focusCancel
      tone="default"
      onCancel={() => { if (phase !== 'running') onClose() }}
      onConfirm={() => {
        if (phase === 'running') return
        if (phase === 'login-offer') { void signIn(); return }
        if (phase === 'success') { onClose(); return }
        if (phase === 'needs-node') withNode.current = true
        void run()
      }}
    >
      {/* The installer's progress is for while it RUNS (or to explain a failure): kept after a success it left
          "Checking the version…" standing beside "Done" (QA F4). */}
      {lines.length > 0 && phase !== 'success' && phase !== 'login-offer' && (
        <div
          role="log" aria-live="polite" data-testid="harness-install-progress"
          style={{
            fontFamily: 'var(--font-mono, monospace)', fontSize: 11.5, lineHeight: 1.5, color: 'var(--text-secondary)',
            background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 7, padding: 8,
            maxHeight: 150, overflow: 'hidden', overflowWrap: 'anywhere',
          }}
        >
          {lines.map((l, i) => <div key={`${i}-${l}`}>{l}</div>)}
        </div>
      )}
    </ConfirmModal>
  )
}

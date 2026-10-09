import { useRef, useState } from 'react'
import { ConfirmModal } from '../pages/settings/primitives'
import { installHarness } from '../hooks/useChatHarnesses'

export interface HarnessInstallTarget {
  id: string
  label: string
  /** Already installed → this is an update. */
  installed?: boolean
}

type Phase = 'confirm' | 'running' | 'failed' | 'needs-node'

const VENDOR: Record<string, string> = { claude: 'Anthropic', codex: 'OpenAI', gemini: 'Google', copilot: 'GitHub' }
const MAX_LINES = 8

/**
 * The ONE install flow: Settings → Harnesses and the new-session picker both open this. It explains
 * what will run, asks, then streams the official installer's progress inside the app's own
 * ConfirmModal. Nothing starts before the confirm button.
 */
export function HarnessInstallDialog({ target, pt, onClose, onDone }: {
  target: HarnessInstallTarget | null
  pt: boolean
  onClose: () => void
  onDone: (version?: string) => void
}) {
  const [phase, setPhase] = useState<Phase>('confirm')
  const [lines, setLines] = useState<string[]>([])
  const [failure, setFailure] = useState('')
  const withNode = useRef(false)

  // The state is per-open: a target change starts a clean confirm.
  const lastId = useRef<string | null>(null)
  if ((target?.id ?? null) !== lastId.current) {
    lastId.current = target?.id ?? null
    if (phase !== 'confirm') setPhase('confirm')
    if (lines.length) setLines([])
    if (failure) setFailure('')
    withNode.current = false
  }

  const update = target?.installed === true
  const name = target?.label ?? ''
  const vendor = target ? VENDOR[target.id] : undefined

  const run = async () => {
    if (!target) return
    setPhase('running'); setLines([]); setFailure('')
    const result = await installHarness(target.id, update, line => setLines(prev => [...prev, line].slice(-MAX_LINES)), { installNode: withNode.current })
    if (result.ok) { onDone(result.version); onClose(); return }
    if (result.code === 'node-required') { setPhase('needs-node'); return }
    setFailure(
      result.code === 'unsupported-platform' ? (pt ? 'Por enquanto a instalação automática funciona no Linux e no macOS.' : 'Automatic install currently works on Linux and macOS.')
        : result.code === 'busy' ? (pt ? 'Outra instalação está em andamento. Espere terminar e tente de novo.' : 'Another install is running. Wait for it to finish and try again.')
        : (pt ? 'Não consegui terminar. Verifique a internet e tente de novo.' : 'It did not finish. Check your internet connection and try again.'),
    )
    setPhase('failed')
  }

  const message = (() => {
    if (!target) return ''
    if (phase === 'needs-node') {
      return pt
        ? `${name} precisa do Node.js, que não está neste computador. Posso instalar o Node.js só para o seu usuário (instalador oficial de nodejs.org, sem sudo) e depois ${name}.`
        : `${name} needs Node.js, which is not on this computer. I can install Node.js for your user only (official installer from nodejs.org, no sudo), then ${name}.`
    }
    if (phase === 'failed') return failure
    if (phase === 'running') return pt ? `${update ? 'Atualizando' : 'Instalando'} ${name}… pode levar alguns minutos.` : `${update ? 'Updating' : 'Installing'} ${name}… this can take a few minutes.`
    const from = vendor ? (pt ? `, da ${vendor},` : ` from ${vendor}`) : ''
    return pt
      ? `Vamos ${update ? 'atualizar' : 'instalar'} o ${name}${from} pelo instalador oficial, como seu usuário. Nenhum sudo será usado.`
      : `We will ${update ? 'update' : 'install'} ${name}${from} using its official installer, as your user. sudo will not be used.`
  })()

  const confirmLabel =
    phase === 'running' ? (pt ? 'Instalando…' : 'Installing…')
    : phase === 'failed' ? (pt ? 'Tentar de novo' : 'Try again')
    : phase === 'needs-node' ? (pt ? 'Instalar Node.js e continuar' : 'Install Node.js and continue')
    : update ? (pt ? 'Atualizar' : 'Update') : (pt ? 'Instalar' : 'Install')

  return (
    <ConfirmModal
      open={target !== null}
      title={target ? `${update ? (pt ? 'Atualizar' : 'Update') : (pt ? 'Instalar' : 'Install')} ${name}?` : ''}
      message={message}
      confirmLabel={confirmLabel}
      cancelLabel={pt ? 'Cancelar' : 'Cancel'}
      focusCancel
      onCancel={() => { if (phase !== 'running') onClose() }}
      onConfirm={() => {
        if (phase === 'running') return
        if (phase === 'needs-node') withNode.current = true
        void run()
      }}
    >
      {lines.length > 0 && (
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

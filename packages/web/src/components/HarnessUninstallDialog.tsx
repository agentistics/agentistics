import { useEffect, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { Button, ConfirmModal } from '../pages/settings/primitives'
import { fetchUninstallPreview, uninstallHarness, type UninstallPreview } from '../hooks/useChatHarnesses'
import { HarnessJobLog } from './HarnessInstallDialog'

export interface HarnessUninstallTarget {
  id: string
  label: string
}

/** The "Uninstall" action beside "Install"/"Update": the app's secondary button, in the danger colour. */
export function UninstallButton({ pt, label, named = false, onClick }: {
  pt: boolean
  label: string
  /** Say the assistant's name on the button, where no row names it already. */
  named?: boolean
  onClick: () => void
}) {
  const verb = pt ? 'Desinstalar' : 'Uninstall'
  return (
    <Button
      data-harness-uninstall
      aria-label={`${verb} ${label}`}
      onClick={onClick}
      style={{ width: 'auto', flexShrink: 0, color: 'var(--accent-red)', background: 'var(--bg-card)' }}
    >
      {named ? `${verb} ${label}` : verb}
    </Button>
  )
}

type Phase = 'checking' | 'confirm' | 'blocked' | 'running' | 'failed' | 'success'

const MAX_LINES = 8

/**
 * The ONE uninstall flow. It first asks the server what would be removed (or why it will not), then
 * confirms, then streams the removal. Nothing is removed before the confirm button.
 */
export function HarnessUninstallDialog({ target, pt, onClose, onDone }: {
  target: HarnessUninstallTarget | null
  pt: boolean
  onClose: () => void
  onDone: () => void
}) {
  const [phase, setPhase] = useState<Phase>('checking')
  const [view, setView] = useState<UninstallPreview | null>(null)
  const [lines, setLines] = useState<string[]>([])
  const [said, setSaid] = useState('')
  const id = target?.id ?? null
  const lang = pt ? 'pt' : 'en'

  useEffect(() => {
    setPhase('checking'); setView(null); setLines([]); setSaid('')
    if (!id) return
    let cancelled = false
    void fetchUninstallPreview(id, lang).then(preview => {
      if (cancelled) return
      setView(preview)
      if (preview?.reason === 'ok') { setPhase('confirm'); return }
      setSaid(preview?.message ?? (pt ? 'Não consegui verificar a desinstalação. Tente de novo.' : 'I could not check the uninstall. Try again.'))
      setPhase('blocked')
    })
    return () => { cancelled = true }
  }, [id, lang, pt])

  const name = target?.label ?? ''

  const run = async () => {
    if (!target) return
    setPhase('running'); setLines([]); setSaid('')
    const result = await uninstallHarness(target.id, line => setLines(prev => [...prev, line].slice(-MAX_LINES)), { lang })
    if (result.ok) {
      setSaid(result.message ?? '')
      setPhase('success')
      onDone()
      return
    }
    setSaid(result.error ?? (pt ? 'Não consegui desinstalar.' : 'Could not uninstall it.'))
    setPhase('failed')
  }

  const message =
    phase === 'checking' ? (pt ? 'Verificando o que seria removido…' : 'Checking what would be removed…')
    : phase === 'confirm' ? (pt
      ? `Vamos remover o programa ${name} deste computador. Suas sessões, configurações e login são mantidos.`
      : `We will remove the ${name} program from this computer. Your sessions, settings and sign-in are kept.`)
    : phase === 'running' ? (pt ? `Desinstalando ${name}…` : `Uninstalling ${name}…`)
    : phase === 'success' ? (said || (pt ? `${name} foi removido. Suas sessões e configurações continuam aqui.` : `${name} was removed. Your sessions and settings are still here.`))
    : said

  const closing = phase === 'success' || phase === 'blocked'
  const confirmLabel =
    closing ? (pt ? 'Fechar' : 'Close')
    : phase === 'running' ? (pt ? 'Desinstalando…' : 'Uninstalling…')
    : phase === 'failed' ? (pt ? 'Tentar de novo' : 'Try again')
    : (pt ? 'Desinstalar' : 'Uninstall')

  return (
    <ConfirmModal
      open={target !== null}
      title={target ? phase === 'success' ? (pt ? 'Desinstalado' : 'Uninstalled') : `${pt ? 'Desinstalar' : 'Uninstall'} ${name}?` : ''}
      message={message}
      confirmLabel={confirmLabel}
      cancelLabel={pt ? 'Cancelar' : 'Cancel'}
      focusCancel
      tone={closing ? 'default' : 'danger'}
      icon={<Trash2 size={18} />}
      busy={phase === 'checking' || phase === 'running'}
      lockCancel={phase === 'running'}
      onCancel={onClose}
      onConfirm={() => { if (closing) { onClose(); return } void run() }}
    >
      {phase === 'confirm' && view && (
        <dl data-testid="harness-uninstall-plan" style={{ margin: 0, fontSize: 12, lineHeight: 1.55, color: 'var(--text-secondary)', overflowWrap: 'anywhere' }}>
          <dt style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{pt ? 'Será removido' : 'Removed'}</dt>
          {view.removes.map(path => <dd key={path} style={{ margin: 0, fontFamily: 'var(--font-mono, monospace)', fontSize: 11.5 }}>{path}</dd>)}
          <dt style={{ fontWeight: 700, color: 'var(--text-primary)', marginTop: 8 }}>{pt ? 'Será mantido' : 'Kept'}</dt>
          {view.keeps.map(path => <dd key={path} style={{ margin: 0, fontFamily: 'var(--font-mono, monospace)', fontSize: 11.5 }}>{path}</dd>)}
          <dd style={{ margin: 0 }}>{pt ? 'e o histórico de métricas no agentistics.' : 'and the metrics history in agentistics.'}</dd>
        </dl>
      )}
      {lines.length > 0 && phase !== 'success' && <HarnessJobLog lines={lines} testId="harness-uninstall-progress" />}
    </ConfirmModal>
  )
}

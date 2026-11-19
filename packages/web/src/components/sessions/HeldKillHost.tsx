import { ConfirmModal } from '../../pages/settings/primitives'
import { clearHeldKill, useHeldKill } from '../../lib/heldKill'

/** Asks the "End anyway?" question for a refusal whose row menu was unmounted (see `lib/heldKill.ts`). */
export function HeldKillHost({ lang, act, onEnded }: {
  lang: 'pt' | 'en'
  act: (req: { id: string; action: 'kill'; force: true }) => Promise<{ ok: boolean; message?: string }>
  onEnded?: () => void
}) {
  const held = useHeldKill()
  if (held === null) return null
  const pt = lang === 'pt'
  return (
    <ConfirmModal
      open
      title={pt ? 'Encerrar mesmo assim?' : 'End anyway?'}
      message={held.message}
      confirmLabel={pt ? 'Encerrar mesmo assim' : 'End anyway'}
      cancelLabel={pt ? 'Cancelar' : 'Cancel'}
      focusCancel
      onConfirm={() => { const id = held.id; clearHeldKill(); void act({ id, action: 'kill', force: true }).then(r => { if (r.ok) onEnded?.() }) }}
      onCancel={clearHeldKill}
    />
  )
}

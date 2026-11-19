import { ConfirmModal } from '../../pages/settings/primitives'
import { useEffect } from 'react'
import { clearHeldKill, registerHeldKillHost, useHeldKill } from '../../lib/heldKill'

/** Asks the "End anyway?" question for a refusal whose row menu was unmounted (see `lib/heldKill.ts`). */
export function HeldKillHost({ lang, act, onEnded, stillValid }: {
  lang: 'pt' | 'en'
  act: (req: { id: string; action: 'kill'; force: true }) => Promise<{ ok: boolean; message?: string }>
  onEnded?: () => void
  /** Is the session still there and still running? A question about one that is not is dropped. */
  stillValid?: (id: string) => boolean
}) {
  const held = useHeldKill()
  useEffect(() => registerHeldKillHost(), [])
  const valid = held === null || stillValid === undefined || stillValid(held.id)
  useEffect(() => { if (!valid) clearHeldKill() }, [valid])
  if (held === null || !valid) return null
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

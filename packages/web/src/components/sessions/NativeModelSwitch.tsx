/**
 * NativeModelSwitch — H24 in the native chat: the session's model, and switching it for the NEXT runs
 * on the session's own provider (`POST /api/runtime/sessions/:id/model`). Disabled while a run is in
 * flight: the run keeps the model it started with. The list is the provider's own models; a typed id
 * is accepted too, as in the new-session dialog. A refusal is the engine's sentence.
 */
import { useState } from 'react'
import { ModelSelect } from './ModelSelect'
import { useNativeProviders } from '../../hooks/useNativeProviders'

export function NativeModelSwitch({ model, provider, running, lang, onSwitch }: {
  model: string
  provider: string
  running: boolean
  lang: 'pt' | 'en'
  onSwitch: (model: string) => Promise<string | null>
}) {
  const pt = lang === 'pt'
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { models } = useNativeProviders(open, provider, lang)
  const options = models.some(m => m.id === model) ? models : [{ id: model, label: model }, ...models]
  return (
    <div data-testid="native-model" style={{ maxWidth: 820, width: 'calc(100% - 28px)', margin: '0 auto 4px', display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5, color: 'var(--text-tertiary)', minWidth: 0, opacity: running ? 0.6 : 1 }}
      title={running ? (pt ? 'Uma run está em andamento — troque o modelo quando ela terminar.' : 'A run is in progress — switch the model when it ends.') : undefined}>
      <span>{pt ? 'Modelo' : 'Model'}</span>
      <div style={{ pointerEvents: running ? 'none' : 'auto', minWidth: 0 }} aria-disabled={running}>
        <ModelSelect
          lang={lang}
          open={open && !running}
          onOpenChange={o => setOpen(o && !running)}
          value={model}
          onChange={async id => {
            setOpen(false)
            if (!id || id === model) return
            setError(await onSwitch(id))
          }}
          options={options}
          unsetLabel={pt ? `Manter ${model}` : `Keep ${model}`}
          freeText
          ariaLabel={pt ? 'Trocar o modelo dos próximos turnos' : 'Switch the model for the next turns'}
        />
      </div>
      {error && <span role="alert" style={{ color: 'var(--accent-red)' }}>{error}</span>}
    </div>
  )
}

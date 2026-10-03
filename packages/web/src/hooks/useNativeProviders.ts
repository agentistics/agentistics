/**
 * useNativeProviders — for the native harness in the wizard (UI.2): the providers a native session
 * can run on (`GET /api/provider`, only those with a usable credential or keyless), and the models of
 * the one chosen (`GET /api/provider/:id/models`). Idle until `enabled`; a model list that cannot be
 * read is empty, and the picker still takes a typed id.
 */
import { useEffect, useState } from 'react'
import { configuredProviders, type ProviderChoice } from '../lib/nativeSession'

export interface NativeProviders {
  providers: ProviderChoice[] | null
  models: { id: string; label: string }[]
  modelsLoading: boolean
  /** Why there is no list, in words (the flag is off, no provider is configured). */
  unavailable?: string
}

export function useNativeProviders(enabled: boolean, provider: string, lang: 'pt' | 'en'): NativeProviders {
  const pt = lang === 'pt'
  const [providers, setProviders] = useState<ProviderChoice[] | null>(null)
  const [unavailable, setUnavailable] = useState<string | undefined>()
  const [models, setModels] = useState<{ id: string; label: string }[]>([])
  const [modelsLoading, setModelsLoading] = useState(false)

  useEffect(() => {
    if (!enabled) return
    let live = true
    fetch('/api/provider')
      .then(r => r.json())
      .then((b: { enabled?: boolean; sentence?: string; providers?: { id: string; label: string; state: string; keyless?: boolean }[] }) => {
        if (!live) return
        if (b.enabled === false || !b.providers) {
          setProviders([])
          setUnavailable(b.sentence ?? (pt ? 'O runtime nativo está desligado nesta máquina.' : 'The native runtime is off on this machine.'))
          return
        }
        const list = configuredProviders(b.providers)
        setProviders(list)
        setUnavailable(list.length === 0
          ? (pt ? 'Nenhum provedor configurado — configure um em Configurações → Provedores.' : 'No provider is configured — set one up in Settings → Providers.')
          : undefined)
      })
      .catch(() => { if (live) { setProviders([]); setUnavailable(pt ? 'Erro de rede ao ler os provedores.' : 'Network error reading the providers.') } })
    return () => { live = false }
  }, [enabled, pt])

  useEffect(() => {
    setModels([])
    if (!enabled || provider === '') return
    let live = true
    setModelsLoading(true)
    fetch(`/api/provider/${encodeURIComponent(provider)}/models`)
      .then(r => r.json())
      .then((b: { models?: { id: string }[] }) => {
        if (live) setModels((b.models ?? []).map(m => ({ id: m.id, label: m.id })))
      })
      .catch(() => { if (live) setModels([]) })
      .finally(() => { if (live) setModelsLoading(false) })
    return () => { live = false }
  }, [enabled, provider])

  return { providers, models, modelsLoading, ...(unavailable ? { unavailable } : {}) }
}

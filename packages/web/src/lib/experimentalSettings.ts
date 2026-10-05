/**
 * experimentalSettings.ts — PURE: what Settings → Experimental shows and asks. No fetch, no React;
 * `ExperimentalSettings.tsx` owns the I/O. The rule worth a module: a switch never writes on its own —
 * pressing it only ASKS (`requestSwitch`), and the write happens when the confirmation is accepted.
 */

export interface ExperimentalFeatureWire {
  id: string
  env: string
  on: boolean
  source: 'env' | 'preference' | 'default'
  overridden: boolean
  envValue?: string
  description: { en: string; pt: string }
  /** `false` when the feature is on by default: the preference does not decide it. */
  switchable: boolean
}

export interface ExperimentalReportWire { enabled: boolean; features: ExperimentalFeatureWire[] }

type Lang = 'pt' | 'en'

/** The feature's plain-language name — the first, and the one people came for, is the native harness. */
const NAMES: Record<string, { en: string; pt: string }> = {
  provider: { en: 'Native harness and model providers', pt: 'Harness nativo e provedores de modelo' },
  journal: { en: 'Event journal', pt: 'Journal de eventos' },
  projections: { en: 'Runtime projections', pt: 'Projeções de runtime' },
}

export function featureName(f: Pick<ExperimentalFeatureWire, 'id'>, lang: Lang): string {
  return (NAMES[f.id] ?? { en: f.id, pt: f.id })[lang]
}

/** What each feature is, for a person: no commands, no variables. Falls back to the server's own text. */
const BLURBS: Record<string, { en: string; pt: string }> = {
  provider: {
    en: 'Lets you start sessions with Agentistics’ own assistant (the native harness), using your own model-provider keys. Turning it on also opens Settings → Providers and Memory.',
    pt: 'Permite abrir sessões com o assistente do próprio Agentistics (o harness nativo), usando as suas chaves de provedores de modelo. Ao ligar, Configurações → Provedores e Memória também abrem.',
  },
  journal: {
    en: 'Keeps a durable local record of what happens in your sessions, so history survives and can be replayed.',
    pt: 'Guarda um registro local e durável do que acontece nas suas sessões, para o histórico sobreviver e poder ser reprocessado.',
  },
  projections: {
    en: 'Builds the native harness’s usage figures from that record. Always on; nothing to decide here.',
    pt: 'Monta os números de uso do harness nativo a partir desse registro. Sempre ligado; nada a decidir aqui.',
  },
}

export function featureBlurb(f: Pick<ExperimentalFeatureWire, 'id' | 'description'>, lang: Lang): string {
  return BLURBS[f.id]?.[lang] ?? f.description[lang]
}

/** What turning the native harness on or off actually changes, in words for a person (not an env var). */
const CHANGES: Record<string, { on: { en: string; pt: string }; off: { en: string; pt: string } }> = {
  provider: {
    on: {
      en: 'The native Agentistics harness appears in the new-session picker, the fleet and the metrics, and Settings → Providers and Memory open up. It is experimental: it may change or break between releases.',
      pt: 'O harness nativo do Agentistics passa a aparecer no seletor de nova sessão, na frota e nas métricas, e Configurações → Provedores e Memória são liberadas. É experimental: pode mudar ou quebrar entre versões.',
    },
    off: {
      en: 'The native harness and the model providers disappear from every screen. Nothing is deleted: your credentials, sessions and memory stay where they are.',
      pt: 'O harness nativo e os provedores de modelo somem de todas as telas. Nada é apagado: suas credenciais, sessões e memória continuam onde estão.',
    },
  },
}

export interface SwitchRequest { id: string; next: boolean }

/** Pressing a switch only asks. Nothing is written until `confirmed` is true. */
export function requestSwitch(f: ExperimentalFeatureWire): SwitchRequest | null {
  return f.switchable ? { id: f.id, next: !f.on } : null
}

export function confirmCopy(req: SwitchRequest, feature: ExperimentalFeatureWire, lang: Lang): {
  title: string; message: string; confirmLabel: string; cancelLabel: string
} {
  const name = featureName(feature, lang)
  const change = CHANGES[feature.id]?.[req.next ? 'on' : 'off'][lang] ?? feature.description[lang]
  const warn = req.next
    ? (lang === 'pt' ? ' Recursos experimentais não têm garantia de estabilidade.' : ' Experimental features come with no stability guarantee.')
    : ''
  return {
    title: req.next ? (lang === 'pt' ? `Ligar: ${name}?` : `Turn on: ${name}?`) : (lang === 'pt' ? `Desligar: ${name}?` : `Turn off: ${name}?`),
    message: change + warn,
    confirmLabel: req.next ? (lang === 'pt' ? 'Ligar' : 'Turn on') : (lang === 'pt' ? 'Desligar' : 'Turn off'),
    cancelLabel: lang === 'pt' ? 'Cancelar' : 'Cancel',
  }
}

/** Why a feature is in the state it is in — what the row says under its description. */
export function stateSentence(f: ExperimentalFeatureWire, lang: Lang): string {
  const pt = lang === 'pt'
  if (f.source === 'env') {
    return f.overridden
      ? (pt ? `Mantido desligado pela variável ${f.env}, que vence a preferência.` : `Kept off by ${f.env}, which wins over the preference.`)
      : (pt ? `Definido pela variável ${f.env}; esta tela não consegue mudar isso.` : `Set by the ${f.env} variable; this screen cannot change it.`)
  }
  if (!f.switchable) return pt ? 'Ligado por padrão; não depende deste interruptor.' : 'On by default; this switch does not govern it.'
  return f.on ? (pt ? 'Ligado.' : 'On.') : (pt ? 'Desligado.' : 'Off.')
}

/** An explicit variable decides in either direction, so a switch over it would promise what it cannot do. */
export function switchDisabled(f: ExperimentalFeatureWire): boolean {
  return !f.switchable || f.source === 'env'
}

/**
 * The experimental features — ONE table, and the arithmetic of "is it on, and why".
 *
 * Each entry is a real feature flag (an `AGENTISTICS_*` variable that a module reads to decide
 * whether a whole subsystem runs), not a tuning knob: a poll interval or a path override is not
 * experimental, it is configuration. A new experimental feature joins by adding ONE row here.
 *
 * `preferences.experimental === true` turns every row on at server start by writing the row's own
 * variable into the environment BEFORE the modules that read it load (`applyExperimental`). An
 * EXPLICIT variable always wins, in either direction — `AGENTISTICS_JOURNAL=0` keeps the journal off
 * even with the preference on — and `resolveExperimental` says so, so `status` can name the reason.
 *
 * **Absent reads as OFF**: with the preference unset or false and no variable, nothing changes.
 */

export interface ExperimentalFeature {
  /** Stable id, used by the CLI and the API. */
  id: string
  /** The environment variable the feature's own code reads. */
  env: string
  /** What the variable must read for the feature to be on — the feature's OWN parser, mirrored. */
  isOn: (raw: string | undefined) => boolean
  description: { en: string; pt: string }
}

/** The affirmative spellings `JOURNAL_ENABLED` and `projectionsEnabled` accept. */
const truthy = (raw: string | undefined): boolean =>
  ['1', 'true', 'on', 'yes'].includes((raw ?? '').trim().toLowerCase())

export const EXPERIMENTAL_FEATURES: readonly ExperimentalFeature[] = [
  {
    id: 'provider',
    env: 'AGENTISTICS_PROVIDER',
    // `providerFlagOn` (server/config.ts) accepts only '1'.
    isOn: raw => raw === '1',
    description: {
      en: 'Native runtime: model-provider credentials and the `agentop provider` commands.',
      pt: 'Runtime nativo: credenciais de provedores de modelo e os comandos `agentop provider`.',
    },
  },
  {
    id: 'journal',
    env: 'AGENTISTICS_JOURNAL',
    isOn: truthy,
    description: {
      en: 'Durable event journal: every build also feeds a local SQLite journal (shadow writer).',
      pt: 'Journal durável de eventos: cada build também alimenta um journal SQLite local (shadow writer).',
    },
  },
  {
    id: 'projections',
    env: 'AGENTISTICS_PROJECTIONS',
    isOn: truthy,
    description: {
      en: 'Projections: runtime metrics folded from the journal into a local store.',
      pt: 'Projeções: métricas de runtime derivadas do journal num armazenamento local.',
    },
  },
]

export type ExperimentalSource =
  /** The variable is set and decides, in either direction. */
  | 'env'
  /** No variable; the preference turned it on. */
  | 'preference'
  /** No variable, no preference. */
  | 'default'

export interface ExperimentalStatus {
  id: string
  env: string
  on: boolean
  source: ExperimentalSource
  /** The preference asked for it ON but an explicit variable keeps it off. */
  overridden: boolean
  /** The variable's raw value when it is set (`undefined` otherwise). */
  envValue: string | undefined
}

type Env = Record<string, string | undefined>

/** Records which variables `applyExperimental` wrote, so the same process (and its children) can
 *  tell "the preference set this" from "somebody exported this" — only the second is an override. */
export const EXPERIMENTAL_APPLIED_ENV = 'AGENTISTICS_EXPERIMENTAL_APPLIED'

const appliedIds = (env: Env): string[] => (env[EXPERIMENTAL_APPLIED_ENV] ?? '').split(',').filter(Boolean)

/** A variable counts as explicit when it is set to anything non-blank. */
const explicit = (raw: string | undefined): raw is string => raw !== undefined && raw.trim() !== ''

export function resolveExperimental(preference: boolean | undefined, env: Env): ExperimentalStatus[] {
  return EXPERIMENTAL_FEATURES.map(f => {
    const raw = env[f.env]
    const writtenByUs = appliedIds(env).includes(f.id) && raw === '1'
    if (explicit(raw) && !writtenByUs) {
      const on = f.isOn(raw)
      return { id: f.id, env: f.env, on, source: 'env' as const, overridden: preference === true && !on, envValue: raw }
    }
    return preference === true
      ? { id: f.id, env: f.env, on: true, source: 'preference' as const, overridden: false, envValue: undefined }
      : { id: f.id, env: f.env, on: false, source: 'default' as const, overridden: false, envValue: undefined }
  })
}

/**
 * Write the variable of every feature the preference turns on and no explicit variable decides.
 * Mutates `env` and returns the ids it set. With the preference off or absent it touches NOTHING —
 * the byte-identical-when-off guarantee lives here.
 */
export function applyExperimental(preference: boolean | undefined, env: Env): string[] {
  if (preference !== true) return []
  const applied: string[] = []
  for (const f of EXPERIMENTAL_FEATURES) {
    if (explicit(env[f.env]) && !appliedIds(env).includes(f.id)) continue
    env[f.env] = '1'
    applied.push(f.id)
  }
  if (applied.length > 0) env[EXPERIMENTAL_APPLIED_ENV] = applied.join(',')
  return applied
}

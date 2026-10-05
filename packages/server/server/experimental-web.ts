/**
 * `/api/experimental` — what THIS server booted with, and the switch.
 *
 * GET reports the stored preference and each feature resolved against the environment it actually
 * has (`resolveExperimental`). PUT `{ enabled }` is the Settings → Experimental switch: it persists
 * `preferences.experimental` and applies it to THIS process's environment, which is where every
 * gate reads it (`providerFlagOn`, `nativeExperimentalOn`, the engine's `flag('provider')` are all
 * functions of `process.env`, evaluated per request). It does NOT restart the server — the page
 * that asked stays connected, and the next `GET /api/engine` already tells the truth.
 *
 * The CLI (`agentop experimental enable|disable`) writes the same preference; a server started
 * afterwards reads it at boot (`experimental-boot.ts`), so the two doors cannot disagree.
 */
import {
  EXPERIMENTAL_APPLIED_ENV, EXPERIMENTAL_FEATURES, applyExperimental, resolveExperimental,
  type ExperimentalStatus,
} from '@agentistics/core'
import { readPreferences, writePreferences } from './preferences'

/** One feature as the screen needs it: its resolution plus the words and whether the switch governs it. */
export interface ExperimentalFeatureReport extends ExperimentalStatus {
  description: { en: string; pt: string }
  /** `false` for a feature that is ON by default — the preference is not what decides it, so the
   *  screen shows its state and offers no switch that would promise something it cannot do. */
  switchable: boolean
}

export interface ExperimentalReport {
  enabled: boolean
  features: ExperimentalFeatureReport[]
}

type Env = Record<string, string | undefined>

export function buildExperimentalReport(preference: boolean | undefined, env: Env): ExperimentalReport {
  const rows = resolveExperimental(preference, env)
  return {
    enabled: preference === true,
    features: rows.map(r => {
      const f = EXPERIMENTAL_FEATURES.find(x => x.id === r.id)!
      return { ...r, description: f.description, switchable: f.defaultOn !== true }
    }),
  }
}

export async function readExperimentalReport(env: Env = process.env): Promise<ExperimentalReport> {
  const prefs = await readPreferences()
  return buildExperimentalReport(prefs.experimental, env)
}

/**
 * Put `enabled` into force in `env` without a restart. ON writes each feature's own variable (the
 * boot rule, `applyExperimental`); OFF removes ONLY the variables that rule wrote — a variable the
 * operator exported keeps deciding, in either direction, exactly as at boot.
 */
export function applyExperimentalLive(enabled: boolean, env: Env): void {
  if (enabled) { applyExperimental(true, env); return }
  const written = (env[EXPERIMENTAL_APPLIED_ENV] ?? '').split(',').filter(Boolean)
  for (const f of EXPERIMENTAL_FEATURES) {
    if (written.includes(f.id) && env[f.env] === '1') delete env[f.env]
  }
  delete env[EXPERIMENTAL_APPLIED_ENV]
}

export interface ExperimentalSetDeps {
  readPrefs?: () => Promise<{ experimental?: boolean }>
  writePrefs?: (patch: { experimental: boolean }) => Promise<unknown>
  env?: Env
}

/** The switch. Persists first, applies second, and answers with what the server now reports. */
export async function setExperimental(enabled: boolean, deps: ExperimentalSetDeps = {}): Promise<ExperimentalReport> {
  const env = deps.env ?? process.env
  const prefs = await (deps.readPrefs ?? readPreferences)()
  if ((prefs.experimental === true) !== enabled) await (deps.writePrefs ?? writePreferences)({ experimental: enabled })
  applyExperimentalLive(enabled, env)
  return buildExperimentalReport(enabled, env)
}

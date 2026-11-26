/**
 * Applies `preferences.experimental` to the environment — and nothing else.
 *
 * It must run BEFORE `config.ts` loads: `JOURNAL_ENABLED` is a module constant read once at import,
 * so the variable has to be in place first. That is why this module imports neither `config.ts` nor
 * `preferences.ts` (both pull `config.ts` in) and reads the one key it needs straight off disk,
 * synchronously. A missing, unreadable or unparseable file means "not set" — the same answer a
 * fresh machine gives — never a boot failure.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { applyExperimental, EXPERIMENTAL_APPLIED_ENV, EXPERIMENTAL_FEATURES } from '@agentistics/core'

export function preferencesPathForBoot(env: Record<string, string | undefined> = process.env): string {
  return join(env.AGENTISTICS_DIR || join(homedir(), '.agentistics'), 'preferences.json')
}

export function readExperimentalPreference(path: string = preferencesPathForBoot()): boolean | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { experimental?: unknown }
    return typeof parsed.experimental === 'boolean' ? parsed.experimental : undefined
  } catch {
    return undefined
  }
}

/** The experimental variables THIS process inherited, before the boot applied (or cleared) them —
 *  what `agentop experimental status` reports as "this shell". Empty until the boot ran. */
let inherited: Record<string, string> = {}
export function inheritedExperimentalEnv(): Record<string, string> { return { ...inherited } }

/** The `AGENTISTICS_*` experimental variables of an environment, and the marker — nothing else. */
export function experimentalVars(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of [...EXPERIMENTAL_FEATURES.map(f => f.env), EXPERIMENTAL_APPLIED_ENV]) {
    const v = env[k]
    if (v !== undefined) out[k] = v
  }
  return out
}

/** Returns the ids of the features this call turned on (empty when off). With the preference off it
 *  also clears what an earlier application left in the INHERITED environment (`applyExperimental`). */
export function applyExperimentalFromDisk(env: Record<string, string | undefined> = process.env): string[] {
  inherited = experimentalVars(env)
  return applyExperimental(readExperimentalPreference(preferencesPathForBoot(env)), env)
}

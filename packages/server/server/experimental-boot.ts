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
import { applyAutonomousFlows, applyExperimental, awayActive, parseAwayState } from '@agentistics/core'

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

/** Returns the ids of the features this call turned on (empty when off — nothing touched). */
export function applyExperimentalFromDisk(env: Record<string, string | undefined> = process.env): string[] {
  const applied = applyExperimental(readExperimentalPreference(preferencesPathForBoot(env)), env)
  // AUTONOMOUS MODE (stored in preferences.away): the flows start on with it, unless set explicitly.
  try {
    const raw = (JSON.parse(readFileSync(preferencesPathForBoot(env), 'utf8')) as { away?: unknown }).away
    if (applyAutonomousFlows(awayActive(parseAwayState(raw), Date.now()), env)) applied.push('flows')
  } catch { /* no preferences yet: nothing to apply */ }
  return applied
}

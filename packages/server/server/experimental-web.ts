/**
 * `GET /api/experimental` — what THIS server booted with: the stored preference and each feature
 * resolved against the environment it actually has (`resolveExperimental`). Read-only: the switch
 * is the CLI (`agentop experimental enable|disable`), which persists, restarts and then asks this
 * route to confirm the server came back in the requested state.
 */
import { resolveExperimental, type ExperimentalStatus } from '@agentistics/core'
import { readPreferences } from './preferences'

export interface ExperimentalReport {
  enabled: boolean
  features: ExperimentalStatus[]
}

export async function readExperimentalReport(env: Record<string, string | undefined> = process.env): Promise<ExperimentalReport> {
  const prefs = await readPreferences()
  return { enabled: prefs.experimental === true, features: resolveExperimental(prefs.experimental, env) }
}

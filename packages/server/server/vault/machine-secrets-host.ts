/**
 * vault/machine-secrets-host.ts — the real host wiring of `machineSecrets` (engine-api 1.23): where the machine key
 * lives (`<vault>/machine`, inside the vault directory so the backup plan's `.agentistics/vault` exclusion covers it),
 * which silent protectors may hold it, and where the weaker file mode reads the machine id from.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { EngineMachineSecrets } from '@agentistics/engine-api'
import { createMachineSecrets } from './machine-secrets'
import { machineProtectorCandidates, vaultDir, vaultLang } from './service'

/** The machine id of this host (Linux), or `null` when there is none to bind the weaker mode to. */
export function readMachineId(read: (p: string) => string = p => readFileSync(p, 'utf8')): string | null {
  for (const f of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
    try { const v = read(f).trim(); if (/^[0-9a-f]{16,64}$/i.test(v)) return v } catch { /* next */ }
  }
  return null
}

let cached: { dir: string; ms: ReturnType<typeof createMachineSecrets> } | null = null

export function engineMachineSecrets(): EngineMachineSecrets {
  const dir = join(vaultDir(), 'machine')
  if (cached?.dir !== dir) {
    cached?.ms.dispose()
    cached = { dir, ms: createMachineSecrets({ dir, protectors: () => machineProtectorCandidates(dir), machineId: () => readMachineId(), lang: vaultLang }) }
  }
  return cached.ms
}

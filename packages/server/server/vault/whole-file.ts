/**
 * vault/whole-file.ts — the migrator for a secret that is ONE plaintext file (S2 the GitHub backup
 * config, S5 the envelope private key): the `@agentistics/vault` state machine run against the real
 * filesystem with the open vault, reported in words.
 */
import { existsSync } from 'node:fs'
import { migrateFile, openRecord, sealToBytes, type MigrationItem } from '@agentistics/vault'
import {
  displayPath, ensureVaultOpen, vaultAudit, restoreWithFor, secretFs, sentence,
  type Migrator, type MigrationReport,
} from './service'

/** `<dir>/name.json` → `<dir>/name.sealed`. */
export function sealedPathFor(plainPath: string): string {
  return plainPath.replace(/\.json$/, '') + '.sealed'
}

/**
 * Migrate one file now. Opens (creating when needed) the vault. Never throws; the report says what
 * happened in one line when anything did.
 */
export async function migrateWholeFile(item: MigrationItem): Promise<MigrationReport> {
  if (!existsSync(item.plainPath) && !existsSync(item.plainPath + '.scrub')) return { migrated: 0, lines: [] }
  const o = await ensureVaultOpen({ migrate: false })
  if (!o) {
    vaultAudit({ type: 'vault.plaintext-pending', purpose: item.purpose, name: item.name, source: 'host' })
    return { migrated: 0, lines: [] }
  }
  const r = await migrateFile(secretFs(), {
    seal: (purpose, name, plaintext) => sealToBytes({ dek: o.dek, kid: o.kid, purpose, name, plaintext }),
    open: (purpose, name, bytes) => openRecord({ dek: o.dek, kid: o.kid, purpose, name, bytes }),
  }, item, e => vaultAudit({ ...e, source: 'host' }))
  const file = displayPath(item.plainPath)
  switch (r.status) {
    case 'nothing': return { migrated: 0, lines: [] }
    case 'migrated':
    case 'finished': return { migrated: 1, lines: [] }
    case 'conflict':
      vaultAudit({ type: 'vault.plaintext-pending', purpose: item.purpose, name: item.name, source: 'host' })
      return { migrated: 0, lines: [sentence('conflict', { file, restoreWith: restoreWithFor(item.purpose) })] }
    case 'refused':
      return { migrated: 0, lines: [sentence(r.code, { file: displayPath(item.sealedPath), kid: r.kid, restoreWith: restoreWithFor(item.purpose) })] }
    case 'failed':
      vaultAudit({ type: 'vault.migration-failed', purpose: item.purpose, name: item.name, source: 'host' })
      return { migrated: 0, lines: [sentence('migration-failed', { file, reason: r.reason })] }
  }
}

export function wholeFileMigrator(id: string, item: () => MigrationItem): Migrator {
  return {
    id,
    async pending() {
      return existsSync(item().plainPath) ? 1 : 0
    },
    async pendingFiles() {
      return existsSync(item().plainPath) ? [item().plainPath] : []
    },
    run: () => migrateWholeFile(item()),
  }
}

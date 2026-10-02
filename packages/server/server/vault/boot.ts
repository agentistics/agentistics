/**
 * vault/boot.ts — what the agentop SERVICE does with the vault when it starts, and the inventory
 * the `agentop vault` verbs report on.
 *
 * At start: if a vault exists, or any plaintext secret from an earlier version is still on disk,
 * open it (creating it under the first protector that answers when there is something to migrate),
 * run the migration pass, and say what happened — in one line each. A vault that cannot open leaves
 * every plaintext file exactly as it is, writes no new plaintext ever, and says so
 * (`plaintext-pending` / `locked` / `no-protector`). Then the unlock socket is opened, so a
 * passphrase vault can be unlocked without restarting.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { migratedSentence } from '@agentistics/vault'
import { AGENTISTICS_DATA_DIR, envelopeKeyFile } from '../config'
import {
  allRestoreWith, becomeVaultHolder, hardenThisProcess, displayPath, ensureVaultOpen, pendingPlaintext, runMigrations, vaultExists, vaultLang,
  vaultStatus,
} from './service'
import { installVaultOps } from './ops'
import { hardeningLines } from './hardening'
import { startVaultSocket } from './socket'
import { sealedPathFor } from './whole-file'
import { tokensFileFor } from './prefs-tokens'
import { STANDALONE_CENTRAL_ENV, centralSecretsFile, splitCentralEnv } from './central-env'
import { GITHUB_BACKUP_SEALED_FILE } from '../backup/github-store'
import { PREFERENCES_FILE } from '../preferences'
import '../envelope-keys'

/** Import every module that registers a migrator, so the pass and the pending count see them all. */
export async function loadVaultConsumers(): Promise<void> {
  // Statically imported above; kept as a call so a caller states the intent.
}

/**
 * The sealed files the HOST owns (for `vault status` and `vault reset`). ONE OWNER PER FILE: the
 * engine owns `provider-keys/` — its layout, its writes and the migration of its legacy plaintext
 * (S1, SECRETS.1) — so nothing here lists, migrates, scrubs or deletes anything under it.
 */
export function sealedFiles(): string[] {
  return [
    GITHUB_BACKUP_SEALED_FILE,
    sealedPathFor(envelopeKeyFile()),
    tokensFileFor(PREFERENCES_FILE),
    centralSecretsFile(STANDALONE_CENTRAL_ENV),
  ].filter(p => existsSync(p))
}

/** The engine-owned directory, named so a test can assert the host never reaches into it. */
export const ENGINE_OWNED_DIRS = [join(AGENTISTICS_DATA_DIR, 'provider-keys')] as const

/**
 * The plaintext secret VALUES still on disk, in memory only — so a passphrase equal to one of them
 * can be refused (`checkPassphrase`). Never logged, never returned past the caller.
 */
export function pendingSecretValues(): string[] {
  const out: string[] = []
  const read = (p: string) => { try { return readFileSync(p, 'utf8') } catch { return null } }
  const gh = read(join(AGENTISTICS_DATA_DIR, 'github-backup.json'))
  if (gh) { try { const t = (JSON.parse(gh) as { token?: unknown }).token; if (typeof t === 'string' && t) out.push(t) } catch { /* junk */ } }
  const prefs = read(join(AGENTISTICS_DATA_DIR, 'preferences.json'))
  if (prefs) {
    try {
      const team = (JSON.parse(prefs) as { team?: { token?: unknown; connections?: { token?: unknown }[] } }).team
      if (typeof team?.token === 'string' && team.token) out.push(team.token)
      for (const c of team?.connections ?? []) if (typeof c?.token === 'string' && c.token) out.push(c.token)
    } catch { /* junk */ }
  }
  const env = read(STANDALONE_CENTRAL_ENV)
  if (env) out.push(...Object.values(splitCentralEnv(env).secrets))
  return out
}

/** One-line report sink: the service log, and (optionally) a notification. */
export type Say = (line: string) => void

/** Service start. Never throws. */
export async function bootVault(say: Say = (l) => process.stderr.write(`agentop: ${l}\n`), opts: { socket?: boolean } = {}): Promise<void> {
  // This process IS the service: the one place a human data key may live (SECRETS.4 §5.2).
  becomeVaultHolder()
  installVaultOps()
  // §5.3: the memory goes private BEFORE anything below can unwrap a key.
  const h = await hardenThisProcess()
  for (const line of hardeningLines(h, vaultLang())) say(line)
  try {
    await loadVaultConsumers()
    const pending = await pendingPlaintext()
    if (vaultExists() || pending > 0) {
      const o = await ensureVaultOpen({ create: pending > 0, migrate: false })
      if (o) {
        const r = await runMigrations()
        for (const l of r.lines) say(l)
        if (r.migrated > 0) say(migratedSentence(r.migrated, allRestoreWith(), vaultLang()))
      } else {
        const s = await vaultStatus()
        if (s.sentence) say(s.sentence)
      }
    }
  } catch {
    say('the vault could not be checked at start; secrets stay as they are and nothing is written in plain text.')
  }
  if (opts.socket !== false) {
    const r = await startVaultSocket()
    if (!r.ok && r.reason === 'in-use') say('another agentop service already answers on the vault unlock socket; this one does not take it over.')
    else if (!r.ok && r.reason !== 'EADDRINUSE') say(`the vault unlock socket could not be opened (${r.reason}); \`agentop vault unlock\` will not reach this service.`)
  }
}

export { displayPath }

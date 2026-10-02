/**
 * github-store.ts — where the GitHub backup token lives.
 *
 * `~/.agentistics/github-backup.sealed` — the whole config SEALED by the machine's vault (purpose
 * `github-backup`), because it holds a live personal access token. It is never written in plain text:
 * with no vault able to seal, `writeGithubConfig` REFUSES with the vault's sentence. The legacy
 * plaintext `github-backup.json` an earlier version wrote is migrated (sealed, verified, scrubbed) the
 * first time the vault is open — see docs/security.md § "Secrets at rest".
 *
 * `token` is never logged, never returned by a route, and never included in a backup — it is listed
 * in `backup-plan.ts`'s `EXCLUDE_RULES` as a `secret` for exactly that reason. A route that wants to
 * show the connection must strip `token` before answering — see `GithubBackupStatus` below, the one
 * shape a route may return.
 *
 * Every function takes an optional `file` — the LEGACY plaintext path; the sealed file is its
 * sibling (`.json` → `.sealed`). That is the test-injection point, so a test never touches the real
 * `~/.agentistics`.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { AGENTISTICS_DATA_DIR } from '../config'
import { scrubFile } from '@agentistics/vault'
import {
  openFromFile, pendingPlaintext, registerVaultMigrator, sealToFile, secretFs, sentence,
} from '../vault/service'
import { migrateWholeFile, sealedPathFor, wholeFileMigrator } from '../vault/whole-file'

/** The LEGACY plaintext location — only ever read to migrate it. */
export const GITHUB_BACKUP_CONFIG_FILE = join(AGENTISTICS_DATA_DIR, 'github-backup.json')
/** Where the config lives now. */
export const GITHUB_BACKUP_SEALED_FILE = sealedPathFor(GITHUB_BACKUP_CONFIG_FILE)

const PURPOSE = 'github-backup'
const NAME = 'github-backup'

function itemFor(file: string) {
  return { purpose: PURPOSE, name: NAME, plainPath: file, sealedPath: sealedPathFor(file) }
}

registerVaultMigrator(wholeFileMigrator('github-backup', () => itemFor(GITHUB_BACKUP_CONFIG_FILE)))

export interface GithubBackupConfig {
  /** `https://github.com/<owner>/<repo>` (or whichever form the user pasted) — display only. */
  url: string
  owner: string
  repo: string
  /**
   * A GitHub PAT. NEVER logged, NEVER returned by a route, NEVER included in a backup.
   * EMPTY when `auth` is `'gh'` — nothing is stored in that mode.
   */
  token: string
  /**
   * Which credential to use. Absent reads as `'token'`: every config written before `gh` was an
   * option holds one, and treating absence as anything else would break every machine already
   * versioning, at the moment it tried to upload. See `github-cli.ts`.
   */
  auth?: 'token' | 'gh'
  /** How many of THIS MACHINE's releases to keep on GitHub. 0 means keep them all. Never counted
   *  across machines — see `selectForPruning`. */
  keepRemote: number
  /**
   * What this machine is called in the release tag, so several machines can share one repository
   * and still be told apart — on the releases page, in `agentop restore github --list`, and by
   * retention, which may only ever delete this machine's own history.
   *
   * Defaults to the hostname at setup, and is editable because a hostname is often unreadable
   * (`BRAIAODE2`) and is not guaranteed unique across two machines a person owns.
   */
  label?: string
  /** Delete the local archive once the upload is confirmed byte-for-byte. */
  deleteLocalAfterUpload: boolean
}

/** What a route may return about this config. No `token`, ever — see the module header. */
export type GithubBackupStatus =
  | { configured: false }
  | { configured: true; url: string; owner: string; repo: string }

/** Strip the token. The ONLY shape any route may hand back. */
export function toStatus(config: GithubBackupConfig | null): GithubBackupStatus {
  if (!config) return { configured: false }
  return { configured: true, url: config.url, owner: config.owner, repo: config.repo }
}

function isValidConfig(v: unknown): v is GithubBackupConfig {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return typeof o.url === 'string' && typeof o.owner === 'string'
    && typeof o.repo === 'string' && typeof o.token === 'string'
}

/** What reading the config found. `refused` carries the vault's sentence (locked, tampered, …). */
export type GithubConfigRead =
  | { state: 'absent' }
  | { state: 'ok'; config: GithubBackupConfig }
  | { state: 'refused'; sentence: string }

/**
 * Read the config: the sealed file, migrating a legacy plaintext one first when that is all there
 * is. A plaintext file is never USED — only handed to the migration; if it cannot be sealed yet the
 * answer is the vault's refusal, not the token.
 */
export async function readGithubConfigDetailed(file = GITHUB_BACKUP_CONFIG_FILE): Promise<GithubConfigRead> {
  const sealed = sealedPathFor(file)
  let r = await openFromFile(sealed, PURPOSE, NAME)
  if (!r.ok && r.absent && existsSync(file)) {
    const m = await migrateWholeFile(itemFor(file))
    r = await openFromFile(sealed, PURPOSE, NAME)
    if (!r.ok && r.absent) {
      return { state: 'refused', sentence: m.lines[0] ?? sentence('plaintext-pending', { n: Math.max(1, await pendingPlaintext()) }) }
    }
  }
  if (!r.ok) return r.absent ? { state: 'absent' } : { state: 'refused', sentence: r.sentence }
  const config = parseConfig(new TextDecoder().decode(r.plaintext))
  return config ? { state: 'ok', config } : { state: 'absent' }
}

/** Reads the config, or `null` if it is absent, unreadable, malformed or cannot be opened. Never throws. */
export async function readGithubConfig(file = GITHUB_BACKUP_CONFIG_FILE): Promise<GithubBackupConfig | null> {
  try {
    const r = await readGithubConfigDetailed(file)
    return r.state === 'ok' ? r.config : null
  } catch {
    return null
  }
}

function parseConfig(raw: string): GithubBackupConfig | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isValidConfig(parsed)) return null
  return {
    url: parsed.url,
    owner: parsed.owner,
    repo: parsed.repo,
    token: parsed.token,
    keepRemote: typeof (parsed as Partial<GithubBackupConfig>).keepRemote === 'number'
      ? (parsed as GithubBackupConfig).keepRemote : 0,
    deleteLocalAfterUpload: (parsed as Partial<GithubBackupConfig>).deleteLocalAfterUpload === true,
    // Read explicitly, like every field above: this is an ALLOWLIST, never a spread. A config file
    // is hand-editable, and spreading it would carry whatever else somebody put there into a shape
    // the rest of the product trusts. An absent or non-string label reads as absent, and the
    // callers fall back to the hostname — which is what the machine's existing releases already
    // record in their bodies, so it attributes its own history correctly.
    label: typeof (parsed as Partial<GithubBackupConfig>).label === 'string'
      ? (parsed as GithubBackupConfig).label : undefined,
    // Only the two values mean anything; anything else reads as absent, i.e. `'token'`.
    auth: (parsed as Partial<GithubBackupConfig>).auth === 'gh' ? 'gh' : undefined,
  }
}

/**
 * Seal and write the config (tmp + fsync + rename + chmod 0600 + fsync dir, via the vault's one
 * writer). THROWS the vault's `VaultRefusalError` when it cannot seal — never writes plain text. A
 * legacy plaintext file beside it is scrubbed afterwards: the sealed one supersedes it.
 */
export async function writeGithubConfig(
  config: GithubBackupConfig, file = GITHUB_BACKUP_CONFIG_FILE,
): Promise<void> {
  await sealToFile(sealedPathFor(file), PURPOSE, NAME, new TextEncoder().encode(JSON.stringify(config, null, 2)))
  if (existsSync(file)) await scrubFile(secretFs(), file)
}

/** Remove the config, sealed and legacy alike. Idempotent. */
export async function removeGithubConfig(file = GITHUB_BACKUP_CONFIG_FILE): Promise<void> {
  const fs = secretFs()
  await fs.unlink(sealedPathFor(file))
  if (existsSync(file)) await scrubFile(fs, file)
}

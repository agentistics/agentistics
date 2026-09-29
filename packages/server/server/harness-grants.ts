/**
 * harness-grants.ts — the IO half of catalogue TRUST (B8.3, spec §4). Where the grants file lives,
 * how it is written, and the audit line each change leaves. What trust MEANS — the hash, the
 * record, what untrust clears, what a corrupt file reads as — is the runtime's pure `grants.ts`.
 *
 * ## Where
 *
 * `<AGENTISTICS_DIR>/runtime/harness-grants.json`. Under `runtime/` on purpose: B4's backup row
 * excludes `.agentistics/runtime` (`reason: 'runtime'`), so no grant ever travels. A grant is keyed
 * to a path on THIS machine; restored elsewhere it would trust whatever repository sits at that
 * path there (spec §3.3). A restored machine starts with nothing trusted.
 *
 * ## How
 *
 * Written atomically (a temp file in the same directory, then `rename`), the file 0600 and the
 * directory 0700: it decides what a repository may make this machine run. A CORRUPT file is never
 * overwritten in place — it is moved aside to `harness-grants.json.corrupt-<ms>` first, so whatever
 * garbled it can still be looked at (the backup plan's `.corrupt-` rule already keeps those out of
 * a backup). Until something writes, a corrupt file simply reads as nothing trusted.
 *
 * ## Keyed by the workspace root's REALPATH
 *
 * `~/work/repo` and a symlink to it are one project; two clones are two. A root that no longer
 * resolves (the folder was deleted) keys by its absolute path, which is what an `untrust` of a
 * deleted folder needs to find the record it left.
 *
 * ## The audit
 *
 * Trust and untrust are the moments a repository gains or loses the power to configure the agent,
 * so each writes an audit event (`audit.ts`). The shared `audit` collection lives in a central's
 * Mongo — and trust is refused on a central (§8), so on every machine where this runs that
 * collection does not exist. The events therefore go to `runtime/harness-audit.jsonl` (0600),
 * built by the same `buildAuditEvent` that redacts secret-shaped fields. They carry the root, the
 * hash and the NAMES of what was granted or cleared — never a declaration, an env value or a URL.
 */
import { appendFile, chmod, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  parseGrantsFile,
  serializeGrantsFile,
  type GrantsFile,
} from '@agentistics/runtime'
import { buildAuditEvent, type AuditInput } from './audit'

export const GRANTS_FILE_NAME = 'harness-grants.json'
export const GRANTS_AUDIT_FILE_NAME = 'harness-audit.jsonl'

export function grantsPath(dataDir: string): string {
  return join(dataDir, 'runtime', GRANTS_FILE_NAME)
}

export function grantsAuditPath(dataDir: string): string {
  return join(dataDir, 'runtime', GRANTS_AUDIT_FILE_NAME)
}

export interface LoadedGrants {
  file: GrantsFile
  /** The file existed and could not be trusted as a whole: it reads as nothing trusted. */
  corrupt: boolean
  path: string
}

export async function readGrants(dataDir: string): Promise<LoadedGrants> {
  const path = grantsPath(dataDir)
  let text: string | null = null
  try {
    text = await readFile(path, 'utf-8')
  } catch (err) {
    // Missing is "nothing trusted yet". Any OTHER read failure is also nothing trusted — and is
    // reported as corrupt, because a file that exists and cannot be read is not an empty one.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return { ...parseGrantsFile('\u0000'), path }
  }
  return { ...parseGrantsFile(text), path }
}

/** Writes the whole file atomically. A corrupt predecessor is moved aside, never overwritten. */
export async function writeGrants(dataDir: string, file: GrantsFile, opts: { corrupt: boolean; now?: Date }): Promise<void> {
  const path = grantsPath(dataDir)
  const dir = dirname(path)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await chmod(dir, 0o700).catch(() => {})
  if (opts.corrupt) {
    await rename(path, `${path}.corrupt-${(opts.now ?? new Date()).getTime()}`).catch(() => {})
  }
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, serializeGrantsFile(file), { mode: 0o600 })
  await chmod(tmp, 0o600)
  await rename(tmp, path)
}

/** The key a workspace root's grants are filed under. */
export async function projectKey(workspaceRoot: string): Promise<string> {
  try { return await realpath(workspaceRoot) } catch { return resolve(workspaceRoot) }
}

/** Appends one audit event to the machine-local log. Never throws: an audit sink failing is not a reason to undo the act. */
export async function appendGrantsAudit(dataDir: string, input: AuditInput, now = new Date()): Promise<void> {
  try {
    const path = grantsAuditPath(dataDir)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await appendFile(path, `${JSON.stringify(buildAuditEvent(input, now))}\n`, { mode: 0o600 })
    await chmod(path, 0o600).catch(() => {})
  } catch {
    // Swallowed on purpose, like writeAudit.
  }
}

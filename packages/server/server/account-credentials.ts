/**
 * account-credentials.ts — does a Claude account's config root still HOLD a login?
 *
 * `claude auth status` is the authority on who an account is, but it is slow (a cold CLI) and a probe
 * that times out answers "unknown", not "signed out" — so an account whose folder lost its credential
 * stayed `ok` in the registry, drew empty 0/0 rings in the usage popup and was still offered to the
 * router (a session on it stalled on Claude's "Select login method"). The credential FILE is the other
 * witness: on Linux and Windows Claude keeps the login in `<root>/.credentials.json`.
 *
 * Only the SHAPE is read — whether an OAuth credential is there, never its value, and nothing here
 * returns, logs or stores a token.
 *
 * macOS keeps it in the keychain, so a missing file proves nothing there: `unknown` (never
 * `missing`). The same for an account fed by an environment token.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { HarnessId } from '@agentistics/core'
import { AGENTISTICS_DATA_DIR, HOME_DIR } from './config'
import { defaultClaudeConfigDir } from './default-claude-root'

export type CredentialState = 'ok' | 'missing' | 'empty' | 'invalid' | 'unknown'

/** PURE. Classify the raw bytes of a `.credentials.json` (`null`: the file is not there). */
export function classifyCredentialFile(raw: string | null): CredentialState {
  if (raw === null) return 'missing'
  if (!raw.trim()) return 'empty'
  let doc: unknown
  try { doc = JSON.parse(raw) } catch { return 'invalid' }
  if (!doc || typeof doc !== 'object') return 'invalid'
  const oauth = (doc as { claudeAiOauth?: unknown }).claudeAiOauth
  if (!oauth || typeof oauth !== 'object') return 'invalid'
  const held = (k: string) => { const v = (oauth as Record<string, unknown>)[k]; return typeof v === 'string' && v.trim().length > 0 }
  // A refresh credential alone can still mint a new access token, so either one is a login.
  return held('accessToken') || held('refreshToken') ? 'ok' : 'empty'
}

/** Is this state proof that the account cannot work? `unknown` and `ok` are not. */
export const credentialBroken = (s: CredentialState): boolean => s === 'missing' || s === 'empty' || s === 'invalid'

/**
 * The state of a Claude root's credential. `unknown` wherever the file is not the place to look:
 * macOS (keychain), an environment-fed token, or a harness other than Claude.
 */
export function claudeCredentialState(
  root: string, o: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; read?: (path: string) => string | null } = {},
): CredentialState {
  const platform = o.platform ?? process.platform
  const env = o.env ?? process.env
  if (platform === 'darwin' || env.CLAUDE_CODE_OAUTH_TOKEN) return 'unknown'
  // A folder that is not there says nothing about a login (an unmounted disk, a registry written elsewhere):
  // only a root that EXISTS and holds no credential is a signed-out account.
  if (!o.read && !existsSync(root)) return 'unknown'
  const read = o.read ?? ((path: string) => {
    try { return readFileSync(path, 'utf8') } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e }
  })
  // An unreadable file (permissions, a transient error) is not a missing login.
  try { return classifyCredentialFile(read(join(root, '.credentials.json'))) } catch { return 'unknown' }
}

/**
 * Does this BOUND account's root prove its login is gone? `root` is where the account runs
 * (`spawnRowsOf(...).root`; `null` is the harness's default home). Claude only: the other harnesses
 * keep their login where their own probe already reads it.
 */
export function accountCredentialBroken(a: { harness: HarnessId; retired?: boolean }, root: string | null): boolean {
  if (a.harness !== 'claude' || a.retired) return false
  const at = root ?? (defaultClaudeConfigDir(process.env, AGENTISTICS_DATA_DIR) || join(HOME_DIR, '.claude'))
  return credentialBroken(claudeCredentialState(at))
}

/**
 * Did a login get WRITTEN into this root since `since` (epoch ms)? The witness for a sign-in the CLI
 * did not announce: its process may still be alive, may have ended with an odd status, or the app's
 * own wait may have run out an instant before the file appeared — the credential on disk is what says
 * the sign-in worked. Fresh means "newer than the code the person pasted", which is what keeps the
 * OLD token of an expired account from reading as a new login. Claude only, and never on macOS (the
 * login is in the keychain there, so a file proves nothing).
 */
export function claudeCredentialWrittenSince(
  root: string | null, since: number,
  o: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; read?: (path: string) => string | null; mtime?: (path: string) => number | null } = {},
): boolean {
  const platform = o.platform ?? process.platform
  const env = o.env ?? process.env
  if (platform === 'darwin' || env.CLAUDE_CODE_OAUTH_TOKEN) return false
  const dir = root ?? (defaultClaudeConfigDir(process.env, AGENTISTICS_DATA_DIR) || join(HOME_DIR, '.claude'))
  const file = join(dir, '.credentials.json')
  const mtime = o.mtime ?? ((path: string) => { try { return statSync(path).mtimeMs } catch { return null } })
  const at = mtime(file)
  // A little slack: the file system's clock and ours are not the same instant.
  if (at === null || at < since - 2_000) return false
  return claudeCredentialState(dir, { platform, env, ...(o.read ? { read: o.read } : {}) }) === 'ok'
}

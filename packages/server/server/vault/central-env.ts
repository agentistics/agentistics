/**
 * vault/central-env.ts — a central's `central.env`, split in two (S6).
 *
 * `~/.agentistics/central/central.env` keeps the NON-secret variables (`APP_PORT`, `BIND_IP`,
 * `AGENTISTICS_EXPOSURE`, `AGENTISTICS_TEAM_ORG`, …) — the file `docker compose --env-file` reads —
 * and the four secret ones move to `central/secrets.sealed` (purpose `central-env`):
 * `AGENTISTICS_TEAM_PASSWORD`, `AGENTISTICS_TEAM_SESSION_SECRET`, `AGENTISTICS_TEAM_INGEST_TOKEN`
 * and `MONGO_URL` (which may carry database credentials). `agentop central up` opens the sealed file
 * on the HOST and hands the values to `docker compose` / the native server through the child's
 * ENVIRONMENT — the compose file already reads them by `${VAR:-}` interpolation — so no file with
 * them is written.
 *
 * Stated limits (docs/security.md): Docker persists a container's environment in its own root-only
 * state, so on the Docker host the central's secrets are at rest in Docker's store, readable by root
 * and the `docker` group. And a central run from a REPO CHECKOUT through `central.sh` keeps its
 * `central.env` beside the script, where bash reads it directly — that file is a developer's checkout
 * config, outside `~/.agentistics`, and is not split.
 */
import { dirname, join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { AGENTISTICS_DATA_DIR } from '../config'
import { underTest } from '../data-dir'
import { openFromFile, registerVaultMigrator, sealToFile, secretFs, sentence, displayPath, type MigrationReport } from './service'
import { SCRUB_SUFFIX, VaultRefusalError, bytesEqual, finishScrub, scrubFile, writePrivateAtomic } from '@agentistics/vault'

export const CENTRAL_SECRET_KEYS = [
  'AGENTISTICS_TEAM_PASSWORD',
  'AGENTISTICS_TEAM_SESSION_SECRET',
  'AGENTISTICS_TEAM_INGEST_TOKEN',
  'MONGO_URL',
] as const

const SECRET_SET = new Set<string>(CENTRAL_SECRET_KEYS)
const PURPOSE = 'central-env'
const NAME = 'central'

export const STANDALONE_CENTRAL_ENV = join(AGENTISTICS_DATA_DIR, 'central', 'central.env')

export function centralSecretsFile(envFile: string): string {
  return join(dirname(envFile), 'secrets.sealed')
}

/**
 * Is this env file one the vault splits? Only those under the data directory (and, outside a test
 * run, the default `~/.agentistics`, which is where `cli-central.ts` keeps the standalone central).
 */
export function isVaultedEnvFile(envFile: string): boolean {
  const roots = [resolve(AGENTISTICS_DATA_DIR)]
  if (!underTest(process.env)) roots.push(resolve(homedir(), '.agentistics'))
  const f = resolve(envFile)
  return roots.some(root => f.startsWith(root + '/'))
}

/** PURE. Split `KEY=value` text: the secret lines out, everything else (comments included) kept. */
export function splitCentralEnv(text: string): { publicText: string; secrets: Record<string, string> } {
  const secrets: Record<string, string> = {}
  const kept: string[] = []
  for (const line of text.split('\n')) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line)
    if (m && SECRET_SET.has(m[1]!)) {
      if (m[2] !== '') secrets[m[1]!] = m[2]!
      continue
    }
    kept.push(line)
  }
  return { publicText: kept.join('\n'), secrets }
}

/** PURE. How many secret values `text` still holds in plain text. */
export function plaintextSecretCount(text: string): number {
  return Object.keys(splitCentralEnv(text).secrets).length
}

function parseMap(bytes: Uint8Array): Record<string, string> | null {
  try {
    const o = JSON.parse(new TextDecoder().decode(bytes)) as { v?: number; env?: Record<string, unknown> }
    if (o.v !== 1 || !o.env || typeof o.env !== 'object') return null
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(o.env)) if (SECRET_SET.has(k) && typeof v === 'string') out[k] = v
    return out
  } catch { return null }
}

export type CentralSecrets = { ok: true; env: Record<string, string> } | { ok: false; sentence: string }

/** The sealed secrets of this env file (empty when there are none). */
export async function loadCentralSecrets(envFile: string): Promise<CentralSecrets> {
  if (!isVaultedEnvFile(envFile)) return { ok: true, env: {} }
  const r = await openFromFile(centralSecretsFile(envFile), PURPOSE, NAME)
  if (r.ok) {
    const env = parseMap(r.plaintext)
    return env ? { ok: true, env } : { ok: false, sentence: sentence('tampered', { file: displayPath(centralSecretsFile(envFile)), restoreWith: 'agentop central up' }) }
  }
  return r.absent ? { ok: true, env: {} } : { ok: false, sentence: r.sentence }
}

async function readText(envFile: string): Promise<string | null> {
  if (isVaultedEnvFile(envFile)) await recoverCentralEnv(envFile)
  const b = await secretFs().readFile(envFile)
  return b ? new TextDecoder().decode(b) : null
}

/**
 * Write a central's env: under the data directory, the secrets are sealed (and verified) FIRST and
 * the file then written without them; elsewhere (a repo checkout's `central.sh` config) the text is
 * written as it is, 0600. THROWS the vault's refusal rather than writing a secret in plain text.
 */
export async function writeCentralEnv(envFile: string, text: string): Promise<void> {
  if (!isVaultedEnvFile(envFile)) {
    await writePrivateAtomic(secretFs(), envFile, new TextEncoder().encode(text))
    return
  }
  const { publicText, secrets } = splitCentralEnv(text)
  // Keep a sealed secret the new text does not mention (an `init` that left a value blank keeps it).
  const prev = await loadCentralSecrets(envFile)
  const merged = { ...(prev.ok ? prev.env : {}), ...secrets }
  if (Object.keys(merged).length > 0) {
    const body = new TextEncoder().encode(JSON.stringify({ v: 1, env: merged }))
    await sealToFile(centralSecretsFile(envFile), PURPOSE, NAME, body)
    const back = await loadCentralSecrets(envFile)
    if (!back.ok || !bytesEqual(new TextEncoder().encode(JSON.stringify(back.env)), new TextEncoder().encode(JSON.stringify(merged)))) {
      throw new Error(sentence('migration-failed', { file: displayPath(centralSecretsFile(envFile)), reason: 'the sealed values did not read back equal' }))
    }
  }
  const fs = secretFs()
  const old = await readText(envFile)
  if (old !== null && plaintextSecretCount(old) > 0) {
    // The old file holds the secrets in clear: it is SCRUBBED like every other migrated file, not
    // merely replaced by a rename (which leaves its blocks as they were). Order, crash-safe: the
    // public half is written beside it first, then the old file is scrubbed, then the new one takes
    // its name; `recoverCentralEnv` finishes a pass a crash interrupted.
    const next = envFile + NEXT_SUFFIX
    await writePrivateAtomic(fs, next, new TextEncoder().encode(publicText))
    await scrubFile(fs, envFile)
    await fs.rename(next, envFile)
    await fs.fsyncDir(dirname(envFile))
    return
  }
  await writePrivateAtomic(fs, envFile, new TextEncoder().encode(publicText))
}

const NEXT_SUFFIX = '.next'

/**
 * Finish a split a crash interrupted: a `central.env.next` with no `central.env` means the old file
 * was already scrubbed — the new one takes its name. With both present the old one is still whole,
 * so the half-written `.next` is simply dropped and the split runs again. Never throws.
 */
export async function recoverCentralEnv(envFile: string): Promise<void> {
  const fs = secretFs()
  try {
    await finishScrub(fs, envFile + SCRUB_SUFFIX)
    const next = envFile + NEXT_SUFFIX
    if (!(await fs.lstat(next))) return
    if (await fs.lstat(envFile)) await fs.unlink(next)
    else { await fs.rename(next, envFile); await fs.fsyncDir(dirname(envFile)) }
  } catch { /* the next pass tries again */ }
}

/** The whole env — the file's public lines plus the opened secrets. Memory only. */
export async function loadCentralEnv(envFile: string): Promise<{ env: Record<string, string>; refusal: string | null }> {
  const env: Record<string, string> = {}
  const text = await readText(envFile)
  if (text !== null) {
    for (const line of text.split('\n')) {
      if (!line || line.startsWith('#')) continue
      const eq = line.indexOf('=')
      if (eq === -1) continue
      env[line.slice(0, eq).trim()] = line.slice(eq + 1)
    }
  }
  const s = await loadCentralSecrets(envFile)
  if (!s.ok) return { env, refusal: s.sentence }
  return { env: { ...env, ...s.env }, refusal: null }
}

/** `text` with the sealed secrets appended as `KEY=value` lines, IN MEMORY (for parsers of the text). */
export async function centralEnvTextWithSecrets(envFile: string, text: string): Promise<string> {
  const s = await loadCentralSecrets(envFile)
  if (!s.ok || Object.keys(s.env).length === 0) return text
  return text.replace(/\n?$/, '\n') + Object.entries(s.env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n'
}

/**
 * The first candidate central.env that exists — AFTER finishing any split a crash interrupted, so a
 * crash between the scrub and the rename (only `central.env.next` on disk) never makes
 * `agentop server --central` start without its config.
 */
export async function findCentralEnvFile(candidates: readonly string[]): Promise<string | null> {
  for (const c of candidates) await recoverCentralEnv(c)
  return candidates.find(c => existsSync(c)) ?? null
}

/** Move the plaintext secrets of `envFile` into its sealed sibling. Never throws. */
export async function migrateCentralEnvAt(envFile: string): Promise<MigrationReport> {
  const text = await readText(envFile).catch(() => null)
  if (text === null || plaintextSecretCount(text) === 0) return { migrated: 0, lines: [] }
  const n = plaintextSecretCount(text)
  try {
    await writeCentralEnv(envFile, text)
    return { migrated: n, lines: [] }
  } catch (err) {
    // A vault refusal is already the right sentence; anything else is a failed write, said as one.
    return { migrated: 0, lines: [err instanceof VaultRefusalError ? err.message : sentence('migration-failed', { file: displayPath(envFile), reason: (err as NodeJS.ErrnoException)?.code ?? 'write failed' })] }
  }
}

registerVaultMigrator({
  id: 'central-env',
  async pending() {
    const t = await readText(STANDALONE_CENTRAL_ENV).catch(() => null)
    return t ? plaintextSecretCount(t) : 0
  },
  async pendingFiles() {
    const t = await readText(STANDALONE_CENTRAL_ENV).catch(() => null)
    return t && plaintextSecretCount(t) > 0 ? [STANDALONE_CENTRAL_ENV] : []
  },
  run: () => migrateCentralEnvAt(STANDALONE_CENTRAL_ENV),
})

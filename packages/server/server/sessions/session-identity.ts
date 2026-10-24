/**
 * session-identity.ts — a session agentop started can PROVE which session it is.
 *
 * Why it exists: an Agentask comment's `author` is free text ("claude:3f5f"), so before this a session
 * could post as any other one — and a thread's 1:N reply is delivered to the sessions that posted in
 * it, so a mis-attributed poster would pull ANOTHER session into a thread and have the owner's words
 * typed into it. The participant list is built only from identities the server can check.
 *
 * How: every pane agentop spawns carries `AGENTOP_MANAGED_ID` (the managed id; not a secret — it is
 * on every fleet row). The agentistics MCP, running inside that pane, derives a proof
 * `HMAC-SHA256(key, "agentop-session:" + id)` from a 32-byte key in `session-identity.key` (0600, in
 * the data dir) and sends both with a comment; the server recomputes and compares in constant time.
 * NO TOKEN TRAVELS ON A COMMAND LINE: tmux `-e` is visible in `ps`, so the proof is computed where it
 * is used, from a file only this user can read.
 *
 * Stated limit, and it is the whole of it: this stops MIS-ATTRIBUTION (a free-text author, a wrong
 * handle, a copied comment) — it is not a wall between processes of the same user, who can read the
 * key file exactly as the MCP does. A process that can read the owner's data dir can already do
 * anything the owner can. A session started before this existed, or a harness whose MCP does not
 * send the proof, posts UNVERIFIED: its comment keeps its `author` and it never joins a thread.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { AGENTISTICS_DATA_DIR } from '../config'
import { RELAY_FILES } from './structured-relay'

/** The variable every agentop pane carries (set by the tmux backend at spawn). */
export const SESSION_ID_ENV = 'AGENTOP_MANAGED_ID'
export const SESSION_IDENTITY_KEY_FILE = join(AGENTISTICS_DATA_DIR, 'session-identity.key')

let keyMemo: Buffer | null = null

/** Pure: the proof for `id` under `key`. The MCP computes the very same string. */
export function sessionToken(key: Uint8Array, id: string): string {
  return createHmac('sha256', key).update(`agentop-session:${id}`).digest('hex')
}

/** Pure: does `token` prove `id` under `key`? Constant-time; a malformed token is simply false. */
export function tokenProves(key: Uint8Array, id: string, token: string): boolean {
  if (!id || !/^[0-9a-f]{64}$/.test(token)) return false
  const want = Buffer.from(sessionToken(key, id), 'hex')
  const got = Buffer.from(token, 'hex')
  return want.length === got.length && timingSafeEqual(want, got)
}

async function loadKey(create: boolean, file = SESSION_IDENTITY_KEY_FILE): Promise<Buffer | null> {
  if (keyMemo) return keyMemo
  try {
    const raw = Buffer.from((await readFile(file, 'utf8')).trim(), 'hex')
    if (raw.length === 32) return (keyMemo = raw)
  } catch { /* absent — created below when asked to */ }
  if (!create) return null
  const key = randomBytes(32)
  await mkdir(dirname(file), { recursive: true })
  // `wx`: two processes racing to create it must not overwrite each other's key — the loser reads.
  try {
    await writeFile(file, key.toString('hex'), { mode: 0o600, flag: 'wx' })
    await chmod(file, 0o600).catch(() => {})
    return (keyMemo = key)
  } catch {
    keyMemo = null
    return loadKey(false, file)
  }
}

/** Make sure the key exists before a session that could need it is spawned. Never throws. */
export async function ensureSessionIdentityKey(): Promise<void> {
  await loadKey(true).catch(() => null)
}

/**
 * Does THIS process claim to run as session `id`? True when the identity key exists and `id` is the
 * pane's own `AGENTOP_MANAGED_ID`. Used by the CLI spawn path, which has no HTTP body to carry a proof.
 *
 * ACCEPTED RISK, stated plainly: this is NOT a cryptographic proof. The token is derived from the key right
 * here, so the HMAC check is always true once the key exists; the only real test is the environment variable.
 * Any same-user process can forge it by exporting `AGENTOP_MANAGED_ID=<id of a registered leader>` — no key
 * needed. We accept that: the origin it affects is a display attribution, not a security boundary.
 */
export async function callerHoldsIdentity(id: string | undefined, env: Record<string, string | undefined> = process.env): Promise<boolean> {
  if (!id || env[SESSION_ID_ENV] !== id) return false
  const key = await loadKey(false).catch(() => null)
  return !!key && tokenProves(key, id, sessionToken(key, id))
}

/** Is this claimed identity real? Never creates a key: no key means no session could ever prove one. */
export async function verifySessionIdentity(id: unknown, token: unknown): Promise<string | null> {
  if (typeof id !== 'string' || typeof token !== 'string') return null
  const key = await loadKey(false).catch(() => null)
  return key && tokenProves(key, id, token) ? id : null
}

/** Pure: the ancestor chain (self first) of `startPid`, given a way to read a parent pid. Bounded; stops at pid 1. */
export function ancestorChainBy(startPid: number, parentOf: (pid: number) => number | undefined): number[] {
  const out: number[] = []
  let pid = startPid
  for (let depth = 0; depth < 32 && pid > 1 && !out.includes(pid); depth++) {
    out.push(pid)
    const next = parentOf(pid)
    if (next === undefined || !Number.isInteger(next)) break
    pid = next
  }
  return out
}

/** Pure: the same chain read from `/proc/<pid>/status` `PPid:`. */
export function ancestorChain(startPid: number, readStatus: (pid: number) => string | undefined): number[] {
  return ancestorChainBy(startPid, pid => {
    const m = /^PPid:\s*(\d+)/m.exec(readStatus(pid) ?? '')
    return m ? Number(m[1]) : undefined
  })
}

/** Parent pid from `/proc` (Linux) or, where there is none (macOS/BSD), `ps -o ppid= -p <pid>` — argv, never a shell. */
const parentOfDefault = (pid: number): number | undefined => {
  try {
    if (existsSync('/proc/self/status')) {
      const m = /^PPid:\s*(\d+)/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))
      return m ? Number(m[1]) : undefined
    }
    const r = spawnSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 })
    const n = Number(String(r.stdout ?? '').trim())
    return r.status === 0 && Number.isInteger(n) && n > 0 ? n : undefined
  } catch { return undefined }
}

/**
 * The processes agentop recorded for a session with NO tmux pane (web-started adapter-chat / structured
 * driver): its relay and the harness child it holds, from `<data dir>/structured/<id>/relay.pid`. The
 * harness (and the MCP / CLI it runs) descends from the child, so either is a valid ancestor anchor.
 */
export function managedProcessPids(id: string, root = join(AGENTISTICS_DATA_DIR, 'structured')): number[] {
  try {
    const raw = JSON.parse(readFileSync(join(root, id.replace(/[^A-Za-z0-9._-]/g, '_'), RELAY_FILES.pid), 'utf8')) as { relay?: unknown; child?: unknown }
    return [raw.relay, raw.child].filter((p): p is number => typeof p === 'number' && p > 1)
  } catch { return [] }
}

/** Why a caller is (not) proven: `unavailable` = this platform gave no way to read ancestors, not a bad identity. */
export type CallerProof = 'proven' | 'bad-identity' | 'unavailable'

export async function callerProof(
  id: string | undefined,
  panePids: () => Promise<ReadonlyMap<string, number> | undefined>,
  opts: { env?: Record<string, string | undefined>; pid?: number; parentOf?: (pid: number) => number | undefined; managedPids?: (id: string) => number[] } = {},
): Promise<CallerProof> {
  if (!id || !(await callerHoldsIdentity(id, opts.env))) return 'bad-identity'
  const pane = (await panePids().catch(() => undefined))?.get(id)
  const anchors = [...(pane ? [pane] : []), ...(opts.managedPids ?? managedProcessPids)(id)]
  if (anchors.length === 0) return 'bad-identity'
  const chain = ancestorChainBy(opts.pid ?? process.pid, opts.parentOf ?? parentOfDefault)
  if (chain.length < 2 && !anchors.includes(chain[0]!)) return 'unavailable'
  return anchors.some(a => chain.includes(a)) ? 'proven' : 'bad-identity'
}

/**
 * The CLI's proof that it runs INSIDE session `id`: the environment claim (`callerHoldsIdentity`, which an
 * outside process can forge by exporting the variable) AND a process agentop itself created for `id` — its tmux
 * pane, or the relay/child of a structured session — being an ANCESTOR of this process.
 */
export async function callerRunsInSession(
  id: string | undefined,
  panePids: () => Promise<ReadonlyMap<string, number> | undefined>,
  opts: { env?: Record<string, string | undefined>; pid?: number; readStatus?: (pid: number) => string | undefined; parentOf?: (pid: number) => number | undefined; managedPids?: (id: string) => number[] } = {},
): Promise<boolean> {
  const parentOf = opts.parentOf ?? (opts.readStatus ? (pid: number) => { const m = /^PPid:\s*(\d+)/m.exec(opts.readStatus!(pid) ?? ''); return m ? Number(m[1]) : undefined } : undefined)
  return (await callerProof(id, panePids, { ...opts, ...(parentOf ? { parentOf } : {}) })) === 'proven'
}

/**
 * Pure: which session's process (`anchors`: managed id → the pids agentop created for it — its tmux
 * pane, a structured session's relay/child) is an ANCESTOR of the process whose chain is `chain`
 * (self first). The NEAREST ancestor wins, so a session started inside another's pane is answered as
 * itself. `undefined` when none is.
 */
export function sessionOwningChain(chain: readonly number[], anchors: ReadonlyMap<string, readonly number[]>): string | undefined {
  for (const pid of chain) {
    for (const [id, pids] of anchors) if (pids.includes(pid)) return id
  }
  return undefined
}

/**
 * The session this process runs inside, found from the PROCESS TREE rather than the environment —
 * for a spawn whose `AGENTOP_MANAGED_ID` was lost (`env -u`, a wrapper script, a harness that filters
 * its children's environment). The tree is the same proof `callerProof` demands, so a session found
 * here is as verified as one named by the variable. Never throws.
 */
export async function callerSessionFromTree(
  panePids: () => Promise<ReadonlyMap<string, number> | undefined>,
  registryIds: () => Promise<readonly string[]>,
  opts: { pid?: number; parentOf?: (pid: number) => number | undefined; managedPids?: (id: string) => number[] } = {},
): Promise<string | undefined> {
  try {
    const anchors = new Map<string, number[]>()
    for (const [id, pid] of (await panePids().catch(() => undefined)) ?? []) anchors.set(id, [pid])
    for (const id of await registryIds().catch(() => [] as string[])) {
      const extra = (opts.managedPids ?? managedProcessPids)(id)
      if (extra.length) anchors.set(id, [...(anchors.get(id) ?? []), ...extra])
    }
    if (anchors.size === 0) return undefined
    return sessionOwningChain(ancestorChainBy(opts.pid ?? process.pid, opts.parentOf ?? parentOfDefault), anchors)
  } catch { return undefined }
}

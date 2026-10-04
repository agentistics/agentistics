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
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { AGENTISTICS_DATA_DIR } from '../config'

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

/** Is this claimed identity real? Never creates a key: no key means no session could ever prove one. */
export async function verifySessionIdentity(id: unknown, token: unknown): Promise<string | null> {
  if (typeof id !== 'string' || typeof token !== 'string') return null
  const key = await loadKey(false).catch(() => null)
  return key && tokenProves(key, id, token) ? id : null
}

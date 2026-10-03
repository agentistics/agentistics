/**
 * vault/prefs-tokens.ts — the central tokens move OUT of `preferences.json` (S3/S4).
 *
 * `preferences.json` is a served file (`GET /api/preferences`, redacted) and a backed-up one
 * (redacted again), which makes it the wrong home for a secret, sealed or not. So the tokens live in
 * ONE sealed map beside it — `connections/tokens.sealed`, purpose `central-token`, `{connId: token}`
 * (`team.token` is only ever the first connection's mirror, so it is stored under that connection's
 * id) — and the preferences file carries a non-secret `hasToken: true` per connection, so the UI can
 * show a connection as connected while the vault is locked.
 *
 * This module is the seam `preferences.ts` calls at its two choke points:
 *  - after PARSING a file: put the tokens back into the in-memory shape (`injectSealedTokens`);
 *  - before WRITING one: take them out and seal them (`stripAndSealTokens`).
 * Every caller of `readPreferences()` keeps seeing `connections[].token` exactly as before.
 *
 * Ordering of a write (spec §3.3): write + VERIFY the sealed map first, then the preferences file
 * without the tokens. A crash between the two leaves the tokens in both places — the next pass
 * finds them sealed and equal and only rewrites the preferences file. Never the other way round: a
 * preferences file stripped before its tokens were safely sealed would lose them.
 *
 * With the vault unable to open: a write that carries a NEW token REFUSES (never plain text); a write
 * whose tokens are unchanged leaves the sealed map untouched and keeps `hasToken`, so a locked
 * machine can still save its other preferences without losing its connections.
 */
import { join, dirname } from 'node:path'
import { bytesEqual } from '@agentistics/vault'
import {
  ensureVaultOpen, notOpenRefusal, openFromFile, refusal, sealToFile, secretFs, vaultIsOpen, vaultRole,
} from './service'

export const TOKENS_PURPOSE = 'central-token'
export const TOKENS_NAME = 'tokens'

/** `<dir of preferences.json>/connections/tokens.sealed`. */
export function tokensFileFor(prefsFile: string): string {
  return join(dirname(prefsFile), 'connections', 'tokens.sealed')
}

type Raw = Record<string, unknown>
type RawConn = Record<string, unknown>

/**
 * Connection ids REMOVED while their sealed token could not be deleted (the vault was not open).
 * Kept as a top-level, non-secret list in preferences.json so a token can never come back from the
 * dead: an id re-added later is never handed its old token, and the next write with the vault open
 * deletes those entries from the map and clears the list.
 */
export const TOMBSTONES_KEY = 'sealedTokenTombstones'

function tombstonesOf(raw: Raw | null | undefined): Set<string> {
  const t = raw?.[TOMBSTONES_KEY]
  return new Set(Array.isArray(t) ? t.filter((x): x is string => typeof x === 'string') : [])
}

/** PURE. Every plaintext token value a parsed file holds (connections and the flat mirror). */
function plaintextValues(raw: Raw | null | undefined): Set<string> {
  const out = new Set<string>()
  const team = raw?.team as Raw | undefined
  if (typeof team?.token === 'string' && team.token) out.add(team.token)
  for (const c of connsOf(raw)) if (typeof c.token === 'string' && c.token) out.add(c.token)
  return out
}

function connsOf(raw: Raw | null | undefined): RawConn[] {
  const team = raw?.team as Raw | undefined
  const c = team?.connections
  return Array.isArray(c) ? c.filter((x): x is RawConn => !!x && typeof x === 'object') : []
}

/** PURE. Does this parsed file still hold a token in plain text (an earlier version wrote it)? */
export function plaintextTokenCount(raw: Raw | null | undefined): number {
  if (!raw) return 0
  const team = raw.team as Raw | undefined
  let n = typeof team?.token === 'string' && team.token !== '' ? 1 : 0
  for (const c of connsOf(raw)) if (typeof c.token === 'string' && c.token !== '') n++
  return n
}

/** PURE. A copy with every token field removed (S4's in-place scrub; the rest is left alone). */
export function withoutTokenFields(raw: Raw): Raw {
  const team = raw.team as Raw | undefined
  if (!team || typeof team !== 'object') return { ...raw }
  const { token: _t, ...teamRest } = team
  const connections = Array.isArray(team.connections)
    ? (team.connections as unknown[]).map(c => {
        if (!c || typeof c !== 'object') return c
        const { token, ...rest } = c as RawConn
        return typeof token === 'string' && token !== '' ? { ...rest, hasToken: true } : rest
      })
    : team.connections
  return { ...raw, team: { ...teamRest, ...(connections !== undefined ? { connections } : {}) } }
}

interface TokenMap { v: 1; tokens: Record<string, string> }

function parseMap(bytes: Uint8Array): Record<string, string> | null {
  try {
    const o = JSON.parse(new TextDecoder().decode(bytes)) as Partial<TokenMap>
    if (o.v !== 1 || !o.tokens || typeof o.tokens !== 'object') return null
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(o.tokens)) if (typeof v === 'string' && v !== '') out[k] = v
    return out
  } catch { return null }
}

type MapRead = { ok: true; map: Record<string, string> } | { ok: false; absent: boolean }

async function readMap(prefsFile: string): Promise<MapRead> {
  const r = await openFromFile(tokensFileFor(prefsFile), TOKENS_PURPOSE, TOKENS_NAME)
  if (r.ok) {
    const map = parseMap(r.plaintext)
    return map ? { ok: true, map } : { ok: false, absent: false }
  }
  return { ok: false, absent: r.absent }
}

/**
 * Put the sealed tokens back into a parsed preferences object (mutates a COPY). Touches the vault
 * only when the file says a connection has a sealed token. A connection whose token cannot be read
 * (vault locked) keeps an empty token — every consumer already treats that as "no token here".
 */
export async function injectSealedTokens<T>(prefsFile: string, parsed: T): Promise<T> {
  const raw = parsed as unknown as Raw
  const conns = connsOf(raw)
  const empty = (c: RawConn) => !(typeof c.token === 'string' && c.token !== '')
  if (!conns.some(empty)) return parsed
  // `hasToken` is a HINT, never the authority: an older agentop rewriting this file drops unknown
  // fields, so a connection can lose its flag while its token sits safely in the sealed map. The
  // map is consulted whenever it exists.
  const flagged = conns.some(c => empty(c) && c.hasToken === true)
  if (!flagged && !(await secretFs().lstat(tokensFileFor(prefsFile)))) return parsed
  await ensureVaultOpen({ create: false })
  const m = await readMap(prefsFile)
  if (!m.ok) return parsed
  const team = raw.team as Raw
  const dead = tombstonesOf(raw)
  const connections = (team.connections as unknown[]).map(c => {
    if (!c || typeof c !== 'object') return c
    const rc = c as RawConn
    const id = typeof rc.id === 'string' ? rc.id : ''
    if (empty(rc) && m.map[id] && !dead.has(id)) return { ...rc, token: m.map[id], hasToken: true }
    return rc
  })
  return { ...raw, team: { ...team, connections } } as unknown as T
}

/**
 * Take the tokens out of `next` (the full object about to be written) and seal them; return the
 * object to write. `previous` is the file as it was on disk (its `hasToken` flags say which
 * connections already have a sealed token that an empty in-memory token must NOT erase).
 *
 * THROWS the vault's `VaultRefusalError` when a token must be sealed and cannot be.
 */
export async function stripAndSealTokens(prefsFile: string, next: Raw, previous: Raw | null): Promise<Raw> {
  const conns = connsOf(next)
  const desired: Record<string, string> = {}
  for (const c of conns) {
    const id = typeof c.id === 'string' ? c.id : ''
    if (id && typeof c.token === 'string' && c.token !== '') desired[id] = c.token
  }
  const prevSealed = new Set(connsOf(previous).filter(c => c.hasToken === true && typeof c.id === 'string').map(c => c.id as string))
  const liveIds = new Set(conns.map(c => (typeof c.id === 'string' ? c.id : '')).filter(Boolean))
  const hasTokenIds = new Set<string>([...Object.keys(desired), ...[...prevSealed].filter(id => liveIds.has(id))])

  const tokensFile = tokensFileFor(prefsFile)
  const mapExists = (await secretFs().lstat(tokensFile)) !== null
  // Connections that existed on disk and are gone from this write: their sealed token is deleted IN
  // THIS WRITE (vault open), or tombstoned until it can be (vault not open).
  const removed = connsOf(previous).map(c => (typeof c.id === 'string' ? c.id : '')).filter(id => id && !liveIds.has(id))
  const tombstones = new Set<string>([...tombstonesOf(previous), ...(mapExists ? removed : [])])
  for (const id of Object.keys(desired)) tombstones.delete(id)
  const needsWrite = Object.keys(desired).length > 0 || mapExists

  // SECRETS.4 §5.2: a process that is not the service never opens the vault to read the old map
  // back — the whole token half of this write is done BY the service (`prefs-tokens` op), which
  // seals, verifies and returns the object with every token removed.
  let serviceDown = false
  if (needsWrite && vaultRole() !== 'holder') {
    const remote = await (await import('./client')).remotePrefsTokens(prefsFile, next, previous)
    if (remote) return remote
    serviceDown = true
  }

  if (needsWrite) {
    // A vault is CREATED here only to seal a token; merely keeping an existing map never creates one.
    const opened = serviceDown ? false : vaultIsOpen() ? true : (await ensureVaultOpen({ create: Object.keys(desired).length > 0, migrate: false })) !== null
    if (!opened) {
      // Tokens an EARLIER version already left on disk in plain text are not new: refusing every
      // preferences write over them would break the language toggle on a machine with no protector.
      // Those are written back exactly as they were (still pending migration, still reported);
      // only a NEW or CHANGED token is refused — Agentistics never writes a new plaintext secret.
      const onDisk = plaintextValues(previous)
      const fresh = Object.values(desired).filter(v => !onDisk.has(v))
      if (fresh.length > 0) throw serviceDown ? refusal('service-down') : await notOpenRefusal()
      if (Object.keys(desired).length > 0) {
        const out: Raw = { ...next }
        if (tombstones.size > 0) out[TOMBSTONES_KEY] = [...tombstones].sort()
        else delete out[TOMBSTONES_KEY]
        return out
      }
    } else {
      const old = mapExists ? await readMap(prefsFile) : { ok: true as const, map: {} as Record<string, string> }
      if (!old.ok && !old.absent) {
        // The existing map does not open (tampered / another machine). It is NEVER rewritten or
        // deleted — that would destroy the evidence and any token it holds. A new token is refused;
        // anything else is written with the map left exactly as it is.
        if (Object.keys(desired).length > 0) throw refusal('tampered', { file: tokensFile, restoreWith: 'agentop member connect <url> <token>' })
        return finishStrip(next, hasTokenIds, tombstones)
      }
      const base = old.ok ? old.map : {}
      const map: Record<string, string> = {}
      for (const id of liveIds) {
        if (desired[id]) map[id] = desired[id]!
        // Kept whenever the connection is still live and carries no new token — with or WITHOUT its
        // `hasToken` flag (downgrade safety: an older binary may have dropped the flag) — but never a
        // tombstoned one: a removed connection's token does not come back with its id.
        else if (base[id] && !tombstones.has(id)) map[id] = base[id]!
      }
      const same = old.ok && JSON.stringify(Object.entries(base).sort()) === JSON.stringify(Object.entries(map).sort())
      if (!same) {
        if (Object.keys(map).length === 0) {
          await secretFs().unlink(tokensFile)
        } else {
          const body = new TextEncoder().encode(JSON.stringify({ v: 1, tokens: map } satisfies TokenMap))
          await sealToFile(tokensFile, TOKENS_PURPOSE, TOKENS_NAME, body)
          // Verify from disk before the preferences file loses its copy.
          const back = await readMap(prefsFile)
          if (!back.ok || !bytesEqual(new TextEncoder().encode(JSON.stringify(Object.entries(back.map).sort())), new TextEncoder().encode(JSON.stringify(Object.entries(map).sort())))) {
            throw refusal('migration-failed', { file: tokensFile, reason: 'the sealed tokens did not read back equal' })
          }
        }
      }
      for (const id of [...hasTokenIds]) if (!map[id]) hasTokenIds.delete(id)
      for (const id of Object.keys(map)) hasTokenIds.add(id)
      tombstones.clear() // the map no longer holds any of them
    }
  }
  return finishStrip(next, hasTokenIds, tombstones)
}

function finishStrip(next: Raw, hasTokenIds: Set<string>, tombstones: Set<string> = new Set()): Raw {
  const stripped = withoutTokenFields(next)
  if (tombstones.size > 0) stripped[TOMBSTONES_KEY] = [...tombstones].sort()
  else delete stripped[TOMBSTONES_KEY]
  for (const id of tombstones) hasTokenIds.delete(id)
  const team = stripped.team as Raw | undefined
  if (team && Array.isArray(team.connections)) {
    team.connections = (team.connections as unknown[]).map(c => {
      if (!c || typeof c !== 'object') return c
      const { hasToken: _h, ...rest } = c as RawConn
      const id = typeof rest.id === 'string' ? rest.id : ''
      return hasTokenIds.has(id) ? { ...rest, hasToken: true } : rest
    })
  }
  return stripped
}

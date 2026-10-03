/**
 * viewed-file.ts — PURE: may the gallery's "viewed by the session" tile be served?
 *
 * A VIEWED file is one the session opened with `Read`, wherever it lives — so no directory contains
 * it, and the attachments route (inside `~/.agentistics/attachments/`) and the artifacts route
 * (files the session WROTE, inside its cwd) both refused it: the tile said "no longer on disk" for a
 * file that was right there. This route admits a path on exactly one ground — THIS session's own
 * transcript named it (a `Read`, or a write the artifacts allowlist already knows) — and then
 * refuses on everything else a media reader must never serve:
 *
 *  - the request is matched on the REAL path (symlinks followed) against the transcript's own
 *    paths, each held in both forms, so a link planted after the fact cannot redirect a name the
 *    transcript used to some other file;
 *  - the REAL file must be an image, video or PDF by ITS extension as well as the name's (a
 *    `shot.png` that is a link to `notes.txt` is refused);
 *  - agentop's vault, anything sealed, and key material are refused by path, whatever the session
 *    read — a session that Read a secret must not turn the gallery into a way to look at it.
 */

import { sep } from 'node:path'
import { extensionOf, mediaTypeFor, type MediaType } from './artifact-media'

export type ViewedRefusal = 'not-in-transcript' | 'wrong-type' | 'forbidden'

export type ViewedPlan =
  | { ok: true; path: string; type: MediaType }
  | { ok: false; reason: ViewedRefusal }

export interface ViewedAllowed {
  /** Where the transcript NAMED it, resolved lexically. */
  named: string
  /** Where it actually is, every link followed. */
  real: string
}

const KEY_EXT = new Set(['sealed', 'pem', 'key', 'p12', 'pfx', 'keystore', 'kdbx', 'asc', 'gpg', 'ppk'])
const KEY_NAME = /(^|\/)(id_(rsa|dsa|ecdsa|ed25519)|\.env(\..*)?|\.npmrc|\.netrc|credentials(\.json)?|\.credentials\.json)$/i

/** Paths that are never served, whatever the session read. `dataDir` is agentop's own directory. */
export function forbiddenPath(real: string, dataDir: string): boolean {
  const base = dataDir.endsWith(sep) ? dataDir : dataDir + sep
  if (real.startsWith(`${base}vault${sep}`) || real === `${base}vault`) return true
  if (KEY_EXT.has(extensionOf(real))) return true
  return KEY_NAME.test(real) || /(^|\/)\.ssh\//.test(real) || /(^|\/)\.gnupg\//.test(real)
}

export function planViewedRead(req: {
  /** The already-resolved (`realpath`) absolute path being asked for. */
  path: string
  /** The path as the query named it, before resolution — its extension must be media too. */
  asked: string
  allowed: readonly ViewedAllowed[]
  dataDir: string
}): ViewedPlan {
  const hit = req.path === '' ? undefined : req.allowed.find(a => a.real === req.path)
  if (!hit) return { ok: false, reason: 'not-in-transcript' }
  if (forbiddenPath(req.path, req.dataDir) || forbiddenPath(hit.named, req.dataDir)) {
    return { ok: false, reason: 'forbidden' }
  }
  const type = mediaTypeFor(req.path)
  if (!type || !mediaTypeFor(hit.named) || !mediaTypeFor(req.asked)) return { ok: false, reason: 'wrong-type' }
  return { ok: true, path: req.path, type }
}

/** PURE: the files a transcript's `Read` calls opened (shared vocabulary, `canonical ?? name`). */
export function readPathsFromTurns(
  turns: readonly { tools?: { name: string; canonical?: string; detail?: string }[] }[],
): string[] {
  const out = new Set<string>()
  for (const t of turns) {
    for (const call of t?.tools ?? []) {
      if ((call.canonical ?? call.name) !== 'Read') continue
      const p = call.detail?.trim()
      // A truncated detail names no file; admitting it would allow a path that resolves elsewhere.
      if (p && !p.endsWith('…')) out.add(p)
    }
  }
  return [...out]
}

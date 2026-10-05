/**
 * git-fs.ts — FINGERPRINTS of a repository's state, read off its `.git` by the filesystem, so the
 * answers `git.ts` spawns for can be REUSED until the thing they depend on changes.
 *
 * Why (the rebuild storm, v2.103.1): every `/api/data` build asked git, per project, for
 * `rev-parse HEAD` and `config --get remote.origin.url` — two processes × ~280 projects, on a build
 * that ran every ~2 s while ten sessions wrote. Both answers are pure functions of a few small files:
 * HEAD of `HEAD` and the ref it names (loose or packed), the remote of the `config` file(s). Reading
 * those costs a few `stat`s and two tiny reads, and comparing them says EXACTLY whether git would
 * now answer differently.
 *
 * The fingerprint is only a VALIDATOR. git stays the one that answers (its ownership checks, its
 * includes, its every rule): a fingerprint that cannot be taken — Windows, a bare repo, an unknown
 * layout, an `[include]` in the config, the reftable format — returns `null`, and the caller spawns
 * exactly as it did before and caches nothing.
 */
import { readFile, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'

export interface GitDirs { gitDir: string; commonDir: string }

/** Where the repository holding `path` keeps its state, or null when no `.git` is found going up. */
export async function findGitDirs(path: string): Promise<GitDirs | null> {
  if (process.platform === 'win32') return null
  let dir = resolve(path)
  for (let i = 0; i < 64; i++) {
    const dotGit = join(dir, '.git')
    const st = await stat(dotGit).catch(() => null)
    if (st?.isDirectory()) return withCommon(dotGit)
    if (st?.isFile()) {
      // A linked worktree (or a submodule): `.git` is a file naming the real git dir.
      const m = /^gitdir:\s*(.+?)\s*$/m.exec(await readFile(dotGit, 'utf8').catch(() => ''))
      if (!m) return null
      return withCommon(isAbsolute(m[1]!) ? m[1]! : resolve(dir, m[1]!))
    }
    const up = dirname(dir)
    if (up === dir) return null
    dir = up
  }
  return null
}

async function withCommon(gitDir: string): Promise<GitDirs> {
  const rel = (await readFile(join(gitDir, 'commondir'), 'utf8').catch(() => '')).trim()
  return { gitDir, commonDir: rel ? (isAbsolute(rel) ? rel : resolve(gitDir, rel)) : gitDir }
}

const stamp = async (p: string): Promise<string> => {
  const st = await stat(p).catch(() => null)
  return st ? `${st.mtimeMs}:${st.size}` : '-'
}

/** What `rev-parse HEAD` depends on: HEAD itself, the ref it names, and `packed-refs`. */
export async function headFingerprint(d: GitDirs): Promise<string | null> {
  const head = (await readFile(join(d.gitDir, 'HEAD'), 'utf8').catch(() => null))?.trim()
  if (!head) return null
  const st = await stat(join(d.commonDir, 'reftable')).catch(() => null)
  if (st) return null // reftable: refs are not files; let git answer
  if (!head.startsWith('ref:')) return `detached ${head}` // the SHA itself
  const ref = head.slice(4).trim()
  if (!/^refs\/[\w./-]+$/.test(ref) || ref.includes('..')) return null
  // A worktree's per-worktree refs live in its own dir, branches in the common one; read both.
  const [own, common] = await Promise.all([
    readFile(join(d.gitDir, ref), 'utf8').catch(() => ''),
    d.commonDir === d.gitDir ? Promise.resolve('') : readFile(join(d.commonDir, ref), 'utf8').catch(() => ''),
  ])
  return `${ref} ${own.trim()} ${common.trim()} ${await stamp(join(d.commonDir, 'packed-refs'))}`
}

/** What `config --get remote.origin.url` depends on: the repo's config (and a worktree's own). */
export async function configFingerprint(d: GitDirs): Promise<string | null> {
  const cfg = await readFile(join(d.commonDir, 'config'), 'utf8').catch(() => null)
  if (cfg === null) return null
  // An include can pull the remote from anywhere; a fingerprint of this file would not see it change.
  if (/^\s*\[include/im.test(cfg)) return null
  return `${cfg.length}:${hash(cfg)} ${await stamp(join(d.gitDir, 'config.worktree'))}`
}

function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}

/**
 * A memo whose entries hold while their fingerprint does. `get` returns the remembered value only
 * when the fingerprint taken NOW equals the one it was stored under; a null fingerprint is never a
 * hit and is never stored.
 */
export function createFingerprintMemo<T>(max = 4096) {
  const m = new Map<string, { fp: string; value: T }>()
  return {
    get(key: string, fp: string | null): { hit: true; value: T } | { hit: false } {
      if (fp === null) return { hit: false }
      const e = m.get(key)
      return e && e.fp === fp ? { hit: true, value: e.value } : { hit: false }
    },
    set(key: string, fp: string | null, value: T): void {
      if (fp === null) return
      if (m.size >= max && !m.has(key)) m.delete(m.keys().next().value as string)
      m.set(key, { fp, value })
    },
    clear: () => m.clear(),
    get size() { return m.size },
  }
}

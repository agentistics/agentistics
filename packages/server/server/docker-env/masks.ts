/**
 * DOCKER.AMBIENTES S2 — what of the worktree a container must NOT see, recomputed for EVERY container
 * (SPEC-r3 §5.2). PURE: the IO side lists the worktree's untracked + ignored entries (outside `node_modules`) and
 * hands over the first bytes of each small text file; this decides the masks.
 *
 * Trust boundary, written: the user's files OUTSIDE the worktree never enter (nothing of HOME, `~/.npmrc`,
 * `~/.ssh` or the global git config is mounted — structural). Inside the worktree it is the repo's; credentials
 * there get a best-effort mask. A VERSIONED secret is repo content and is not masked. Limit: a file created during
 * a running command is visible to that command; the next command masks it.
 */
import type { MountSpec } from './docker-argv'

export interface WorktreeEntry {
  /** Path relative to the worktree root, `/`-separated. */
  path: string
  /** The first ≤ 64 KiB, when it is a small regular text file; absent otherwise. */
  head?: string
}

export const MASK_TEXT_LIMIT = 64 * 1024

const NAME_RULES: RegExp[] = [
  /^\.env(\..+)?$/, /^\.npmrc$/, /^\.yarnrc(\..+)?$/, /^\.pypirc$/, /^\.netrc$/, /^\.git-credentials$/,
  /\.pem$/, /\.key$/, /\.p12$/, /^id_[^/]*$/, /\.sealed$/, /^credentials[^/]*\.json$/, /^service-account[^/]*\.json$/,
]
const EXAMPLE = /^\.env\.(example|sample)$/
const DIR_RULES = new Set(['.aws', '.ssh'])
const CONTENT_RULES: RegExp[] = [/_authToken/, /npmAuthToken/, /BEGIN [A-Z ]*PRIVATE KEY/, /https?:\/\/[^/@\s]+:[^/@\s]+@/]

export const inNodeModules = (path: string): boolean => path.split('/').includes('node_modules')

/** Should this one file be masked? Exposed for the tests and the status report. */
export function maskReason(e: WorktreeEntry): string | null {
  const base = e.path.split('/').pop() ?? e.path
  if (EXAMPLE.test(base)) return null
  if (NAME_RULES.some(r => r.test(base))) return `name ${base}`
  if (e.head !== undefined && e.head.length <= MASK_TEXT_LIMIT && CONTENT_RULES.some(r => r.test(e.head!))) return 'credential-shaped content'
  return null
}

/**
 * The masks for one container: a file becomes `/dev/null` (read-only), a `.aws`/`.ssh` directory an empty
 * read-only tmpfs, and a `.git` DIRECTORY in the tree too while the image carries no git (SPEC §5.2 needs S1b):
 * without git inside, the common git dir is not mounted at all, so nothing of it (FETCH_HEAD, modules, other
 * worktrees, the real config) can be read.
 */
export function maskMounts(root: string, entries: readonly WorktreeEntry[], opts: { gitDirInTree?: boolean } = {}): { mounts: MountSpec[]; masked: string[] } {
  const mounts: MountSpec[] = []
  const masked: string[] = []
  const dirs = new Set<string>()
  const abs = (p: string) => `${root.replace(/\/+$/, '')}/${p}`
  for (const e of entries) {
    if (inNodeModules(e.path)) continue
    const segs = e.path.split('/')
    const dirAt = segs.findIndex((s, i) => i < segs.length - 1 && DIR_RULES.has(s))
    if (dirAt >= 0) { dirs.add(segs.slice(0, dirAt + 1).join('/')); continue }
    if (DIR_RULES.has(segs[segs.length - 1]!)) { dirs.add(e.path); continue }
    if (maskReason(e)) { mounts.push({ type: 'bind', source: '/dev/null', target: abs(e.path), readonly: true }); masked.push(e.path) }
  }
  if (opts.gitDirInTree) dirs.add('.git')
  for (const d of [...dirs].sort()) { mounts.push({ type: 'tmpfs', target: abs(d), readonly: true }); masked.push(`${d}/`) }
  return { mounts, masked }
}

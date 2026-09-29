/**
 * policy/floor.ts — the DENY FLOOR: circuit breakers no allow rule lifts (D-T3, Claude Code's
 * "protected paths" idea). A rule a person wrote at 2 a.m. to stop being asked about `rm` must not
 * be the thing that lets `rm -rf ~` through, so these are checked BEFORE any rule, and a hit is a
 * denial with `policy: floor:<name>` whatever the layers say.
 *
 * | name                     | what it refuses                                                      | why |
 * |--------------------------|----------------------------------------------------------------------|-----|
 * | `git-internals`          | a WRITE into any `.git/` directory (or a `.git` file) — a file tool's write, a redirection, a path a shell command NAMES unless the command only reads it (F2), a recursive `rm`/`chmod` there, and `git config --file` into one | the object store and refs are the undo history, and `hooks/` + `config` are code git will EXECUTE |
 * | `credential-store`       | reading OR writing `~/.ssh/**`, `~/.aws/credentials`, `~/.config/gh/hosts.yml`, `~/.netrc`, `~/.git-credentials`, `*.key` under `~/.claude`, the WHOLE agentistics data directory (`~/.agentistics/**` and a host-relocated `agentisticsDir` — the runtime's own key store, the envelope keypair, tokens, captures), and `.env`/`.env.*` files OUTSIDE the workspace | a credential read into a model's context has left the machine |
 * | `protected-path`         | reading or writing a glob the host passed as `protectedPaths`         | the host's own list of the same kind |
 * | `rm-recursive`           | a recursive `rm` (any spelling: `-rf`, `-fr`, `-r -f`, `-R`, `--recursive`, with or without force) whose target is `/`, the home directory, the workspace root, anything outside the workspace (`..` climbing out included), or a glob that empties one of those; and any `--no-preserve-root` | irreversible, and the classic one-token accident |
 * | `mkfs`                   | `mkfs*`, `mke2fs`                                                     | formats a device |
 * | `dd-device`              | `dd … of=/dev/<anything but null/zero/stdout/stderr/tty/fd>`           | writes a raw device |
 * | `fork-bomb`              | `:(){ :\|:& };:` and any function that pipes itself into itself in the background | exhausts the process table |
 * | `chmod-recursive`        | `chmod`/`chown`/`chgrp -R` on `/`, the home directory or outside the workspace | permissions on a whole tree are not reversible by hand |
 * | `download-to-shell`      | a pipeline where `curl`/`wget` output reaches `sh`/`bash`/`zsh`/…, and `bash <(curl …)` / `eval "$(curl …)"` / `source <(curl …)` | runs code nobody read |
 * | `git-force-push`         | `git push --force` / `-f` / a flag cluster with `f` / a `+refspec`   | rewrites a shared history; `--force-with-lease` is NOT refused (it is the safe form) |
 *
 * A recursive `rm` whose target cannot be known (a variable, `xargs`, `find -exec … {}`, an unknown
 * `cd`) is not denied here — it is an UNLIFTABLE ASK (`rmUnknownTarget`): the policy cannot prove it
 * is harmless, and cannot prove it is not.
 *
 * PURE: every path arrives already absolute and resolved.
 */

import { isInside } from '../tools/paths.ts'
import { globMatches, type RuleEnv } from './rules.ts'
import type { ShellSegment, ShellWord } from './shell-parse.ts'

export interface FloorEnv extends RuleEnv {
  /** Extra globs (absolute, `~/`, or workspace-relative) that no command may read or write. */
  protectedPaths: readonly string[]
  /**
   * The agentistics data directory when the HOST relocated it (`AGENTISTICS_DIR`). `~/.agentistics`
   * is always floor; this adds the relocated copy.
   */
  agentisticsDir?: string
}

export interface FloorHit {
  name: string
  /** Why, for the model — names the rule. */
  sentence: string
}

function basename(p: string): string {
  const i = p.lastIndexOf('/')
  return i === -1 ? p : p.slice(i + 1)
}

function under(root: string, p: string): boolean {
  return isInside(root, p)
}

// ── The secret set (B3 security review F1, spec §8.1 D-T3.S1) ──────────────────────────────────

/**
 * Credential files under the HOME directory, as prefixes of the path relative to it. `*.key` is a
 * control-socket token under `~/.claude` (the session manager's and the daemon's).
 *
 * The agentistics data directory is NOT listed file by file: the WHOLE directory is floor
 * (`AGENTISTICS_DATA_DIRS`). It holds the runtime's own provider key store, the sealed-envelope
 * private key, the member tokens, the backup token, a central's env file and the raw provider
 * captures. A list of names would be one more place a new secret has to be remembered, and
 * `provider-secrets.lint` forbids this package from spelling the key store's name at all. Nothing
 * a model is asked to do needs to read or write agentop's own state through a tool.
 *
 * Harness credential files (each assistant's own OAuth/token file) are deliberately NOT here: that
 * same lint forbids the runtime to name them, and they are the HOST's to pass as `protectedPaths`,
 * which is floor exactly like this list.
 */
export const HOME_SECRET_PREFIXES: readonly string[] = [
  '.ssh',
  '.aws/credentials',
  '.config/gh/hosts.yml',
  '.netrc',
  '.git-credentials',
  '*.key',
]

/** The agentistics data directory's default name under HOME. A host that relocated it passes `agentisticsDir`. */
export const AGENTISTICS_DATA_DIRS: readonly string[] = ['.agentistics']

function relUnder(root: string, p: string): string | null {
  const r = root.replace(/\/$/, '')
  return p === r ? '' : p.startsWith(r + '/') ? p.slice(r.length + 1) : null
}

function isSecretPath(path: string, env: FloorEnv): boolean {
  const h = env.home.replace(/\/$/, '')
  const fromHome = relUnder(h, path)
  if (fromHome !== null) {
    for (const pre of HOME_SECRET_PREFIXES) if (pre !== '*.key' && fromHome.startsWith(pre)) return true
  }
  const dataDirs = [...AGENTISTICS_DATA_DIRS.map(d => `${h}/${d}`), ...(env.agentisticsDir ? [env.agentisticsDir.replace(/\/$/, '')] : [])]
  if (dataDirs.some(d => relUnder(d, path) !== null)) return true
  if (path.endsWith('.key') && relUnder(`${h}/.claude`, path)) return true
  return false
}

/**
 * A file INSIDE the workspace whose NAME says it holds a secret (F4, spec §8 D-T3.S4): `.env*`
 * (`.envrc` included), `*.pem`, and an ssh-key-shaped `id_<name>` with no extension (`id_rsa`,
 * `id_ed25519`; not `id_rsa.pub`, not `id_utils.ts`). Not floor — the policy ASKS, and a rule whose
 * `pathGlob` itself names such a file lifts it. Outside the workspace `.env*` stays floor.
 */
export function secretShaped(path: string): boolean {
  const b = basename(path)
  return /^\.env/.test(b) || /\.pem$/.test(b) || /^id_[^.]+$/.test(b)
}

// ── Paths ───────────────────────────────────────────────────────────────────────────────────────

/** A `.git` directory (or file) anywhere on the path. */
export function inGitDir(path: string): boolean {
  return /(^|\/)\.git(\/|$)/.test(path)
}

/** A path no read or write may touch (credentials), or no write may touch (`.git`). */
export function floorForPath(path: string, access: 'read' | 'write', env: FloorEnv): FloorHit | null {
  if (access === 'write' && inGitDir(path)) {
    return { name: 'git-internals', sentence: `Writing inside a .git directory (${path}) is refused by the policy floor (git-internals): it would corrupt the repository's history.` }
  }
  const cred = isSecretPath(path, env) || (/^\.env(\..*)?$/.test(basename(path)) && !under(env.workspaceRoot, path))
  if (cred) {
    return { name: 'credential-store', sentence: `${path} holds credentials, and reading or writing it is refused by the policy floor (credential-store).` }
  }
  for (const g of env.protectedPaths) {
    if (globMatches(g, path, env)) {
      return { name: 'protected-path', sentence: `${path} is on this machine's protected list (${g}), so the policy floor refuses to touch it.` }
    }
  }
  return null
}

// ── Commands ────────────────────────────────────────────────────────────────────────────────────

/** The fork bomb, on the RAW string: it is a function definition, which the parser leaves opaque. */
export function floorForRaw(command: string): FloorHit | null {
  const compact = command.replace(/\s+/g, '')
  const m = /([A-Za-z_:.][\w:.]*)\(\)\{(.*?)\}/.exec(compact)
  if (m) {
    const name = m[1] ?? ''
    const body = m[2] ?? ''
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (new RegExp(`${esc}\\|${esc}&?`).test(body) || new RegExp(`${esc}&`).test(body)) {
      return { name: 'fork-bomb', sentence: 'This command defines a function that calls itself in the background (a fork bomb), which the policy floor refuses (fork-bomb).' }
    }
  }
  return null
}

export interface RmPlan {
  /** The words naming what rm would remove (options removed). */
  operands: ShellWord[]
  noPreserveRoot: boolean
}

/** A recursive `rm`, or null. Any spelling of the recursive flag counts; force is not required. */
export function recursiveRm(seg: ShellSegment): RmPlan | null {
  if (basename(seg.argv[0] ?? '') !== 'rm') return null
  let recursive = false
  let noPreserveRoot = false
  const operands: ShellWord[] = []
  let endOfOptions = false
  for (let i = 1; i < seg.words.length; i++) {
    const w = seg.words[i]
    if (!w) continue
    const t = w.text
    if (!endOfOptions && !w.home && t === '--') { endOfOptions = true; continue }
    if (!endOfOptions && !w.home && !w.dynamic && t.startsWith('--')) {
      if (t === '--recursive') recursive = true
      if (t === '--no-preserve-root') noPreserveRoot = true
      continue
    }
    if (!endOfOptions && !w.home && !w.dynamic && t.startsWith('-') && t.length > 1) {
      if (/[rR]/.test(t.slice(1))) recursive = true
      continue
    }
    operands.push(w)
  }
  if (!recursive && !noPreserveRoot) return null
  return { operands, noPreserveRoot }
}

/** `chmod|chown|chgrp -R`, or null. Returns the target words (mode / owner removed). */
export function recursiveChmod(seg: ShellSegment): ShellWord[] | null {
  const name = basename(seg.argv[0] ?? '')
  if (name !== 'chmod' && name !== 'chown' && name !== 'chgrp') return null
  let recursive = false
  const rest: ShellWord[] = []
  for (let i = 1; i < seg.words.length; i++) {
    const w = seg.words[i]
    if (!w) continue
    if (!w.home && !w.dynamic && (w.text === '--recursive' || /^-[A-Za-z]*R[A-Za-z]*$/.test(w.text))) { recursive = true; continue }
    // chmod accepts symbolic modes that look like options (`-w`); keep them out of the targets.
    if (!w.home && !w.dynamic && w.text.startsWith('-') && w.text.length > 1) continue
    rest.push(w)
  }
  if (!recursive) return null
  return rest.slice(1) // the first operand is the mode (chmod) or the owner (chown/chgrp)
}

const HARMLESS_DEVICES = new Set(['/dev/null', '/dev/zero', '/dev/stdout', '/dev/stderr', '/dev/tty', '/dev/stdin'])

export function isHarmlessDevice(path: string): boolean {
  return HARMLESS_DEVICES.has(path) || /^\/dev\/fd\/[0-9]+$/.test(path) || /^\/proc\/self\/fd\/[0-9]+$/.test(path)
}

export function floorForSegment(seg: ShellSegment): FloorHit | null {
  const name = basename(seg.argv[0] ?? '')
  if (/^mkfs(\.|$)/.test(name) || name === 'mke2fs') {
    return { name: 'mkfs', sentence: `\`${name}\` formats a filesystem, which the policy floor refuses (mkfs).` }
  }
  if (name === 'dd') {
    for (const a of seg.argv.slice(1)) {
      const m = /^of=(.*)$/.exec(a)
      if (m && (m[1] ?? '').startsWith('/dev/') && !isHarmlessDevice(m[1] ?? '')) {
        return { name: 'dd-device', sentence: `\`dd\` writing to ${m[1]} would overwrite a raw device, which the policy floor refuses (dd-device).` }
      }
    }
  }
  if (name === 'git' && gitForcePush(seg.argv)) {
    return { name: 'git-force-push', sentence: 'A forced `git push` rewrites history other people may have pulled, and the policy floor refuses it (git-force-push). `--force-with-lease` is allowed through the ordinary rules.' }
  }
  return null
}

/** Global git options that take a value in the NEXT word. */
export const GIT_GLOBAL_WITH_ARG = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--exec-path', '--list-cmds'])

export function gitForcePush(argv: readonly string[]): boolean {
  let i = 1
  while (i < argv.length) {
    const t = argv[i] ?? ''
    if (GIT_GLOBAL_WITH_ARG.has(t)) { i += 2; continue }
    if (t.startsWith('-')) { i++; continue }
    break
  }
  if (argv[i] !== 'push') return false
  for (const t of argv.slice(i + 1)) {
    if (t === '--force' || t === '-f') return true
    if (/^-[A-Za-z]*f[A-Za-z]*$/.test(t) && !t.startsWith('--')) return true
    if (t.startsWith('+') && t.length > 1) return true
  }
  return false
}

const DOWNLOADERS = new Set(['curl', 'wget', 'fetch', 'aria2c'])
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'fish'])
const SHELL_HOSTS = new Set([...SHELLS, 'source', '.', 'eval'])

/**
 * A download reaching a shell. Two shapes: the downloader is an EARLIER element of a pipeline a
 * shell is a later element of, or the downloader is a substitution (`<( )`, `$( )`) whose HOST is a
 * shell / `source` / `eval`. Returns the index of the offending segment.
 */
export function downloadToShell(segs: readonly ShellSegment[]): number | null {
  const isDownloader = (s: ShellSegment): boolean => DOWNLOADERS.has(basename(s.argv[0] ?? ''))
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]
    if (!s || !isDownloader(s)) continue
    // Walk up substitution hosts: `bash <(curl …)`, `eval "$(curl …)"`, `sh -c "$(curl …)"`.
    let hostIdx = s.host
    for (let guard = 0; hostIdx !== undefined && guard < 32; guard++) {
      const host = segs[hostIdx]
      if (!host) break
      const hostName = basename(host.stages[0]?.[0] ?? host.argv[0] ?? '')
      if (SHELL_HOSTS.has(hostName) || SHELL_HOSTS.has(basename(host.argv[0] ?? ''))) return hostIdx
      hostIdx = host.host
    }
    // Pipelines: a shell at a later position of any pipeline this downloader is in.
    for (const p of s.pipes) {
      for (let j = 0; j < segs.length; j++) {
        const t = segs[j]
        if (!t || j === i) continue
        if (!SHELLS.has(basename(t.argv[0] ?? ''))) continue
        if (t.pipes.some(q => q.id === p.id && q.pos > p.pos)) return j
      }
    }
  }
  return null
}

/**
 * Is `target` something a recursive `rm`/`chmod` must never reach? `wipes` says the target is
 * removed ITSELF (or emptied by a whole-directory glob) rather than something below it.
 */
export function protectedTreeTarget(target: string, wipes: boolean, env: RuleEnv): boolean {
  const h = env.home.replace(/\/$/, '') || '/'
  if (!isInside(env.workspaceRoot, target)) return true
  if (!wipes) return false
  return target === '/' || target === h || target === env.workspaceRoot
}

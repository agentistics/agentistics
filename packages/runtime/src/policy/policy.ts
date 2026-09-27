/**
 * policy/policy.ts — the `ToolPolicy` the gate asks before any tool runs (D-T3).
 *
 * ## The order a call is judged in
 *
 * Every subject a tool states is broken into PARTS, and each part gets a verdict:
 *
 * - a shell command → its SEGMENTS (`./shell-parse.ts`), every redirection TARGET (a write or read
 *   of that path), every `cd` TARGET (the directory later segments run in), the paths the command
 *   NAMES, and the directory the whole command starts in;
 * - a read/write/git-read → its path; shell input/control, plan and ask-user → themselves.
 *
 * Then: (1) the DENY FLOOR (`./floor.ts`) — circuit breakers no rule lifts; (2) the RULES
 * (`./rules.ts`, deny beats everything, then most specific, ask over allow, earlier layer); (3) the
 * DEFAULTS below. ONE denied part denies the whole call; otherwise ONE asking part asks a person
 * about the call; otherwise it is allowed. A `cd` moves the directory that LATER segments of the
 * same scope resolve their paths against — `(cd / && rm -rf *)` is judged as removing `/*`.
 *
 * ## Defaults (no rule matched)
 *
 * | part                                   | default |
 * |----------------------------------------|---------|
 * | a read / write / git-read, cwd or `cd` target OUTSIDE the workspace | DENY `policy.denied.outside-workspace` — lifted only by a rule that NAMES the path (`pathGlob`); a rule matching every write does not count as "the policy says so" |
 * | a path a command merely NAMES outside the workspace (`cat /etc/hosts`) | ASK — the policy cannot tell a read from a mention (`echo /etc`) from a write, so it neither allows nor refuses on a guess; the sandbox, not this module, bounds what a command really opens |
 * | an opaque segment, a redirect/`cd` to a place that cannot be known, a recursive `rm` of an unknown target | ASK, and no allow rule or session approval lifts it — fail toward a person |
 * | a redirection INSIDE the workspace | a read follows nothing (reads inside are fine); a WRITE follows its segment when a rule or an approval vouched for the segment, and otherwise takes the call's class |
 * | a shell builtin that changes nothing but the shell (`cd`, `pwd`, `echo`, `printf`, `true`, `test`, `set`, `export`, …) | ALLOW (`default:builtin`) — its redirections are still judged |
 * | everything else | the call's class: `auto` → allow, `ask` → ask, `gated` → deny `policy.denied.gated` (overridable per class through `defaults`) |
 * | `plan`, `ask-user` | ALLOW, unless a deny rule names them |
 *
 * ## Asking, and what an approval covers (D-T3.3)
 *
 * One question per call, naming every part that needs a person in plain words, with the subjects
 * attached. Options: **Allow once**, **Allow for this session: commands starting with `git pull`**
 * (only when at least one part can be generalised), **Deny**. The prefix is the segment's LEADING
 * ARGV TOKENS — `argv[0]` plus a sub-command word when there is one — never the whole string, so an
 * approval of `git pull` covers `git pull --rebase` and, because every segment is judged on its own,
 * never covers `git pull; rm x` (the `rm` is still asked about). A prefix is NOT offered for:
 * an elevated (`sudo`) segment, an opaque one, an interpreter given inline code (`python -c`,
 * `node -e`), or a bare command in `NO_BARE_PREFIX` (a bare `git` or `rm` approval says nothing
 * about what will run). Approvals live in memory for the policy's lifetime (one session).
 *
 * No asker, a question nobody answered, an abort, or an asker that throws → DENY. `by` is `user`
 * when a person declined or dismissed it, `policy` when no person could be reached.
 *
 * ## Never throws
 *
 * `evaluate` wraps everything and denies with `policy.denied.internal` — the gate is the one place
 * that fails closed (D-T3 rule 5), and a policy that throws would already be a denial there, but
 * saying WHY belongs here.
 */

import { homedir } from 'node:os'
import { isAbsolute, resolve as resolvePathPure } from 'node:path'
import type {
  PersonAnswer,
  PersonQuestion,
  PolicyRequest,
  PolicySubject,
  PolicyVerdict,
  ToolPermission,
  ToolPolicy,
} from '../tools/contract.ts'
import { isInside, resolveToolPath } from '../tools/paths.ts'
import {
  downloadToShell,
  floorForPath,
  floorForRaw,
  floorForSegment,
  isHarmlessDevice,
  protectedTreeTarget,
  recursiveChmod,
  recursiveRm,
  type FloorEnv,
  type FloorHit,
} from './floor.ts'
import { decideByRules, type PolicyLayer, type RuleHit, type RuleTarget } from './rules.ts'
import { commandName, parseShell, type ShellSegment, type ShellWord } from './shell-parse.ts'

// ── Options ─────────────────────────────────────────────────────────────────────────────────────

export type ClassDefault = 'allow' | 'ask' | 'deny'

export interface PolicyOptions {
  /** machine → user → project, in that order. */
  layers: readonly PolicyLayer[]
  /** Per-class defaults. Unset: `auto` → allow, `ask` → ask, `gated` → deny. */
  defaults?: Partial<Record<ToolPermission, ClassDefault>>
  /** Extra globs no call may read or write (the floor's `protected-path`). */
  protectedPaths?: readonly string[]
  now?: () => Date
  /** The home directory `~` and `$HOME` mean. Default: the process's. */
  home?: string
  /**
   * Resolves a path a SHELL command names (relative to `cwd`) to the file it really touches.
   * Default: `resolveToolPath` (symlinks followed). Subjects from other tools arrive resolved.
   */
  resolvePath?: (cwd: string, p: string) => Promise<string>
}

export interface SessionApproval {
  key: string
  /** What the person approved, in the words the question used. */
  label: string
  approvedAt: string
}

export interface SessionPolicy extends ToolPolicy {
  /** What a person approved "for this session", in order. */
  approvals(): readonly SessionApproval[]
}

// ── Internal verdicts ───────────────────────────────────────────────────────────────────────────

interface ApprovalKey {
  key: string
  label: string
  /** For a command prefix: the argv tokens it covers. */
  tokens?: readonly string[]
}

type PartVerdict =
  | { kind: 'allow'; by: 'auto' | 'policy' | 'user'; policy: string; vouches: boolean }
  | { kind: 'ask'; policy: string; what: string; key: ApprovalKey | null }
  | { kind: 'deny'; policy: string; code: string; sentence: string; floor: boolean }

const DEFAULT_CLASS: Record<ToolPermission, ClassDefault> = { auto: 'allow', ask: 'ask', gated: 'deny' }

/** Builtins that change nothing but the shell itself. Their redirections are still judged. */
const SAFE_BUILTINS = new Set(['cd', 'pushd', 'popd', 'pwd', 'true', 'false', ':', 'echo', 'printf', 'test', '[', 'set', 'export', 'unset', 'exit', 'return', 'shift', 'wait', 'sleep', 'shopt', 'type', 'which'])

/** Commands whose argv[0] alone says nothing about what will happen: no bare-prefix approval. */
export const NO_BARE_PREFIX = new Set([
  'git', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'bunx', 'deno', 'node', 'python', 'python3', 'perl', 'ruby', 'php',
  'java', 'dotnet', 'docker', 'podman', 'kubectl', 'helm', 'gh', 'cargo', 'go', 'make', 'pip', 'pip3', 'uv',
  'terraform', 'aws', 'gcloud', 'az', 'systemctl', 'apt', 'apt-get', 'brew', 'ssh', 'scp', 'rsync',
  'rm', 'mv', 'cp', 'dd', 'chmod', 'chown', 'kill', 'pkill', 'killall', 'shred', 'truncate', 'tee', 'sed', 'awk', 'find', 'xargs',
])

const INTERPRETERS = new Set(['python', 'python3', 'node', 'perl', 'ruby', 'php', 'deno', 'bun', 'lua', 'Rscript', 'osascript', 'pwsh', 'powershell', 'tclsh', 'awk', 'gawk'])
const INLINE_CODE_FLAGS = new Set(['-c', '-e', '--eval', '-r', '--command', '-p', '--print', '-E', 'eval', '-Command'])

/** Commands whose arguments are words, not paths opened. */
const NO_MENTION = new Set(['echo', 'printf', 'cd', 'pushd', 'popd', 'export', 'set', 'unset'])

const PLAIN_TOKEN = /^[A-Za-z0-9][\w.:@+-]*$/

function shorten(s: string, max = 160): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > max ? one.slice(0, max - 1) + '…' : one
}

function shellQuote(argv: readonly string[]): string {
  return argv.map(a => (/^[\w./:@%+=,~-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ')
}

/** The generalisable prefix of a segment, or null when approving it for the session would say too much. */
export function sessionPrefix(seg: ShellSegment): string[] | null {
  if (seg.opaque || seg.elevated || seg.argv.length === 0) return null
  const name = commandName(seg.argv[0] ?? '')
  if (INTERPRETERS.has(name) && seg.argv.slice(1).some(a => INLINE_CODE_FLAGS.has(a) || /^-[a-z]*[ce]$/.test(a))) return null
  const second = seg.argv[1]
  const w1 = seg.words[1]
  if (second !== undefined && w1 && !w1.dynamic && !w1.home && !w1.glob && PLAIN_TOKEN.test(second)) {
    return [seg.argv[0] ?? '', second]
  }
  if (NO_BARE_PREFIX.has(name)) return null
  return [seg.argv[0] ?? '']
}

function prefixCovers(tokens: readonly string[], argv: readonly string[]): boolean {
  if (tokens.length === 0 || tokens.length > argv.length) return false
  return tokens.every((t, i) => {
    const a = argv[i]
    if (a === undefined) return false
    return a === t || (i === 0 && commandName(a) === commandName(t))
  })
}

function isPathLike(w: ShellWord): boolean {
  if (w.home) return true
  if (w.dynamic) return false
  const t = w.text
  if (t === '' || t.startsWith('-')) return false
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return false
  return t.startsWith('/') || t === '.' || t === '..' || t.startsWith('./') || t.startsWith('../') || t.includes('/')
}

const WIPE_ALL_GLOBS = new Set(['*', '.*', '**', '.[!.]*', '{*,.*}'])

/** Where a word points, BEFORE symlink resolution. `wipes`: it names the directory itself (or empties it). */
function wordTarget(w: ShellWord, cwd: string | null, home: string): { path: string; wipes: boolean } | null {
  let text: string
  if (w.home) text = home.replace(/\/$/, '') + w.text
  else if (w.dynamic) return null
  else text = w.text
  let wipes = true
  if (w.glob) {
    const parts = text.split('/')
    const gi = parts.findIndex(p => /[*?[]/.test(p))
    const globSeg = parts[gi] ?? ''
    wipes = gi === parts.length - 1 && WIPE_ALL_GLOBS.has(globSeg)
    const base = parts.slice(0, gi).join('/')
    text = base === '' ? (text.startsWith('/') ? '/' : '.') : base
  }
  if (!isAbsolute(text)) {
    if (cwd === null) return null
    text = resolvePathPure(cwd, text)
  } else text = resolvePathPure(text)
  return { path: text, wipes }
}

function rel(root: string, p: string): string {
  if (p === root) return 'the workspace root'
  return isInside(root, p) ? p.slice(root.replace(/\/$/, '').length + 1) : p
}

// ── The policy ──────────────────────────────────────────────────────────────────────────────────

export function createPolicy(opts: PolicyOptions): SessionPolicy {
  const layers = opts.layers
  const classDefaults: Record<ToolPermission, ClassDefault> = { ...DEFAULT_CLASS, ...(opts.defaults ?? {}) }
  const now = opts.now ?? (() => new Date())
  const home = (opts.home ?? homedir()).replace(/\/$/, '') || '/'
  const resolveReal = opts.resolvePath ?? resolveToolPath
  const approvals = new Map<string, SessionApproval & { tokens?: readonly string[] }>()

  const approvedPrefix = (argv: readonly string[]): string | null => {
    for (const a of approvals.values()) if (a.tokens && prefixCovers(a.tokens, argv)) return a.key
    return null
  }

  async function decide(req: PolicyRequest): Promise<PolicyVerdict> {
    const root = req.workspaceRoot
    const env: FloorEnv = { home, workspaceRoot: root, protectedPaths: opts.protectedPaths ?? [] }
    const tool = req.call.toolName
    const cls = classDefaults[req.permission]
    const parts: PartVerdict[] = []

    const fromFloor = (h: FloorHit): PartVerdict =>
      ({ kind: 'deny', policy: `floor:${h.name}`, code: `policy.denied.floor.${h.name}`, sentence: h.sentence, floor: true })

    const fromRule = (hit: RuleHit, what: string): PartVerdict => {
      const r = hit.rule
      if (r.effect === 'deny') {
        return { kind: 'deny', policy: r.id, code: 'policy.denied.rule', sentence: `The ${hit.layer} rule "${r.id}" refuses ${what}, so it did not run.`, floor: false }
      }
      if (r.effect === 'ask') return { kind: 'ask', policy: r.id, what: `${what} (the ${hit.layer} rule "${r.id}" asks for a person)`, key: null }
      return { kind: 'allow', by: 'policy', policy: r.id, vouches: true }
    }

    const outsideDeny = (path: string, what: string): PartVerdict => ({
      kind: 'deny', policy: 'default:outside-workspace', code: 'policy.denied.outside-workspace', floor: false,
      sentence: `${what} ${path}, which is outside this session's workspace (${root}); no rule allows that, so it did not run.`,
    })

    const classVerdict = (what: string, key: ApprovalKey | null): PartVerdict => {
      if (cls === 'allow') return { kind: 'allow', by: 'auto', policy: `default:${req.permission}`, vouches: false }
      if (cls === 'deny') {
        return { kind: 'deny', policy: `default:${req.permission}`, code: 'policy.denied.gated', floor: false, sentence: `${what} needs a capability that is off by default, and no rule allows it, so it did not run.` }
      }
      if (key) {
        const covered = key.tokens ? null : approvals.get(key.key)
        if (covered) return { kind: 'allow', by: 'user', policy: `session:${covered.label}`, vouches: true }
      }
      return { kind: 'ask', policy: `default:${req.permission}`, what, key }
    }

    /** A path read or written (subject paths are resolved; shell paths are resolved by the caller). */
    const pathPart = (action: 'read' | 'write' | 'git-read', path: string, access: 'read' | 'write', what: string, onInside: () => PartVerdict | null): PartVerdict | null => {
      const floor = floorForPath(path, access, env)
      if (floor) return fromFloor(floor)
      const target: RuleTarget = { action, tool, path }
      const hit = decideByRules(layers, target, env)
      if (hit && hit.rule.effect === 'deny') return fromRule(hit, `${what} ${path}`)
      if (!isInside(root, path)) {
        const explicit = decideByRules(layers, target, env, { requirePathGlob: true })
        return explicit ? fromRule(explicit, `${what} ${path}`) : outsideDeny(path, what)
      }
      if (hit) return fromRule(hit, `${what} ${path}`)
      return onInside()
    }

    // ── a shell command ──
    const shellParts = async (s: Extract<PolicySubject, { action: 'shell' }>): Promise<void> => {
      const raw = floorForRaw(s.command)
      if (raw) { parts.push(fromFloor(raw)); return }
      const parsed = parseShell(s.command)
      const segs = parsed.segments
      const dl = downloadToShell(segs)
      if (dl !== null) {
        parts.push(fromFloor({ name: 'download-to-shell', sentence: 'This command pipes something downloaded from the network into a shell, which the policy floor refuses (download-to-shell): it would run code nobody has read.' }))
        return
      }

      const startCwd = s.cwd
      const cwdPart = async (dir: string | null, what: string): Promise<void> => {
        if (dir === null) {
          parts.push({ kind: 'ask', policy: 'default:unknown-cwd', what: `${what} a directory that cannot be known before it runs`, key: null })
          return
        }
        if (isInside(root, dir)) return
        const target: RuleTarget = { action: 'shell', tool, path: dir }
        const hit = decideByRules(layers, target, env)
        if (hit && hit.rule.effect === 'deny') { parts.push(fromRule(hit, `${what} ${dir}`)); return }
        const explicit = decideByRules(layers, target, env, { requirePathGlob: true })
        parts.push(explicit ? fromRule(explicit, `${what} ${dir}`) : outsideDeny(dir, what))
      }
      await cwdPart(startCwd, 'This command would run in')

      const scopeCwd = new Map<string, string | null>([['0', startCwd]])
      const cwdOf = (scope: string): string | null => {
        for (let sc = scope; ; ) {
          if (scopeCwd.has(sc)) return scopeCwd.get(sc) ?? null
          const i = sc.lastIndexOf('.')
          if (i === -1) return startCwd
          sc = sc.slice(0, i)
        }
      }
      const real = async (cwd: string | null, p: string): Promise<string> => resolveReal(cwd ?? '/', p)

      for (const seg of segs) {
        const cwd = cwdOf(seg.scope)
        const label = seg.argv.length > 0 ? `\`${shorten(shellQuote(seg.argv), 100)}\`` : 'a redirection'
        const where = cwd === null ? '' : cwd === startCwd ? '' : ` (in ${rel(root, cwd)})`

        // Floor: device/format/force-push.
        const segFloor = floorForSegment(seg)
        if (segFloor) { parts.push(fromFloor(segFloor)); continue }

        // Floor: recursive rm / chmod on a protected tree.
        const rm = recursiveRm(seg)
        const chmodTargets = rm ? null : recursiveChmod(seg)
        if (rm?.noPreserveRoot) {
          parts.push(fromFloor({ name: 'rm-recursive', sentence: '`rm --no-preserve-root` is refused by the policy floor (rm-recursive).' }))
          continue
        }
        const treeOps = rm ? rm.operands : chmodTargets
        if (treeOps) {
          const floorName = rm ? 'rm-recursive' : 'chmod-recursive'
          const verb = rm ? 'remove' : 'change the permissions of'
          let unknown = seg.appendsArgs
          let hitFloor: FloorHit | null = null
          for (const w of treeOps) {
            const t = wordTarget(w, cwd, home)
            if (!t) { unknown = true; continue }
            const p = await real(cwd, t.path)
            if (protectedTreeTarget(p, t.wipes, env)) {
              hitFloor = { name: floorName, sentence: `${label} would recursively ${verb} ${p === '/' ? '/' : p}${t.wipes ? '' : ' (its contents)'}, which is ${p === root ? 'the workspace itself' : isInside(root, p) ? 'protected' : 'outside the workspace'}; the policy floor refuses it (${floorName}).` }
              break
            }
          }
          if (hitFloor) { parts.push(fromFloor(hitFloor)); continue }
          if (unknown) {
            parts.push({ kind: 'ask', policy: `floor:${floorName}-unknown`, what: `${label}${where} recursively ${verb === 'remove' ? 'removes' : 'changes'} something that cannot be known before it runs`, key: null })
          }
        }

        // The segment itself.
        const anyStages = seg.stages
        const elevatedStage = seg.elevated
          ? seg.stages.filter(st => ['sudo', 'doas'].includes(commandName(st[0] ?? ''))).slice(-1)
          : null
        const allowStages = seg.opaque ? [] : elevatedStage ?? [seg.argv]
        let segVerdict: PartVerdict
        if (seg.argv.length === 0 && !seg.opaque) {
          segVerdict = { kind: 'allow', by: 'auto', policy: 'default:empty', vouches: false }
        } else {
          const target: RuleTarget = { action: 'shell', tool, path: cwd, anyStages, allowStages }
          const hit = decideByRules(layers, target, env)
          if (seg.opaque) {
            segVerdict = hit && hit.rule.effect === 'deny'
              ? fromRule(hit, `the command ${label}`)
              : { kind: 'ask', policy: hit?.rule.effect === 'ask' ? hit.rule.id : 'default:opaque', what: `${label}${where} cannot be read with certainty: ${seg.opaque}`, key: null }
          } else if (hit) {
            segVerdict = fromRule(hit, `the command ${label}`)
          } else if (SAFE_BUILTINS.has(commandName(seg.argv[0] ?? '')) && !seg.elevated) {
            segVerdict = { kind: 'allow', by: 'auto', policy: 'default:builtin', vouches: false }
          } else {
            const tokens = sessionPrefix(seg)
            const covered = tokens ? approvedPrefix(seg.argv) : null
            if (cls === 'ask' && covered && !seg.elevated) {
              segVerdict = { kind: 'allow', by: 'user', policy: `session:${approvals.get(covered)?.label ?? covered}`, vouches: true }
            } else {
              const key = tokens ? { key: `prefix:${tokens.join(' ')}`, label: `\`${tokens.join(' ')}\``, tokens } : null
              segVerdict = classVerdict(`${label}${where}${seg.elevated ? ' (with elevated privileges)' : ''}`, key)
            }
          }
        }
        parts.push(segVerdict)

        // Redirections.
        for (const r of seg.redirects) {
          if (!r.target || r.access === 'none') continue
          const t = wordTarget(r.target, cwd, home)
          const access = r.access
          const verb = access === 'write' ? 'writes to' : 'reads from'
          if (!t) {
            parts.push({ kind: 'ask', policy: 'default:unknown-path', what: `${label}${where} ${verb} a file whose name is only known when it runs`, key: null })
            continue
          }
          if (isHarmlessDevice(t.path)) continue
          const p = await real(cwd, t.path)
          const v = pathPart(access, p, access, `${label} ${verb}`, () => {
            if (access === 'read') return null
            if (segVerdict.kind === 'allow' && segVerdict.vouches) return null
            if (segVerdict.kind === 'ask' || segVerdict.kind === 'deny') return null
            // A builtin or an empty command writing a file: the write is what needs deciding.
            const tokens = sessionPrefix(seg)
            const key = tokens ? { key: `prefix:${tokens.join(' ')}`, label: `\`${tokens.join(' ')}\``, tokens } : null
            if (key?.tokens && cls === 'ask' && approvedPrefix(seg.argv)) return null
            return classVerdict(`${label} writes to ${rel(root, p)}`, key)
          })
          if (v) parts.push(v)
        }

        // `dd if=/of=` name files outside the redirection syntax.
        if (commandName(seg.argv[0] ?? '') === 'dd') {
          for (const a of seg.argv.slice(1)) {
            const m = /^(if|of)=(.+)$/.exec(a)
            if (!m) continue
            const abs = resolvePathPure(cwd ?? '/', m[2] ?? '')
            if (isHarmlessDevice(abs)) continue
            const p = await real(cwd, abs)
            const v = pathPart(m[1] === 'of' ? 'write' : 'read', p, m[1] === 'of' ? 'write' : 'read', `${label} ${m[1] === 'of' ? 'writes to' : 'reads from'}`, () => null)
            if (v) parts.push(v)
          }
        }

        // Paths the command names.
        const name = commandName(seg.argv[0] ?? '')
        if (!seg.opaque && !NO_MENTION.has(name) && !rm && !chmodTargets) {
          for (const w of seg.words.slice(1)) {
            if (!isPathLike(w)) continue
            const t = wordTarget(w, cwd, home)
            if (!t) continue
            if (isHarmlessDevice(t.path)) continue
            const p = await real(cwd, t.path)
            const floor = floorForPath(p, 'read', env)
            if (floor) { parts.push(fromFloor(floor)); continue }
            if (isInside(root, p)) continue
            const target: RuleTarget = { action: 'read', tool, path: p }
            const hit = decideByRules(layers, target, env)
            if (hit && hit.rule.effect === 'deny') { parts.push(fromRule(hit, `${label} naming ${p}`)); continue }
            const explicit = decideByRules(layers, target, env, { requirePathGlob: true })
            parts.push(explicit
              ? fromRule(explicit, `${label} naming ${p}`)
              : { kind: 'ask', policy: 'default:outside-workspace-mention', what: `${label}${where} names ${p}, outside the workspace`, key: null })
          }
        }

        // `cd` moves the directory later segments of this scope run in.
        if (name === 'cd' || name === 'pushd' || name === 'popd') {
          let next: string | null
          if (name === 'popd') next = null
          else {
            const args = seg.words.slice(1).filter(w => w.home || w.dynamic || !/^-[LPe@]+$/.test(w.text))
            const w = args[0]
            if (!w) next = home
            else if (!w.home && !w.dynamic && w.text === '-') next = null
            else {
              const t = wordTarget(w, cwd, home)
              next = t ? await real(cwd, t.path) : null
            }
          }
          await cwdPart(next, `${label} moves to`)
          scopeCwd.set(seg.scope, next)
        }
      }
    }

    for (const s of req.subjects) {
      switch (s.action) {
        case 'plan':
        case 'ask-user': {
          const hit = decideByRules(layers, { action: s.action, tool }, env)
          parts.push(hit && hit.rule.effect === 'deny'
            ? fromRule(hit, s.action === 'plan' ? 'updating the plan' : 'asking a person a question')
            : { kind: 'allow', by: 'auto', policy: 'default:auto', vouches: false })
          break
        }
        case 'read':
        case 'git-read': {
          const path = s.action === 'read' ? s.path : s.repo
          const what = s.action === 'read' ? `\`${tool}\` reading` : `\`${tool}\` reading the repository at`
          const v = pathPart(s.action, path, 'read', what, () =>
            classVerdict(`${what} ${rel(root, path)}`, { key: `tool:${tool}`, label: `\`${tool}\` inside the workspace` }))
          if (v) parts.push(v)
          break
        }
        case 'write': {
          const what = `\`${tool}\` writing (${s.op})`
          const v = pathPart('write', s.path, 'write', what, () =>
            classVerdict(`${what} ${rel(root, s.path)}`, { key: `tool:${tool}`, label: `\`${tool}\` inside the workspace` }))
          if (v) parts.push(v)
          break
        }
        case 'shell-input':
        case 'shell-control': {
          const hit = decideByRules(layers, { action: s.action, tool }, env)
          const what = s.action === 'shell-input'
            ? `\`${tool}\` sending ${s.bytes} bytes of input to shell ${s.shellId}`
            : `\`${tool}\` ${s.verb === 'read' ? 'reading from' : 'stopping'} shell ${s.shellId}`
          parts.push(hit ? fromRule(hit, what) : classVerdict(what, { key: `tool:${tool}`, label: `\`${tool}\`` }))
          break
        }
        case 'shell':
          await shellParts(s)
          break
      }
    }

    if (req.subjects.length === 0) {
      parts.push(classVerdict(`\`${tool}\``, { key: `tool:${tool}`, label: `\`${tool}\`` }))
    }

    // ── combine ──
    const denies = parts.filter((p): p is Extract<PartVerdict, { kind: 'deny' }> => p.kind === 'deny')
    const deny = denies.find(d => d.floor) ?? denies[0]
    if (deny) return { decision: 'deny', by: 'policy', policy: deny.policy, code: deny.code, sentence: deny.sentence }

    const asks = parts.filter((p): p is Extract<PartVerdict, { kind: 'ask' }> => p.kind === 'ask')
    if (asks.length === 0) {
      const allows = parts.filter((p): p is Extract<PartVerdict, { kind: 'allow' }> => p.kind === 'allow')
      const byUser = allows.find(a => a.by === 'user')
      const byPolicy = allows.find(a => a.by === 'policy')
      if (byUser) return { decision: 'allow', by: 'user', policy: byUser.policy }
      if (byPolicy) return { decision: 'allow', by: 'policy', policy: byPolicy.policy }
      return { decision: 'allow', by: 'auto', policy: allows[0]?.policy ?? `default:${req.permission}` }
    }
    return askPerson(req, asks)
  }

  async function askPerson(req: PolicyRequest, asks: Array<Extract<PartVerdict, { kind: 'ask' }>>): Promise<PolicyVerdict> {
    const first = asks[0]
    const policy = first?.policy ?? `default:${req.permission}`
    const isShell = req.subjects.some(s => s.action === 'shell')
    const noun = isShell ? 'command' : 'call'
    if (req.signal?.aborted) {
      return { decision: 'deny', by: 'policy', policy, code: 'policy.denied.aborted', sentence: `The run was cancelled while this ${noun} was waiting for approval, so it did not run.` }
    }
    if (!req.asker) {
      return { decision: 'deny', by: 'policy', policy, code: 'policy.denied.no-person', sentence: `This ${noun} needs a person's approval and no person was available to approve it, so it did not run.` }
    }

    const keys = new Map<string, ApprovalKey>()
    for (const a of asks) if (a.key) keys.set(a.key.key, a.key)
    const generalisable = [...keys.values()]
    const whole = req.subjects
      .map(s => (s.action === 'shell' ? shorten(s.command, 400) : null))
      .filter((c): c is string => c !== null)
    const lines = [...new Set(asks.map(a => a.what))]
    const text = [
      isShell ? `Allow this command to run?\n\n${whole.join('\n')}` : `Allow \`${req.call.toolName}\` to run?`,
      '',
      'It needs your approval because:',
      ...lines.map(l => `- ${l}`),
    ].join('\n')

    const options: PersonQuestion['options'] = [{ label: 'Allow once', description: 'Run it this time only.' }]
    const sessionIndex = generalisable.length > 0 ? options.length : -1
    if (generalisable.length > 0) {
      const covers = generalisable.map(k => k.label).join(', ')
      const prefixes = generalisable.every(k => k.tokens)
      const partial = generalisable.length < asks.length
      options.push({
        label: prefixes ? `Allow for this session: commands starting with ${covers}` : `Allow for this session: ${covers}`,
        description: partial
          ? 'Later calls are allowed without asking only when every part of them is covered; the other parts of this one are approved once.'
          : 'Later calls are allowed without asking only when every part of them is covered.',
      })
    }
    options.push({ label: 'Deny', description: `Do not run this ${noun}.` })

    const q: PersonQuestion = {
      id: `${req.call.toolExecutionId}:permission`,
      kind: 'permission',
      text,
      options,
      subjects: req.subjects,
    }

    let answer: PersonAnswer | 'aborted' | 'failed'
    try {
      const asked = req.asker.ask(q, req.signal)
      if (req.signal) {
        const signal = req.signal
        let onAbort: (() => void) | undefined
        const aborted = new Promise<'aborted'>(res => {
          onAbort = () => res('aborted')
          signal.addEventListener('abort', onAbort, { once: true })
        })
        answer = await Promise.race([asked, aborted])
        if (onAbort) signal.removeEventListener('abort', onAbort)
      } else {
        answer = await asked
      }
    } catch {
      answer = 'failed'
    }

    if (answer === 'aborted') {
      return { decision: 'deny', by: 'policy', policy, code: 'policy.denied.aborted', sentence: `The run was cancelled while this ${noun} was waiting for approval, so it did not run.` }
    }
    if (answer === 'failed') {
      return { decision: 'deny', by: 'policy', policy, code: 'policy.denied.no-person', sentence: `The approval question could not be delivered to a person, so this ${noun} did not run.` }
    }
    if (!answer.answered) {
      const byUser = answer.reason === 'cancelled'
      return {
        decision: 'deny', by: byUser ? 'user' : 'policy', policy, code: 'policy.denied.unanswered',
        sentence: byUser
          ? `The person dismissed the approval question, so this ${noun} did not run.`
          : answer.reason === 'timeout'
            ? `Nobody answered the approval question in time, so this ${noun} did not run.`
            : `No person was available to approve this ${noun}, so it did not run.`,
      }
    }
    const choice = answer.choice
    if (choice === 0) return { decision: 'allow', by: 'user', policy }
    if (choice !== undefined && choice === sessionIndex) {
      const at = now().toISOString()
      for (const k of generalisable) approvals.set(k.key, { key: k.key, label: k.label, approvedAt: at, tokens: k.tokens })
      return { decision: 'allow', by: 'user', policy }
    }
    return { decision: 'deny', by: 'user', policy, code: 'policy.denied.by-person', sentence: `A person declined to allow this ${noun}, so it did not run.` }
  }

  return {
    async evaluate(req: PolicyRequest): Promise<PolicyVerdict> {
      try {
        return await decide(req)
      } catch {
        return {
          decision: 'deny', by: 'policy', policy: 'policy:internal', code: 'policy.denied.internal',
          sentence: 'The permission policy failed while judging this call, so it was refused. Nothing ran.',
        }
      }
    },
    approvals() {
      return [...approvals.values()].map(({ key, label, approvedAt }) => ({ key, label, approvedAt }))
    },
  }
}

/**
 * catalogue/floor-target.ts — does a catalogue RULE aim at something the deny floor owns?
 *
 * The floor (`policy/floor.ts`) is checked before any rule, so no rule can LIFT it at run time
 * whatever this module says. What this module prevents is the other half of the lie: a profile
 * named `yolo` carrying `allow write .git/**` LOOKS like it grants something, a person believes it
 * is in force, and it never is. §5.5: "a 'bypass' profile does not exist and cannot be written: the
 * loader refuses any profile rule that targets a floor subject, in words." Criterion 3.
 *
 * ## It asks the floor, it does not restate it
 *
 * Every answer comes from the floor's OWN predicates — `floorForPath`, `floorForRaw`,
 * `floorForSegment`, `downloadToShell`, `recursiveRm`, `recursiveChmod`, `protectedTreeTarget`,
 * `inGitDir` — applied to a concrete PROBE built from the rule:
 *
 * - a `pathGlob` becomes one sample path: the glob made absolute the way `rules.ts` anchors it
 *   (`absoluteGlob`), with every `**` segment dropped and every other wildcard removed. So
 *   `.git/**` probes `<ws>/.git`, `~/.ssh/*` probes `~/.ssh`, `**` probes the workspace root —
 *   which is NOT floor. That last one is deliberate: a rule that merely OVERLAPS the floor (allow
 *   writes anywhere in the workspace) is a legitimate rule the floor carves into; only a rule
 *   whose own literal part NAMES a floor subject targets it.
 * - a `commandPrefix` becomes the command line it spells, parsed by the policy's own parser.
 *
 * ## Only rules that could GRANT are judged
 *
 * A `deny` rule over a floor subject is redundant, not misleading — it says what is already true —
 * so it is accepted. `allow` and `ask` are judged: an `ask` over a floor subject promises a
 * question that never comes (the floor denies before any rule is read).
 */

import type { PolicyRule } from '../policy/rules.ts'
import { absoluteGlob } from '../policy/rules.ts'
import {
  downloadToShell,
  floorForPath,
  floorForRaw,
  floorForSegment,
  inGitDir,
  protectedTreeTarget,
  recursiveChmod,
  recursiveRm,
  type FloorEnv,
  type FloorHit,
} from '../policy/floor.ts'
import { parseShell, type ShellWord } from '../policy/shell-parse.ts'

/**
 * The environment a pure caller probes against when it has no real one. The HOST (B8.2) passes the
 * real home, workspace root, `protectedPaths` and relocated `agentisticsDir`, because an absolute
 * glob such as `/home/ana/.ssh/**` only probes the floor under the home it names.
 */
export const SYMBOLIC_FLOOR_ENV: FloorEnv = { home: '/home/user', workspaceRoot: '/workspace', protectedPaths: [] }

/** One concrete path standing for a glob (see the module header). */
export function probePath(glob: string, env: FloorEnv): string {
  const abs = absoluteGlob(glob, env)
  const segs = abs.split('/')
  const out: string[] = []
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i] ?? ''
    if (i === 0) { out.push(s); continue }
    if (s === '**') continue
    const literal = s.replace(/\[[^\]]*\]/g, '').replace(/[*?]/g, '')
    if (literal === '' && s !== '') continue
    out.push(literal)
  }
  const joined = out.join('/').replace(/\/+/g, '/').replace(/(.)\/$/, '$1')
  return joined === '' ? '/' : joined
}

/** `~` stays bare so the parser expands it to HOME, the way the person wrote it. */
const SAFE_TOKEN = /^[A-Za-z0-9_@%+=:,./~-]+$/

function quote(argv: readonly string[]): string {
  return argv.map(t => (t !== '' && SAFE_TOKEN.test(t) ? t : `'${t.replace(/'/g, `'\\''`)}'`)).join(' ')
}

function literalTarget(w: ShellWord, env: FloorEnv): { path: string; wipes: boolean } | null {
  if (w.dynamic) return null
  let text = w.home ? env.home.replace(/\/$/, '') + w.text : w.text
  let wipes = true
  if (w.glob) {
    const parts = text.split('/')
    const gi = parts.findIndex(p => /[*?[]/.test(p))
    text = parts.slice(0, gi).join('/') || (text.startsWith('/') ? '/' : '.')
    wipes = false
  }
  if (!text.startsWith('/')) text = env.workspaceRoot.replace(/\/$/, '') + '/' + text.replace(/^\.\/?/, '')
  return { path: text.length > 1 ? text.replace(/\/$/, '') : text, wipes }
}

/** The floor subject a command prefix spells, or null. */
function commandFloor(prefix: readonly string[], env: FloorEnv): FloorHit | null {
  if (prefix.length === 0) return null
  const raw = floorForRaw(prefix.join(' '))
  if (raw) return raw
  const segs = parseShell(quote(prefix)).segments
  if (downloadToShell(segs) !== null) {
    return { name: 'download-to-shell', sentence: 'it pipes something downloaded into a shell (download-to-shell)' }
  }
  for (const seg of segs) {
    const f = floorForSegment(seg)
    if (f) return f
    const rm = recursiveRm(seg)
    if (rm?.noPreserveRoot) return { name: 'rm-recursive', sentence: '`rm --no-preserve-root` (rm-recursive)' }
    const targets = rm ? rm.operands : recursiveChmod(seg)
    if (!targets) continue
    const name = rm ? 'rm-recursive' : 'chmod-recursive'
    for (const w of targets) {
      const t = literalTarget(w, env)
      if (!t) continue
      if (inGitDir(t.path)) return floorForPath(t.path, 'write', env) ?? { name: 'git-internals', sentence: t.path }
      if (protectedTreeTarget(t.path, t.wipes, env)) return { name, sentence: `a recursive ${rm ? 'rm' : 'chmod'} of ${t.path} (${name})` }
    }
  }
  return null
}

/**
 * The floor subject `rule` aims at, or null. `deny` rules are never reported (see the header).
 * The returned hit's `name` is the floor's own name (`git-internals`, `credential-store`, …).
 */
export function ruleFloorHit(rule: PolicyRule, env: FloorEnv = SYMBOLIC_FLOOR_ENV): FloorHit | null {
  if (rule.effect === 'deny') return null
  const m = rule.match
  if (m.pathGlob !== undefined && (m.action === undefined || m.action === 'read' || m.action === 'write' || m.action === 'git-read')) {
    const p = probePath(m.pathGlob, env)
    const accesses: Array<'read' | 'write'> = m.action === 'write' ? ['write'] : m.action === undefined ? ['write', 'read'] : ['read']
    for (const a of accesses) {
      const hit = floorForPath(p, a, env)
      if (hit) return hit
    }
  }
  if (m.commandPrefix !== undefined && (m.action === undefined || m.action === 'shell')) {
    const hit = commandFloor(m.commandPrefix, env)
    if (hit) return hit
  }
  return null
}

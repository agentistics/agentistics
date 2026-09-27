/**
 * policy/rules.ts — permission rules as DATA, layered, and how one is chosen (D-T3 rule 1).
 *
 * ## Why data, and why layers
 *
 * Codex (Starlark, admin/user/project), Gemini (TOML, admin > user > default) and Claude Code
 * (deny → ask → allow) all converged on the same shape: rules a person can read, written at more
 * than one level. Here the levels are machine → user → project, supplied in that ORDER; the order
 * is what breaks a tie.
 *
 * ## How a rule is chosen for one PART (a segment, a redirection target, a path)
 *
 * 1. **A matching DENY wins, whatever else matches.** Specificity only chooses WHICH deny is named.
 *    This is deliberate and is the one place the spec's two sentences ("deny → ask → allow" and
 *    "the most specific rule wins") had to be reconciled: if a more specific allow could beat a
 *    deny, a PROJECT file — which ships inside the repository an agent is working on — could lift a
 *    deny the USER wrote by being one token more specific. Deny is therefore absolute, as in Claude
 *    Code and Codex.
 * 2. Otherwise, among ASK and ALLOW rules, **the most specific wins**: more `commandPrefix` tokens,
 *    then more literal characters in `pathGlob`, then more match fields set.
 * 3. At equal specificity **ask beats allow** (the deny → ask → allow order).
 * 4. Still tied: **the earlier layer wins** (machine before user before project) — the machine's
 *    administrator speaks first.
 *
 * ## What a field matches
 *
 * - `action` — the `PolicySubject.action` of the part. A shell segment is `shell`; a shell
 *   redirection is `write` or `read` of its target; a path the command names is `read`.
 * - `tool` — the tool's name (`shell.start`, `file.write`, …).
 * - `pathGlob` — the part's ABSOLUTE path. `~` expands to the home directory; a relative glob is
 *   anchored at the workspace root. `*` stays inside one path segment, `**` crosses them, and
 *   `dir/**` matches `dir` itself too. A part with no known path never matches a `pathGlob` rule.
 * - `commandPrefix` — argv TOKENS, never a string prefix (`['git','pull']` does not match
 *   `git pull-request`). Token 0 also matches by basename, so `rm` matches `/bin/rm`.
 *   A DENY or ASK rule matches ANY unwrap stage (so `deny sudo` still sees `sudo rm …`); an ALLOW
 *   rule must match the command that really runs — the innermost stage, or for an elevated
 *   command the stage that begins with `sudo`/`doas` (allowing `apt` must not allow `sudo apt`).
 *
 * PURE.
 */

import type { PolicySubject } from '../tools/contract.ts'

export type RuleEffect = 'deny' | 'ask' | 'allow'

export interface RuleMatch {
  action?: PolicySubject['action']
  tool?: string
  pathGlob?: string
  commandPrefix?: string[]
}

export interface PolicyRule {
  /** Stable, journaled as the verdict's `policy`. Never content. */
  id: string
  effect: RuleEffect
  match: RuleMatch
}

export interface PolicyLayer {
  /** `machine`, `user`, `project` — any name; the ORDER of the array is what counts. */
  name: string
  rules: readonly PolicyRule[]
}

/** One thing a rule is asked about. */
export interface RuleTarget {
  action: PolicySubject['action']
  tool: string
  /** Absolute path, or null when the part has none / it could not be known. */
  path?: string | null
  /** Every argv stage a DENY/ASK rule may match (outermost first). */
  anyStages?: readonly (readonly string[])[]
  /** The stages an ALLOW rule may match. Empty: no allow rule can match this part. */
  allowStages?: readonly (readonly string[])[]
}

export interface RuleEnv {
  home: string
  workspaceRoot: string
}

export interface RuleHit {
  rule: PolicyRule
  layer: string
  layerIndex: number
}

function basename(p: string): string {
  const i = p.lastIndexOf('/')
  return i === -1 ? p : p.slice(i + 1)
}

function prefixMatches(prefix: readonly string[], argv: readonly string[]): boolean {
  if (prefix.length === 0 || prefix.length > argv.length) return false
  for (let i = 0; i < prefix.length; i++) {
    const want = prefix[i]
    const got = argv[i]
    if (got === undefined || want === undefined) return false
    if (got === want) continue
    if (i === 0 && basename(got) === want) continue
    return false
  }
  return true
}

const globCache = new Map<string, RegExp>()

function escapeRe(s: string): string {
  return s.replace(/[.+^${}()|\\]/g, '\\$&')
}

/** Expands `~` and anchors a relative glob at the workspace root. */
export function absoluteGlob(glob: string, env: RuleEnv): string {
  if (glob === '~') return env.home
  if (glob.startsWith('~/')) return env.home.replace(/\/$/, '') + glob.slice(1)
  if (glob.startsWith('/')) return glob
  return env.workspaceRoot.replace(/\/$/, '') + '/' + glob
}

/** Compiles an ABSOLUTE glob to a regular expression. */
export function globToRegExp(glob: string): RegExp {
  const cached = globCache.get(glob)
  if (cached) return cached
  const parts = glob.split('/')
  let re = ''
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i] ?? ''
    const last = i === parts.length - 1
    if (seg === '**') {
      // `a/**` matches `a` and everything below; `a/**/b` matches `a/b`, `a/x/b`, …
      re += last ? '(?:/.*)?' : '(?:/[^/]+)*'
      continue
    }
    if (i > 0) re += '/'
    let s = ''
    for (let k = 0; k < seg.length; k++) {
      const c = seg[k] ?? ''
      if (c === '*') s += '[^/]*'
      else if (c === '?') s += '[^/]'
      else if (c === '[') {
        const end = seg.indexOf(']', k + 1)
        if (end === -1) { s += '\\['; continue }
        const body = seg.slice(k + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\')
        s += `[${body}]`
        k = end
      } else s += escapeRe(c)
    }
    re += s
  }
  const compiled = new RegExp(`^${re}$`)
  globCache.set(glob, compiled)
  return compiled
}

export function globMatches(glob: string, path: string, env: RuleEnv): boolean {
  const abs = absoluteGlob(glob, env)
  const target = path.length > 1 ? path.replace(/\/$/, '') : path
  return globToRegExp(abs).test(target)
}

/** Does `rule` match `target`? Every field the rule sets must match. */
export function ruleMatches(rule: PolicyRule, target: RuleTarget, env: RuleEnv): boolean {
  const m = rule.match
  if (m.action !== undefined && m.action !== target.action) return false
  if (m.tool !== undefined && m.tool !== target.tool) return false
  if (m.pathGlob !== undefined) {
    if (!target.path) return false
    if (!globMatches(m.pathGlob, target.path, env)) return false
  }
  if (m.commandPrefix !== undefined) {
    const stages = rule.effect === 'allow' ? target.allowStages : target.anyStages
    if (!stages || !stages.some(st => prefixMatches(m.commandPrefix ?? [], st))) return false
  }
  return true
}

/** [prefix tokens, literal glob characters, fields set] — compared lexicographically. */
export function specificity(rule: PolicyRule): [number, number, number] {
  const m = rule.match
  const prefix = m.commandPrefix?.length ?? 0
  const globLiteral = m.pathGlob ? m.pathGlob.replace(/\*\*|[*?]|\[[^\]]*\]/g, '').length : 0
  const fields = [m.action, m.tool, m.pathGlob, m.commandPrefix].filter(v => v !== undefined).length
  return [prefix, globLiteral, fields]
}

function compareSpecificity(a: PolicyRule, b: PolicyRule): number {
  const sa = specificity(a)
  const sb = specificity(b)
  for (let i = 0; i < 3; i++) {
    const d = (sb[i] ?? 0) - (sa[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

const EFFECT_RANK: Record<RuleEffect, number> = { deny: 0, ask: 1, allow: 2 }

export interface RuleQuery {
  /** Only rules that name a `pathGlob` may decide (used to lift the outside-workspace default). */
  requirePathGlob?: boolean
}

/**
 * The rule that decides `target`, or null when none matches. See the module header for the order.
 * An ALLOW rule whose `commandPrefix` cannot see an allow-stage never matches (opaque segments).
 */
export function decideByRules(layers: readonly PolicyLayer[], target: RuleTarget, env: RuleEnv, q: RuleQuery = {}): RuleHit | null {
  const hits: Array<RuleHit & { order: number }> = []
  let order = 0
  layers.forEach((layer, layerIndex) => {
    for (const rule of layer.rules) {
      order++
      if (q.requirePathGlob && rule.match.pathGlob === undefined) continue
      if (ruleMatches(rule, target, env)) hits.push({ rule, layer: layer.name, layerIndex, order })
    }
  })
  if (hits.length === 0) return null
  const denies = hits.filter(h => h.rule.effect === 'deny')
  const pool = denies.length > 0 ? denies : hits
  pool.sort((a, b) =>
    compareSpecificity(a.rule, b.rule)
    || EFFECT_RANK[a.rule.effect] - EFFECT_RANK[b.rule.effect]
    || a.layerIndex - b.layerIndex
    || a.order - b.order)
  const best = pool[0]
  return best ? { rule: best.rule, layer: best.layer, layerIndex: best.layerIndex } : null
}

/**
 * Checks a layer set for rules that cannot mean what they say. Returned as sentences; the policy
 * does not refuse to start (a typo must not brick a session), but a host can show them.
 */
export function lintLayers(layers: readonly PolicyLayer[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const layer of layers) {
    for (const r of layer.rules) {
      if (seen.has(r.id)) out.push(`rule id "${r.id}" is used more than once`)
      seen.add(r.id)
      if (r.match.commandPrefix !== undefined && r.match.commandPrefix.length === 0) {
        out.push(`rule "${r.id}" has an empty commandPrefix and matches no command`)
      }
      if (Object.values(r.match).every(v => v === undefined)) {
        out.push(`rule "${r.id}" matches EVERYTHING (no match field set)`)
      }
    }
  }
  return out
}

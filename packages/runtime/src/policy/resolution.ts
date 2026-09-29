/**
 * policy/resolution.ts — a shell segment that changes what a LATER command resolves to, or what git
 * will execute (B3 security review F3, and the `git config` half of F2; spec §8 D-T3.S2/S3).
 *
 * The shell tool keeps ONE long-lived bash (`tools/shell/tools.ts`), so an `export PATH=…` in one
 * call survives into the next, and an ALLOWLISTED bare `ls` two calls later runs whatever `ls` the
 * new PATH finds first. The policy judges each call on its own text, so it cannot see that link —
 * what it CAN do is refuse to let the first call through unasked. Decision: every segment that sets
 * a resolution-changing variable, defines an alias, pins a `hash`, loads a builtin, or rewrites git's
 * configuration is an ASK that no allow rule and no session approval lifts (a deny rule still
 * denies). The alternative — resolving every allowlisted bare command by absolute path — would have
 * to be enforced in the SHELL (the policy only sees text), would still leave `alias` and functions
 * open, and would break every legitimate PATH the person set on purpose. Asking once, with the
 * assignment named, keeps the person in the loop at the one moment the change is made.
 *
 * PURE: text in, a sentence (or null) out.
 */

import { gitSubcommandIndex } from './floor.ts'
import { commandName, type ShellSegment } from './shell-parse.ts'

/** Exact names whose value changes what a later command finds, loads, or runs. */
const DANGEROUS_EXACT = new Set([
  'PATH', 'IFS', 'CDPATH', 'HOME', 'ENV', 'BASH_ENV', 'SHELLOPTS', 'BASHOPTS', 'PROMPT_COMMAND', 'PS4',
  'GLOBIGNORE', 'NODE_OPTIONS', 'NODE_PATH', 'PYTHONPATH', 'PYTHONSTARTUP', 'PYTHONHOME',
  'PERL5OPT', 'PERL5LIB', 'PERL5DB', 'RUBYOPT', 'RUBYLIB', 'JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'JDK_JAVA_OPTIONS',
  'EDITOR', 'VISUAL', 'PAGER', 'MANPAGER', 'LESSOPEN', 'LESSCLOSE', 'SSH_ASKPASS', 'SUDO_ASKPASS', 'BROWSER',
])
/** Name PREFIXES of the same kind: the dynamic loader, and every `GIT_*` (config, dir, ssh, askpass, exec path…). */
const DANGEROUS_PREFIXES = ['LD_', 'DYLD_', 'GIT_', 'BASH_FUNC_']

export function dangerousVar(name: string): boolean {
  return DANGEROUS_EXACT.has(name) || DANGEROUS_PREFIXES.some(p => name.startsWith(p))
}

/** `NAME=…` / `NAME+=…` → `NAME`; a bare `NAME` → itself; anything else → null. */
function varName(word: string): string | null {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)(\+?=|$)/.exec(word)
  return m ? (m[1] ?? null) : null
}

/** Builtins whose operands NAME variables they set or export. */
const DECLARERS = new Set(['export', 'declare', 'typeset', 'readonly', 'local', 'read', 'mapfile', 'readarray', 'getopts'])

// ── git ─────────────────────────────────────────────────────────────────────────────────────────

/** `git config` keys that change nothing git executes. Case-insensitive, like git's own keys. */
const SAFE_GIT_KEY = /^(user\.(name|email)|color\..+|advice\..+|init\.defaultbranch|pull\.rebase|push\.autosetupremote|log\..+|i18n\..+|column\..+|help\.autocorrect)$/i
const GIT_CONFIG_READS = new Set(['--get', '--get-all', '--get-regexp', '--get-urlmatch', '--get-color', '--get-colorbool', '--list', '-l', '--show-origin', '--show-scope', '--name-only', '--null', '-z', '--includes', '--no-includes', '--type', '--default', '--bool', '--int', '--path', '--expiry-date'])

export interface GitConfigPlan {
  /** The `-f`/`--file` target, when the invocation WRITES a config file named by path. */
  file: string | null
  /** Why this changes what git runs, or null when it does not. */
  sentence: string | null
}

/** Where the git SUB-command starts, after the global options. */
function gitSub(argv: readonly string[]): number {
  return gitSubcommandIndex(argv)
}

/**
 * `git -c k=v …` / `git --config-env=…` (per-run config) and a `git config` that SETS a key: both can
 * point `core.hooksPath`, `core.fsmonitor`, `core.pager`, `core.sshCommand`, an `alias.*` or a
 * filter at a program git will then execute. Harmless keys (`user.name`, `color.*`, …) pass.
 */
export function gitConfigPlan(seg: ShellSegment): GitConfigPlan | null {
  const argv = seg.argv
  if (commandName(argv[0] ?? '') !== 'git') return null
  const sub = gitSub(argv)
  for (let i = 1; i < sub; i++) {
    const t = argv[i] ?? ''
    if (t === '-c') {
      const kv = argv[i + 1] ?? ''
      const key = kv.split('=')[0] ?? ''
      if (!SAFE_GIT_KEY.test(key)) return { file: null, sentence: `\`git -c ${key}=…\` sets git configuration for this run, which can make git execute another program` }
    }
    if (t === '--config-env' || t.startsWith('--config-env=')) {
      return { file: null, sentence: '`git --config-env` sets git configuration from the environment, which can make git execute another program' }
    }
  }
  if (argv[sub] !== 'config') return null
  const rest = argv.slice(sub + 1)
  let file: string | null = null
  const operands: string[] = []
  let reads = false
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i] ?? ''
    if (t === '-f' || t === '--file' || t === '--blob') { if (t !== '--blob') file = rest[i + 1] ?? null; i++; continue }
    if (t.startsWith('--file=')) { file = t.slice('--file='.length); continue }
    if (GIT_CONFIG_READS.has(t) || t.startsWith('--type=') || t.startsWith('--default=')) {
      if (/^--(get|list)|^-l$/.test(t)) reads = true
      if (t === '--type' || t === '--default') i++
      continue
    }
    if (t.startsWith('-')) continue // --global/--system/--local/--worktree/--unset/--add/--replace-all…: scope or a write verb
    operands.push(t)
  }
  // The newer sub-command syntax: `git config get|list|set|unset|…`.
  const verb = operands[0]
  if (verb === 'get' || verb === 'list') reads = true
  if (reads) return null
  const key = verb === 'set' || verb === 'unset' || verb === 'rename-section' || verb === 'remove-section' ? operands[1] : verb
  if (key === undefined) return null // `git config` with no key: prints usage
  if (SAFE_GIT_KEY.test(key) && file === null) return null
  return { file, sentence: `\`git config\` sets \`${key}\`, which can make git execute another program` }
}

// ── the segment ─────────────────────────────────────────────────────────────────────────────────

/**
 * What in this segment changes command resolution for itself or for LATER calls in the same shell,
 * as a clause for the approval question — or null. Git configuration is `gitConfigPlan`'s.
 */
export function resolutionChange(seg: ShellSegment): string | null {
  for (const a of seg.assignments) {
    const n = varName(a)
    if (n && dangerousVar(n)) return `sets \`${n}\`, which changes what later commands resolve to or load`
  }
  const name = commandName(seg.argv[0] ?? '')
  if (DECLARERS.has(name)) {
    for (const w of seg.words.slice(1)) {
      // The NAME must be literal (varName requires it); the VALUE may be dynamic (`PATH=/x:$PATH`).
      if (w.home || w.text.startsWith('-')) continue
      const n = varName(w.text)
      if (n && dangerousVar(n)) return `\`${name}\` sets \`${n}\`, which changes what later commands resolve to or load`
    }
  }
  if (name === 'printf') {
    const i = seg.argv.indexOf('-v')
    const n = i > 0 ? varName(seg.argv[i + 1] ?? '') : null
    if (n && dangerousVar(n)) return `\`printf -v\` sets \`${n}\`, which changes what later commands resolve to or load`
  }
  if (name === 'alias' && seg.argv.slice(1).some(a => a.includes('='))) return '`alias` redefines what a command name runs in this shell'
  if (name === 'hash' && seg.argv.slice(1).some(a => a === '-p' || /^-[a-z]*p/.test(a))) return '`hash -p` pins a command name to another binary in this shell'
  if (name === 'enable' && seg.argv.length > 1) return '`enable` loads or disables shell builtins, which changes what a command name runs'
  return null
}

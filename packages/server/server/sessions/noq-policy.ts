/**
 * noq-policy.ts — what a session in `no-questions` mode answers when its harness asks anyway.
 *
 * Claude Code still draws a permission prompt under `bypassPermissions` for a FEW commands (a `cd`
 * outside the project inside a compound command, a write outside the project). Nobody is there to
 * answer, so the session sat on "THIS SESSION IS ASKING" forever. This decides the answer.
 *
 * THE POLICY IS A POSITIVE ALLOW-LIST, and everything it does not name is refused. Three rounds of QA
 * proved a deny set cannot close: program names are unbounded (`npx`, `busybox`, `unshare`,
 * `script -c`, `python3 x.py`, `agentop run -- rm …`). A refusal is never a hang — the session gets
 * "No" plus a typed reason and rephrases — so strictness costs one rephrase, while one wrong "Yes" can
 * cost a machine. A command is approved only when it is ONE line, ONE simple argv (no shell syntax the
 * harness could read differently from us), its program is named by bare basename and is on the list,
 * and every argument passes that program's own rule. Writing verbs only reach paths STRICTLY inside the
 * session cwd or `/tmp/<name>`, resolved through `realpath` (symlinks followed), never the cwd itself
 * nor an ancestor of it, never ~/.agentistics. `cd` is always refused: the policy cannot know the live
 * shell cwd, so a relative path is only meaningful while nothing ever changes it.
 *
 *  - `approve` — on the allow-list;
 *  - `deny` — everything else the policy can read;
 *  - `skip` — not our business (another mode, another harness, not a Yes/No permission prompt, a dialog
 *    shape this reader does not know). The session keeps waiting for a person exactly as before.
 *
 * THE DIALOG is read off the SCREEN. Measured on claude 2.1.326 (2026-11-21, leader/qa/noq-trava-r4/live):
 *
 *     Bash command
 *     Tip: auto mode handles these prompts for you — …
 *     Create marker file                                  ← the description (dim), ABOVE the command
 *     ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 *     touch marker.txt                                    ← the command (a multi-line one gets a `│ ` gutter)
 *     ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 *     Do you want to proceed?
 *     ❯ 1. Yes … 4. No
 *
 * Older releases drew the command indented under the header with the dim description BELOW it and no
 * rules; there the description is told apart by its SGR dim attribute (an ANSI capture), and without
 * one a two-line block is refused rather than guessed. A command spanning more than one line, a second
 * "Do you want to…" anywhere before the final prompt, or a second header are refused.
 */
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path'

export interface NoqDialog {
  harness?: string
  /** The session's CURRENT canonical mode (`SessionView.mode.canonical`, or the runner's best knowledge of it). */
  mode?: string
  cwd: string
  /** The dialog as the fleet read it (plain). Used when no fresher `frame` is given. */
  approvalLines?: string[]
  /** A fresh capture of the pane, ANSI allowed (it is what tells the old layout's dim description apart). */
  frame?: string[]
  dialogOptions?: ReadonlyArray<{ number: number; label: string }>
}

/** The filesystem facts the path rule needs. Injected so the rule is testable; the default reads the disk. */
export interface NoqFs {
  /** `realpath`, or null when the path does not exist (or cannot be resolved). */
  realpath(p: string): string | null
  /** Is `p` itself a symlink (lstat)? */
  isSymlink(p: string): boolean
  /** The branch checked out in `cwd`, or null when it cannot be read. */
  branch(cwd: string): string | null
}

export interface NoqEnv { home: string; fs?: NoqFs }

export type NoqRule =
  | 'allowed' | 'not-simple' | 'multi-line' | 'dialog-shape' | 'cd' | 'not-allowed' | 'kill' | 'interpreter'
  | 'runner' | 'wrapper' | 'write-outside' | 'agentistics-write' | 'agentistics-port' | 'agentop' | 'git' | 'push'

export type NoqDecision =
  | { action: 'skip'; why: string }
  | { action: 'approve' | 'deny'; choice: number; rule: NoqRule; command: string; reason: string }

type Verdict = { rule: NoqRule; reason: string }
const refuse = (rule: NoqRule, reason: string): Verdict => ({ rule, reason })

const R = {
  simple: 'Autonomous mode: run ONE simple command per call — no ;, &&, |, $(), redirections, globs, ~ or $VARS. Use absolute paths inside your worktree.',
  multiLine: 'Autonomous mode: a command must fit on one line; send one simple command per call.',
  shape: 'Autonomous mode: this permission prompt could not be read unambiguously; send one simple command per call.',
  cd: 'Autonomous mode: do not cd. Use absolute paths inside your worktree instead (git -C is not auto-approved either).',
  kill: 'Autonomous mode: never kill processes yourself; ask your leader (agentistics_session_message) to stop it.',
  interp: 'Autonomous mode: interpreters and scripts are not auto-approved. Run tests with `agentop run --rm -- bun test <files>`, or ask your leader.',
  runner: 'Autonomous mode: package runners (npx, bunx, npm run, make …) are not auto-approved. Run tests with `agentop run --rm -- bun test <files>`, or ask your leader.',
  wrapper: 'Autonomous mode: run the program directly; wrappers (timeout, nohup, xargs, env with arguments, script, busybox …) are not auto-approved.',
  path: 'Autonomous mode: file operations only on explicit paths STRICTLY inside your worktree or /tmp/<name>/ — never the worktree itself, an ancestor, a symlink leading elsewhere, or `..`.',
  data: 'Autonomous mode: never touch ~/.agentistics directly; go through agentop or the API.',
  port: 'Autonomous mode: ports 47291/47292 belong to agentistics; do not touch them. Use a throwaway server on another port.',
  agentop: 'Autonomous mode: only `agentop --version|--help|status`, `agentop session list` and `agentop run --rm -- bun test <files in your worktree>` are auto-approved.',
  push: 'Autonomous mode: only `git push origin <your current branch>` (not main/master/dev, no force, no delete, no refspecs) is auto-approved.',
  slashProgram: 'Autonomous mode: call programs by their bare name (ls, git …), never by a path or quoted.',
}
const notAllowed = (p: string): Verdict =>
  refuse('not-allowed', `Autonomous mode: \`${p}\` is not on the autonomous allow-list (read-only tools, git/gh read verbs, file operations inside your worktree or /tmp/<name>/). Use the Edit/Write tools for files, or ask your leader.`)
const gitNo = (what: string): Verdict =>
  refuse('git', `Autonomous mode: \`git ${what}\` is not auto-approved. Allowed: status, log, show, diff, branch (list), rev-parse, ls-files, ls-remote, remote -v, worktree list, blame, grep, describe, fetch, add, commit -m, restore --staged, switch -c, checkout -b, stash push/list/show, push origin <your branch>. No -C/-c/--git-dir.`)

/* ───────────────────────────── the screen ───────────────────────────── */

/** One captured line → its text (ANSI removed) and whether every visible character was drawn dim. */
interface ScreenLine { text: string; dim: boolean }

function readScreen(raw: readonly string[]): { lines: ScreenLine[]; ansi: boolean } {
  let dim = false
  let ansi = false
  const lines = raw.map(line => {
    let text = ''
    let visible = 0
    let dimVisible = 0
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!
      if (ch === '\x1b') {
        ansi = true
        const csi = /^\x1b\[([0-9;:?]*)([A-Za-z])/.exec(line.slice(i))
        if (csi) {
          if (csi[2] === 'm') {
            const codes = csi[1] === '' ? ['0'] : csi[1]!.split(/[;:]/)
            for (const c of codes) { if (c === '0' || c === '') dim = false; else if (c === '2') dim = true; else if (c === '22') dim = false }
          }
          i += csi[0].length - 1
          continue
        }
        const osc = /^\x1b\][^\x07\x1b]*(\x07|\x1b\\)/.exec(line.slice(i))
        if (osc) { i += osc[0].length - 1; continue }
        continue
      }
      text += ch
      // Box and gutter glyphs are the dialog's frame, not its content: they do not decide "dim".
      if (ch.trim() && !/[│┃╭╮╰╯─━]/.test(ch)) { visible++; if (dim) dimVisible++ }
    }
    return { text, dim: visible > 0 && dimVisible === visible }
  })
  return { lines, ansi }
}

/** A boxed layout's `│ … │` borders come off; a bare `│ ` gutter (multi-line command) stays, so it is seen. */
function unbox(t: string): string {
  const s = t.replace(/\s+$/, '')
  if (/^\s*[│┃]/.test(s) && /[│┃]$/.test(s)) return s.replace(/^\s*[│┃]/, '').replace(/[│┃]$/, '').trim()
  if (/^[\s╭╮╰╯─┌┐└┘━]*$/.test(s) && /[╭╮╰╯┌┐└┘]/.test(s)) return ''
  return s.trim()
}

const BASH_HEADER = /^(Bash command|Command|Shell command)$/i
const FILE_HEADER = /^(Create|Edit|Write|Update|Overwrite)( file)?$/i
const QUESTION = /^Do you want to /i
const OPTION = /^(?:❯\s*)?(\d+)\.\s+(.*)$/
const FOOTER = /^(Esc to cancel|Enter to confirm|Tab to amend|ctrl\+|↑|Press )/i
const DASHED = /^╌+$/
const SOLID = /^[─━]{8,}$/
const HEADER_REACH = 40

type Parsed =
  | { kind: 'none' }
  | { kind: 'unknown' }
  | { kind: 'refuse'; rule: NoqRule; reason: string; shown: string; options: Array<{ number: number; label: string }> }
  | { kind: 'bash'; command: string; options: Array<{ number: number; label: string }>; key: string }
  | { kind: 'file'; path: string; options: Array<{ number: number; label: string }>; key: string }

/**
 * The permission dialog at the BOTTOM of a frame. The whole pane may hold conversation history that
 * quotes a dialog, so the reader anchors on the LAST question and walks UP to its header, never past a
 * solid rule (the dialog's own top edge).
 */
export function parseNoqDialog(raw: readonly string[]): Parsed {
  const { lines: screen, ansi } = readScreen(raw)
  const L = screen.map(l => ({ text: unbox(l.text), raw: l.text, dim: l.dim, gutter: /^\s*[│┃]\s/.test(l.text.replace(/\s+$/, '')) && !/[│┃]\s*$/.test(l.text.replace(/\s+$/, '')) }))
  let q = -1
  for (let i = L.length - 1; i >= 0; i--) if (QUESTION.test(L[i]!.text)) { q = i; break }
  if (q < 0) return { kind: 'none' }
  // After the question: options, a footer, blank — anything else is a shape we do not know.
  const options: Array<{ number: number; label: string }> = []
  for (let i = q + 1; i < L.length; i++) {
    const t = L[i]!.text
    if (!t) continue
    const m = OPTION.exec(t)
    if (m) { options.push({ number: Number(m[1]), label: m[2]!.trim() }); continue }
    if (FOOTER.test(t)) continue
    if (options.length > 0 && /^\s{4,}\S/.test(L[i]!.raw.replace(/^\s*[│┃]/, ' '))) continue // a wrapped option label
    return { kind: 'unknown' }
  }
  // Walk up to the header.
  let h = -1
  for (let i = q - 1; i >= 0 && q - i <= HEADER_REACH; i--) {
    const t = L[i]!.text
    if (SOLID.test(t) && !DASHED.test(t)) break
    if (BASH_HEADER.test(t) || FILE_HEADER.test(t)) { h = i; break }
  }
  if (h < 0) return { kind: 'none' }
  // A second header above the one found (the command itself printed one) is not a dialog we can read.
  for (let i = h - 1; i >= 0 && q - i <= HEADER_REACH; i--) {
    const t = L[i]!.text
    if (SOLID.test(t) && !DASHED.test(t)) break
    if (BASH_HEADER.test(t) || FILE_HEADER.test(t) || QUESTION.test(t)) {
      return { kind: 'refuse', rule: 'dialog-shape', reason: R.shape, shown: L.slice(i, q).map(l => l.text).filter(Boolean).join('\n'), options }
    }
  }
  const body = L.slice(h + 1, q)
  const key = L.slice(h).map(l => l.text).filter(Boolean).join('\n')
  const shown = body.map(l => l.text).filter(Boolean).join('\n')
  if (body.some(l => QUESTION.test(l.text))) return { kind: 'refuse', rule: 'dialog-shape', reason: R.shape, shown, options }
  if (body.some(l => BASH_HEADER.test(l.text) || FILE_HEADER.test(l.text))) return { kind: 'refuse', rule: 'dialog-shape', reason: R.shape, shown, options }

  if (FILE_HEADER.test(L[h]!.text)) {
    const path = body.find(l => l.text)?.text ?? ''
    const named = L[q]!.text.match(/^Do you want to (?:make this edit to|create|overwrite|write to|update)\s+(.+?)\??$/i)?.[1]
    if (!path || !named || path.endsWith('/') || basename(path) !== basename(named)) return { kind: 'none' }
    return { kind: 'file', path, options, key }
  }

  const rules = body.map((l, i) => (DASHED.test(l.text) ? i : -1)).filter(i => i >= 0)
  let cmdLines: typeof body
  if (rules.length === 2) {
    cmdLines = body.slice(rules[0]! + 1, rules[1]!).filter(l => l.text)
    if (cmdLines.some(l => l.gutter)) return { kind: 'refuse', rule: 'multi-line', reason: R.multiLine, shown, options }
  } else if (rules.length === 0) {
    // The old layout: the command, then (maybe) its dim description, then Claude's own notes.
    const block: typeof body = []
    for (const l of body) { if (!l.text) { if (block.length) break; continue } block.push(l) }
    cmdLines = ansi ? block.filter(l => !l.dim) : block
    if (ansi && block.length > 0 && block[0]!.dim) return { kind: 'refuse', rule: 'dialog-shape', reason: R.shape, shown, options }
  } else {
    return { kind: 'refuse', rule: 'dialog-shape', reason: R.shape, shown, options }
  }
  if (cmdLines.length === 0) return { kind: 'refuse', rule: 'dialog-shape', reason: R.shape, shown, options }
  if (cmdLines.length > 1) return { kind: 'refuse', rule: 'multi-line', reason: R.multiLine, shown: cmdLines.map(l => l.text).join('\n'), options }
  return { kind: 'bash', command: cmdLines[0]!.text, options, key }
}

/** The identity of the dialog on a frame (header → options, text only). '' when there is none. */
export function noqDialogKey(raw: readonly string[]): string {
  const p = parseNoqDialog(raw)
  if (p.kind === 'bash' || p.kind === 'file') return p.key
  return ''
}

/* ───────────────────────────── paths ───────────────────────────── */

export const diskFs: NoqFs = {
  realpath(p) { try { return realpathSync(p) } catch { return null } },
  isSymlink(p) { try { return lstatSync(p).isSymbolicLink() } catch { return false } },
  branch(cwd) {
    try {
      let dir = resolve(cwd)
      for (;;) {
        const dot = join(dir, '.git')
        let gitDir: string | null = null
        try {
          if (statSync(dot).isDirectory()) gitDir = dot
          else {
            const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dot, 'utf8'))
            if (m) gitDir = resolve(dir, m[1]!.trim())
          }
        } catch { /* not here */ }
        if (gitDir) {
          const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim()
          return /^ref: refs\/heads\/(.+)$/.exec(head)?.[1] ?? null
        }
        const up = dirname(dir)
        if (up === dir) return null
        dir = up
      }
    } catch { return null }
  },
}

interface Ctx { cwd: string; home: string; fs: NoqFs }

function strictlyInside(path: string, root: string): boolean {
  const r = root.endsWith(sep) ? root : root + sep
  return path.startsWith(r) && path.length > r.length
}
const insideOrEqual = (p: string, root: string): boolean => p === root || strictlyInside(p, root)

function dataDirs(home: string): string[] {
  return [resolve(home, '.agentistics'), process.env.AGENTISTICS_HOME, process.env.AGENTISTICS_DATA_DIR]
    .filter((x): x is string => !!x).map(x => resolve(x))
}

/** The real location of `abs`: realpath of the longest existing prefix plus the rest. Null = refuse. */
function realOf(abs: string, fs: NoqFs): string | null {
  const parts: string[] = []
  let p = abs
  for (;;) {
    if (fs.isSymlink(p) && fs.realpath(p) === null) return null // a dangling link: a write would land wherever it points
    const r = fs.realpath(p)
    if (r !== null) return parts.length ? join(r, ...parts.reverse()) : r
    const up = dirname(p)
    if (up === p) return null
    parts.push(basename(p))
    p = up
  }
}

const absOf = (arg: string, cwd: string): string => normalize(isAbsolute(arg) ? arg : resolve(cwd, arg))

function touchesData(arg: string, c: Ctx): boolean {
  const v = arg.replace(/^--?[A-Za-z][\w-]*=/, '')
  if (!v || v.startsWith('-')) return false
  const abs = absOf(v, c.cwd)
  const real = realOf(abs, c.fs) ?? abs
  return dataDirs(c.home).some(d => insideOrEqual(abs, d) || insideOrEqual(real, d) || insideOrEqual(real, c.fs.realpath(d) ?? d))
}

const PROTECTED_TMP = /^(\.|tmux-|agentistics|agentop|systemd-|ssh-|snap|pulse-|dbus-)/

/**
 * May a writing verb touch `arg`? Strictly inside the cwd or strictly inside /tmp (a non-system entry),
 * after following every symlink; never the cwd, an ancestor of it, or ~/.agentistics.
 */
export function writablePath(arg: string, cwd: string, home: string, fs: NoqFs = diskFs): Verdict | null {
  const c: Ctx = { cwd, home, fs }
  if (!arg || arg.startsWith('-') || /(^|\/)\.\.(\/|$)/.test(arg)) return refuse('write-outside', R.path)
  const abs = absOf(arg, cwd)
  if (touchesData(arg, c)) return refuse('agentistics-write', R.data)
  const real = realOf(abs, fs)
  if (real === null) return refuse('write-outside', R.path)
  // `rm -rf link/` empties the TARGET, `rm link` names one leading elsewhere: `real` followed it either way.
  const cwdReal = fs.realpath(cwd) ?? resolve(cwd)
  const cwdAbs = resolve(cwd)
  for (const base of [cwdReal, cwdAbs]) if (insideOrEqual(base, real) || insideOrEqual(base, abs)) return refuse('write-outside', R.path)
  if (strictlyInside(real, cwdReal)) return null
  const tmpReal = fs.realpath('/tmp') ?? '/tmp'
  for (const tmp of new Set([tmpReal, '/tmp'])) {
    if (strictlyInside(real, tmp)) {
      const first = real.slice(tmp.length + 1).split(sep)[0]!
      return PROTECTED_TMP.test(first) ? refuse('write-outside', R.path) : null
    }
  }
  return refuse('write-outside', R.path)
}

/* ───────────────────────────── the command ───────────────────────────── */

interface Tok { text: string; quoted: boolean }
const UNQUOTED_META = /[;&|`$(){}<>\\\n\r*?[\]!]/

/** One argv or null. Any construct a shell could read differently from this reader → null. */
function tokenize(cmd: string): Tok[] | null {
  const out: Tok[] = []
  let cur = ''
  let has = false
  let quoted = false
  let q: '' | "'" | '"' = ''
  for (const ch of cmd) {
    if (q === "'") { if (ch === "'") q = ''; else if (ch === '\n' || ch === '\r') return null; else cur += ch; continue }
    if (q === '"') {
      if (ch === '"') q = ''
      else if (/[$`\\!\n\r]/.test(ch)) return null
      else cur += ch
      continue
    }
    if (ch === "'" || ch === '"') { q = ch; has = true; quoted = true; continue }
    if (ch === ' ' || ch === '\t') { if (has) { out.push({ text: cur, quoted }); cur = ''; has = false; quoted = false } continue }
    if (UNQUOTED_META.test(ch)) return null
    if ((ch === '~' || ch === '#') && !has) return null
    cur += ch
    has = true
  }
  if (q) return null
  if (has) out.push({ text: cur, quoted })
  return out
}

const KILLERS = new Set(['kill', 'pkill', 'killall', 'fuser', 'skill', 'xkill'])
const INTERPRETERS = /^(bash|sh|zsh|dash|ksh|fish|csh|tcsh|ash|python[\d.]*|pypy[\d.]*|node|nodejs|bun|deno|perl|ruby|php|lua|tclsh|osascript|pwsh|powershell|awk|gawk|mawk|nawk|irb|ipython|R|Rscript|java|go)$/
const RUNNERS = new Set(['npx', 'bunx', 'pnpx', 'pnpm', 'npm', 'yarn', 'make', 'gmake', 'cargo', 'just', 'task', 'turbo', 'nx', 'lerna', 'docker', 'podman', 'ssh', 'scp'])
const WRAPPERS = new Set([
  'timeout', 'nice', 'ionice', 'nohup', 'setsid', 'flock', 'watch', 'taskset', 'strace', 'ltrace', 'script', 'busybox', 'toybox',
  'setpriv', 'unshare', 'nsenter', 'tmux', 'screen', 'chroot', 'xargs', 'parallel', 'command', 'exec', 'builtin', 'time', 'stdbuf',
  'sudo', 'su', 'doas', 'pkexec', 'runuser', 'eval', 'source', '.', 'chrt', 'systemd-run', 'firejail', 'bwrap', 'faketime', 'expect',
])

type ArgRule = (args: string[], c: Ctx) => Verdict | null
const ok: ArgRule = () => null
const noFlag = (bad: RegExp, what: string): ArgRule => args => (args.some(a => bad.test(a)) ? notAllowed(what) : null)

/** Read-only programs and the one rule each needs (an option that writes or runs something). */
const READ_ONLY: Record<string, ArgRule> = {
  ls: ok, cat: ok, head: ok, tail: ok, wc: ok, grep: ok, egrep: ok, fgrep: ok, stat: ok, du: ok, df: ok, pwd: ok,
  echo: ok, printf: ok, which: ok, type: ok, diff: ok, cut: ok, tr: ok, jq: ok, realpath: ok, basename: ok, dirname: ok,
  free: ok, uptime: ok, id: ok, whoami: ok, uname: ok, ps: ok, pgrep: ok,
  rg: noFlag(/^--pre/, 'rg --pre'),
  find: noFlag(/^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/, 'find -delete/-exec/-ok/-fprint'),
  sort: noFlag(/^(-o|--output|--compress-program)/, 'sort -o'),
  tree: noFlag(/^(-o|--o)/, 'tree -o'),
  file: noFlag(/^(-C|--compile)/, 'file -C'),
  date: noFlag(/^(-s|--set)/, 'date -s'),
  uniq: (args) => (args.filter(a => !a.startsWith('-')).length > 1 ? notAllowed('uniq <in> <out>') : null),
  env: (args) => (args.length > 0 ? refuse('wrapper', R.wrapper) : null),
}

const GIT_READ = new Set(['status', 'log', 'show', 'diff', 'branch', 'rev-parse', 'ls-files', 'ls-remote', 'remote', 'worktree', 'blame', 'grep', 'describe', 'fetch'])
const GIT_BAD = /^(--output|--ext-diff|--textconv|--upload-pack|--receive-pack|--exec|--open-files-in-pager|-O|--config|--git-dir|--work-tree|--exec-path|--namespace)/
const PROTECTED_BRANCH = /^(main|master|dev)$/
const BRANCH_NAME = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/

function stagePath(arg: string, c: Ctx): Verdict | null {
  if (arg === '.' || arg === './') return null
  if (/(^|\/)\.\.(\/|$)/.test(arg)) return refuse('write-outside', R.path)
  const abs = absOf(arg, c.cwd)
  const real = realOf(abs, c.fs) ?? abs
  const cwdReal = c.fs.realpath(c.cwd) ?? resolve(c.cwd)
  return insideOrEqual(real, cwdReal) ? null : refuse('write-outside', R.path)
}

function gitVerdict(args: string[], c: Ctx): Verdict | null {
  const sub = args[0]
  if (!sub || sub.startsWith('-')) return gitNo(args.join(' '))
  const rest = args.slice(1)
  if (GIT_READ.has(sub)) {
    if (rest.some(a => GIT_BAD.test(a))) return gitNo(`${sub} ${rest.find(a => GIT_BAD.test(a))}`)
    if (sub === 'branch') {
      const okFlags = new Set(['-a', '-r', '-v', '-vv', '--all', '--remotes', '--show-current', '--list', '-l', '--verbose', '--no-color'])
      return rest.every(a => okFlags.has(a)) ? null : gitNo(`branch ${rest.join(' ')}`)
    }
    if (sub === 'remote') return rest.length === 0 || (rest.length === 1 && rest[0] === '-v') ? null : gitNo(`remote ${rest.join(' ')}`)
    if (sub === 'worktree') return rest[0] === 'list' && rest.slice(1).every(a => a === '--porcelain' || a === '-v') ? null : gitNo(`worktree ${rest.join(' ')}`)
    if (sub === 'fetch' || sub === 'ls-remote') {
      const okFlags = new Set(['--prune', '-p', '--all', '--tags', '--no-tags', '-q', '--quiet', '-v', '--dry-run', '--heads', '--refs'])
      return rest.every(a => !a.startsWith('-') || okFlags.has(a)) ? null : gitNo(`${sub} ${rest.join(' ')}`)
    }
    return null
  }
  switch (sub) {
    case 'add': {
      const okFlags = new Set(['-A', '--all', '-u', '--update', '-N', '--intent-to-add', '-v', '--verbose', '--'])
      for (const a of rest) {
        if (a.startsWith('-')) { if (!okFlags.has(a)) return gitNo(`add ${a}`); continue }
        const v = stagePath(a, c); if (v) return v
      }
      return null
    }
    case 'commit': {
      for (let i = 0; i < rest.length; i++) {
        const a = rest[i]!
        if (a === '-m' || a === '--message' || /^-[aqsv]+m$/.test(a)) { if (rest[i + 1] === undefined) return gitNo('commit -m'); i++; continue }
        if (a.startsWith('--message=') || /^-[aqsv]+$/.test(a) || a === '--all' || a === '--signoff' || a === '--quiet' || a === '--verbose') continue
        return gitNo(`commit ${a}`)
      }
      return rest.length > 0 ? null : gitNo('commit (no -m)')
    }
    case 'restore': {
      if (!rest.includes('--staged') || rest.some(a => a === '--worktree' || a === '-W' || a.startsWith('-s') || a.startsWith('--source'))) return gitNo(`restore ${rest.join(' ')}`)
      for (const a of rest) {
        if (a === '--staged' || a === '--') continue
        if (a.startsWith('-')) return gitNo(`restore ${a}`)
        const v = stagePath(a, c); if (v) return v
      }
      return null
    }
    case 'switch': case 'checkout': {
      const flag = sub === 'switch' ? '-c' : '-b'
      return rest.length === 2 && rest[0] === flag && BRANCH_NAME.test(rest[1]!) ? null : gitNo(`${sub} ${rest.join(' ')}`)
    }
    case 'stash': {
      if (rest.length === 0 || (rest.length === 1 && (rest[0] === 'list' || rest[0] === 'show'))) return null
      if (rest[0] === 'push' && (rest.length === 1 || (rest.length === 3 && (rest[1] === '-m' || rest[1] === '--message')))) return null
      return gitNo(`stash ${rest.join(' ')}`)
    }
    case 'push': {
      const r = rest[0] === '-u' || rest[0] === '--set-upstream' ? rest.slice(1) : rest
      const cur = c.fs.branch(c.cwd)
      if (r.length !== 2 || r[0] !== 'origin' || !cur || r[1] !== cur || PROTECTED_BRANCH.test(cur) || !BRANCH_NAME.test(cur)) return refuse('push', R.push)
      return null
    }
    default:
      return gitNo(sub)
  }
}

function ghVerdict(args: string[]): Verdict | null {
  const [area, verb] = args
  const reads: Record<string, string[]> = { pr: ['view', 'list', 'diff', 'checks'], run: ['view', 'list'], release: ['view', 'list'] }
  if (area && verb && reads[area]?.includes(verb)) return null
  if (area === 'api' && !args.slice(1).some(a => /^(-X|--method|-f|-F|--field|--raw-field|--input)/.test(a))) return null
  return notAllowed(`gh ${args.slice(0, 2).join(' ')}`)
}

function agentopVerdict(args: string[], c: Ctx): Verdict | null {
  if (args.length === 1 && /^(--version|-v|version|--help|-h|help|status)$/.test(args[0]!)) return null
  if (args[0] === 'session' && (args[1] === 'list' || args[1] === 'ls') && args.slice(2).every(a => a === '--json')) return null
  if (args[0] === 'run' && args[1] === '--rm' && args[2] === '--' && args[3] === 'bun' && args[4] === 'test' && args.length > 5) {
    const cwdReal = c.fs.realpath(c.cwd) ?? resolve(c.cwd)
    const inside = args.slice(5).every(a => {
      if (a.startsWith('-') || /(^|\/)\.\.(\/|$)/.test(a)) return false
      const abs = absOf(a, c.cwd)
      const real = realOf(abs, c.fs) ?? abs
      return insideOrEqual(real, cwdReal)
    })
    if (inside) return null
  }
  return refuse('agentop', R.agentop)
}

/** Writing verbs: allowed options, then every positional through the path rule. */
const WRITE_FLAGS: Record<string, RegExp> = {
  mkdir: /^(-[pv]+|--parents|--verbose)$/,
  touch: /^(-c|--no-create)$/,
  cp: /^(-[rRapvfnT]+|--recursive|--archive|--force|--no-clobber|--verbose)$/,
  mv: /^(-[vfnT]+|--force|--no-clobber|--verbose)$/,
  rm: /^(-[rRfvd]+|--recursive|--force|--verbose|--dir)$/,
  rmdir: /^(-v|--verbose|--ignore-fail-on-non-empty)$/,
  ln: /^(-[sfnvT]+|--symbolic|--force|--no-dereference|--verbose)$/,
}

function writeVerdict(prog: string, args: string[], c: Ctx): Verdict | null {
  const flags = WRITE_FLAGS[prog]!
  const paths: string[] = []
  let ddash = false
  for (const a of args) {
    if (!ddash && a === '--') { ddash = true; continue }
    if (!ddash && a.startsWith('-')) { if (!flags.test(a)) return notAllowed(`${prog} ${a}`); continue }
    paths.push(a)
  }
  if (paths.length === 0) return refuse('write-outside', R.path)
  if (prog === 'ln') {
    if (paths.length !== 2) return refuse('write-outside', R.path)
    const symbolic = args.some(a => /^-[a-zA-Z]*s/.test(a) || a === '--symbolic')
    const [target, link] = paths as [string, string]
    const lv = writablePath(link, c.cwd, c.home, c.fs)
    if (lv) return lv
    // A symlink's target is read relative to the LINK's directory, not the shell's.
    if (/(^|\/)\.\.(\/|$)/.test(target)) return refuse('write-outside', R.path)
    const tAbs = isAbsolute(target) ? target : symbolic ? join(dirname(absOf(link, c.cwd)), target) : absOf(target, c.cwd)
    return writablePath(tAbs, c.cwd, c.home, c.fs)
  }
  for (const p of paths) { const v = writablePath(p, c.cwd, c.home, c.fs); if (v) return v }
  return null
}

function judge(argv: Tok[], c: Ctx): Verdict | null {
  if (argv.length === 0) return refuse('not-simple', R.simple)
  const first = argv[0]!
  if (first.quoted || first.text.includes('/')) return refuse('not-allowed', R.slashProgram)
  if (!/^[a-z][a-z0-9._+-]*$/i.test(first.text)) return refuse('not-simple', R.simple)
  const prog = first.text
  const args = argv.slice(1).map(t => t.text)
  if (KILLERS.has(prog)) return refuse('kill', R.kill)
  if (WRAPPERS.has(prog)) return refuse('wrapper', R.wrapper)
  if (INTERPRETERS.test(prog)) return refuse('interpreter', R.interp)
  if (RUNNERS.has(prog)) return refuse('runner', R.runner)
  if (prog === 'git') return gitVerdict(args, c)
  if (prog === 'gh') return ghVerdict(args)
  if (prog === 'agentop') return agentopVerdict(args, c)
  if (prog in WRITE_FLAGS) return writeVerdict(prog, args, c)
  const rule = READ_ONLY[prog]
  if (!rule) return notAllowed(prog)
  if (args.some(a => touchesData(a, c))) return refuse('agentistics-write', R.data)
  return rule(args, c)
}

const CD = /(^|[\s;&|(`])(cd|pushd|popd)(?=$|[\s;&|)])/

/** The refusal for one command text, or null when it is on the allow-list. */
export function commandRule(command: string, cwd: string, home: string, fs: NoqFs = diskFs): Verdict | null {
  if (/\n|\r/.test(command)) return refuse('multi-line', R.multiLine)
  if (/\b4729[12]\b/.test(command)) return refuse('agentistics-port', R.port)
  if (CD.test(command)) return refuse('cd', R.cd)
  const argv = tokenize(command)
  if (!argv) return refuse('not-simple', R.simple)
  return judge(argv, { cwd, home, fs })
}

/** A Write/Edit of `path`: the same path rule as a writing verb. */
export function fileRule(path: string, cwd: string, home: string, fs: NoqFs = diskFs): Verdict | null {
  return writablePath(path, cwd, home, fs)
}

const toEnv = (env: string | NoqEnv | undefined): Required<NoqEnv> => {
  const e = typeof env === 'string' ? { home: env } : (env ?? { home: '/root' })
  return { home: e.home, fs: e.fs ?? diskFs }
}

/** The answer for one dialog. */
export function decideNoqAnswer(d: NoqDialog, envIn?: string | NoqEnv): NoqDecision {
  if (d.harness !== 'claude') return { action: 'skip', why: 'harness' }
  if (d.mode !== 'no-questions') return { action: 'skip', why: 'mode' }
  const env = toEnv(envIn)
  const p = parseNoqDialog(d.frame ?? d.approvalLines ?? [])
  if (p.kind === 'none') return { action: 'skip', why: 'no-command' }
  if (p.kind === 'unknown') return { action: 'skip', why: 'dialog-shape' }
  const opts = p.options.length > 0 ? p.options : (d.dialogOptions ?? [])
  const yes = opts.find(o => /^yes\b/i.test(o.label) && !/always|allow all|don.t ask|do not ask|shift\+tab|auto.accept|auto mode|manually|switch/i.test(o.label))
  const no = opts.find(o => /^no\b/i.test(o.label))
  if (!yes || !no) return { action: 'skip', why: 'not-a-permission-prompt' }
  if (p.kind === 'refuse') return { action: 'deny', choice: no.number, rule: p.rule, command: p.shown, reason: p.reason }
  const shown = p.kind === 'bash' ? p.command : `file: ${p.path}`
  const v = p.kind === 'bash' ? commandRule(p.command, d.cwd, env.home, env.fs) : fileRule(p.path, d.cwd, env.home, env.fs)
  if (v) return { action: 'deny', choice: no.number, rule: v.rule, command: shown, reason: v.reason }
  return { action: 'approve', choice: yes.number, rule: 'allowed', command: shown, reason: 'on the autonomous allow-list' }
}

export interface NoqMemory { lastKey: Map<string, { key: string; atMs: number; ok: boolean }> }
/** A FAILED answer to the same dialog is retried after this. */
export const NOQ_RETRY_MS = 15_000
/**
 * An ANSWERED dialog still on screen after this is answered again: either the keystroke never landed,
 * or the session asked the identical question twice with no poll between (M2). The host re-reads the
 * dialog before typing, so a second answer only ever lands on the same question.
 */
export const NOQ_REPEAT_MS = 10_000

/**
 * May this dialog be answered now? A new dialog (different key) is; the same one again only after
 * `NOQ_REPEAT_MS` (answered) or `NOQ_RETRY_MS` (failed). A dialog that went away is forgotten by the runner.
 */
export function shouldAnswer(mem: NoqMemory, id: string, key: string, nowMs: number): boolean {
  const prev = mem.lastKey.get(id)
  if (prev && prev.key === key && nowMs - prev.atMs < (prev.ok ? NOQ_REPEAT_MS : NOQ_RETRY_MS)) return false
  mem.lastKey.set(id, { key, atMs: nowMs, ok: false })
  return true
}

export function noteAnswerResult(mem: NoqMemory, id: string, ok: boolean): void {
  const prev = mem.lastKey.get(id)
  if (prev) prev.ok = ok
}

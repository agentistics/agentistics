/**
 * noq-policy.ts — PURE. What a session in `no-questions` mode answers when its harness asks anyway.
 *
 * Claude Code still draws a permission prompt under `bypassPermissions` for some commands. Nobody is
 * there to answer, so the session sat on "THIS SESSION IS ASKING" forever. The fleet already reads the
 * dialog (`approvalLines`, `dialogOptions`); this decides the answer.
 *
 * THE POLICY IS AN ALLOW-LIST THAT FAILS CLOSED. A deny list over raw shell text cannot be made safe
 * (`rm -r /tmp/{..,}`, `\rm`, `"r"m`, `cd / && rm -rf usr`, `find / -delete`, `kill $(pgrep …)` all slipped
 * through one), so a command is auto-approved only when it is ONE SIMPLE COMMAND — a single argv with no
 * shell metacharacter or expansion the harness could read differently from us — whose program is not in
 * the dangerous set and whose arguments touch nothing the autonomous rules protect. Anything else gets
 * "No" plus a typed reason; the model rephrases, which is the safe failure and never a hang.
 *
 *  - `approve` — a simple, harmless command, or a Write/Edit inside the cwd or /tmp;
 *  - `deny` — everything else the policy understands;
 *  - `skip` — not our business (another mode, another harness, not a Yes/No permission prompt). The
 *    session keeps waiting for a person exactly as before.
 *
 * STATED LIMITS: a path is resolved against the registry cwd, not the shell's live cwd (a prior `cd`
 * changes it), and symlinks are not followed (the module is pure).
 */
import { basename, resolve, sep } from 'node:path'

export interface NoqDialog {
  harness?: string
  /** The session's CURRENT canonical mode (`SessionView.mode.canonical`, or the runner's best knowledge of it). */
  mode?: string
  cwd: string
  approvalLines?: string[]
  dialogOptions?: ReadonlyArray<{ number: number; label: string }>
}

export type NoqRule =
  | 'allowed' | 'not-simple' | 'dangerous-program' | 'inline-code' | 'rm-outside' | 'force-push'
  | 'agentistics-port' | 'agentop-upgrade' | 'agentistics-write' | 'write-outside'

export type NoqDecision =
  | { action: 'skip'; why: string }
  | { action: 'approve' | 'deny'; choice: number; rule: NoqRule; command: string; reason: string }

type Verdict = { rule: NoqRule; reason: string }

const REASON_SIMPLE = 'Autonomous mode: run one simple command per call: no ;, &&, |, $(), redirections, globs or cd chains; use git -C / absolute paths.'
const stripBox = (l: string): string => l.replace(/[│╭╮╰╯─┃┌┐└┘]/g, ' ').trim()

/** The command text of a Claude permission dialog: what sits between the tool header and the question. */
export function dialogCommand(lines: readonly string[]): string {
  const clean = lines.map(stripBox)
  const q = clean.findIndex(l => /^Do you want to /i.test(l))
  const head = clean.findIndex(l => /^(Bash command|Command|Shell command)$/i.test(l))
  if (head < 0 || q < 0 || q <= head) return ''
  return clean.slice(head + 1, q).filter(Boolean).join('\n')
}

/**
 * The file of a Write/Edit dialog: the first line under the header. It is trusted only when the question
 * names the same leaf ("Do you want to make this edit to a.ts?") — a wrapped, truncated path would
 * otherwise be judged on a prefix.
 */
export function dialogFile(lines: readonly string[]): string {
  const clean = lines.map(stripBox)
  const q = clean.findIndex(l => /^Do you want to /i.test(l))
  const head = clean.findIndex(l => /^(Create|Edit|Write|Update|Overwrite)( file)?$/i.test(l))
  if (head < 0 || q < 0 || q <= head) return ''
  const path = clean.slice(head + 1, q).find(Boolean) ?? ''
  const named = clean[q]!.match(/^Do you want to (?:make this edit to|create|overwrite|write to|update)\s+(.+?)\??$/i)?.[1]
  if (!path || !named || path.endsWith('/') || basename(path) !== basename(named)) return ''
  return path
}

const ALLOWED_ROOTS = ['/tmp']

function strictlyInside(path: string, root: string): boolean {
  const r = root.endsWith(sep) ? root : root + sep
  return path.startsWith(r) && path.length > r.length
}

/**
 * Where a removal may reach (STRICTLY inside, never the root itself): the cwd, /tmp, the throwaway cache,
 * the PARENT project of a worktree (`<project>/.worktrees/<name>`) and any `AGENTISTICS_NOQ_RM_ROOTS`.
 */
export function rmRoots(cwd: string, home: string, extra: readonly string[] = []): string[] {
  const m = cwd.match(/^(.*?)\/\.(?:claude\/)?worktrees\//)
  const fromEnv = (process.env.AGENTISTICS_NOQ_RM_ROOTS ?? '').split(':').filter(Boolean)
  return [resolve(cwd), ...ALLOWED_ROOTS, resolve(home, '.cache/agentistics-throwaway'), ...(m ? [m[1]!] : []), ...fromEnv, ...extra]
}

function toAbs(p: string, cwd: string, home: string): string {
  const v = p.replace(/^--?[A-Za-z][\w-]*=/, '').replace(/^of=/, '')
  if (v === '~') return resolve(home)
  if (v.startsWith('~/')) return resolve(home, v.slice(2))
  return resolve(cwd, v)
}

function dataDirs(home: string): string[] {
  return [resolve(home, '.agentistics'), process.env.AGENTISTICS_HOME, process.env.AGENTISTICS_DATA_DIR]
    .filter((x): x is string => !!x).map(x => resolve(x))
}

function inData(p: string, cwd: string, home: string): boolean {
  const abs = toAbs(p, cwd, home)
  return dataDirs(home).some(d => abs === d || strictlyInside(abs, d))
}

// ── tokenizer ───────────────────────────────────────────────────────────────────────────────────
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

// ── program rules ───────────────────────────────────────────────────────────────────────────────
const ALWAYS_DANGEROUS = new Set([
  'xargs', 'kill', 'pkill', 'killall', 'shred', 'dd', 'sudo', 'su', 'doas', 'pkexec', 'systemctl', 'service',
  'launchctl', 'eval', 'source', '.', 'chroot', 'mount', 'umount', 'reboot', 'shutdown', 'poweroff', 'halt', 'crontab', 'at',
])
const INTERPRETERS = /^(bash|sh|zsh|dash|ksh|fish|csh|tcsh|python[\d.]*|node|nodejs|bun|deno|perl|ruby|php|lua|tclsh|osascript|pwsh|powershell)$/
const WRITERS = new Set(['cp', 'mv', 'tee', 'ln', 'touch', 'truncate', 'install', 'rsync', 'mkdir', 'chmod', 'chown', 'chgrp', 'rm', 'rmdir', 'tar', 'unzip'])
const WRAPPERS = new Set(['command', 'exec', 'nohup', 'setsid', 'time', 'nice', 'ionice', 'stdbuf', 'timeout', 'flock', 'env', 'builtin'])

interface Ctx { cwd: string; home: string; extra: readonly string[] }
const refuse = (rule: NoqRule, reason: string): Verdict => ({ rule, reason })
const danger = (p: string): Verdict => refuse('dangerous-program', `Autonomous mode: \`${p}\` can destroy or disturb things beyond this session and is not auto-approved. Use a narrower, explicit command.`)

function rmVerdict(prog: string, args: string[], c: Ctx): Verdict | null {
  const targets: string[] = []
  let ddash = false
  for (const a of args) {
    if (!ddash && a === '--') { ddash = true; continue }
    if (!ddash && a.startsWith('-')) {
      if (!/^(-[rRfvidI]+|--recursive|--force|--verbose|--dir)$/.test(a)) return refuse('rm-outside', `Autonomous mode: \`${prog}\` option ${a} is not auto-approved.`)
      continue
    }
    targets.push(a)
  }
  const roots = rmRoots(c.cwd, c.home, c.extra)
  const bad = targets.length === 0 || targets.some(t =>
    /(^|\/)\.\.(\/|$)/.test(t) || !roots.some(r => strictlyInside(toAbs(t, c.cwd, c.home), r))
    // never the session's own directory or one of its ancestors (the parent-project root admits both)
    || resolve(c.cwd) === toAbs(t, c.cwd, c.home) || strictlyInside(resolve(c.cwd), toAbs(t, c.cwd, c.home)))
  return bad ? refuse('rm-outside', 'Autonomous mode: removal only strictly inside the session directory or /tmp/<name>, with explicit paths (no .., no globs, not the directory itself).') : null
}

function pushVerdict(rest: string[]): Verdict | null {
  const force = rest.some(a => a === '-f' || a.startsWith('--force') || a === '--mirror' || (/^-[A-Za-z]+$/.test(a) && a.includes('f')))
  const positional = rest.filter(a => !a.startsWith('-'))
  const plus = positional.some(a => a.startsWith('+'))
  const protectedTarget = positional.some(a => /(^|:|\+)(refs\/heads\/)?(main|master|dev)$/.test(a)) || rest.includes('--all')
  if (force || plus || protectedTarget) {
    return refuse('force-push', 'Autonomous mode: no force-push and no push to main/master/dev. Push a normal commit to your own branch.')
  }
  return null
}

function gitVerdict(args: string[], c: Ctx): Verdict | null {
  let i = 0
  while (i < args.length && args[i]!.startsWith('-')) {
    const a = args[i]!
    if (a === '-C' || a === '--git-dir' || a === '--work-tree') {
      if (args[i + 1] && inData(args[i + 1]!, c.cwd, c.home)) return refuse('agentistics-write', 'Autonomous mode: never operate inside ~/.agentistics; go through agentop or the API.')
      i += 2
    } else if (a === '-c' || a === '--namespace' || a === '--exec-path') {
      if (a === '-c' && /alias\.|sshcommand|fsmonitor|pager|editor|hookspath|gpg|credential|diff\.external/i.test(args[i + 1] ?? '')) {
        return refuse('dangerous-program', 'Autonomous mode: this git -c setting can run arbitrary programs; not auto-approved.')
      }
      i += 2
    } else i++
  }
  const sub = args[i]
  const rest = args.slice(i + 1)
  if (sub === 'push') return pushVerdict(rest)
  return null
}

function judge(argv: Tok[], c: Ctx, depth = 0): Verdict | null {
  if (argv.length === 0 || depth > 4) return refuse('not-simple', REASON_SIMPLE)
  const first = argv[0]!
  if (first.quoted || first.text.includes('=')) return refuse('not-simple', REASON_SIMPLE)
  const prog = basename(first.text)
  const args = argv.slice(1).map(t => t.text)

  // The one allowed kill: explicit PIDs the session saved (`kill 1234`, `kill -TERM 1234`). Never 0/1/negative/names.
  if (prog === 'kill') {
    const pids = args.filter(a => !/^-(?:[A-Z]{3,7}|[0-9]{1,2}|s|SIG[A-Z]+)$/.test(a) && a !== '-s')
    return pids.length > 0 && pids.every(a => /^[0-9]+$/.test(a) && Number(a) > 1)
      ? null
      : refuse('dangerous-program', 'Autonomous mode: kill only explicit PIDs you saved (kill <pid>), never names, groups or $(…).')
  }
  if (ALWAYS_DANGEROUS.has(prog) || prog.startsWith('mkfs')) return danger(prog)

  if (WRAPPERS.has(prog)) return judgeWrapper(prog, args, argv, c, depth)

  if (prog === 'rm' || prog === 'rmdir') {
    return rmVerdict(prog, args, c) ?? dataWrite(args, c)
  }
  if (prog === 'find') {
    if (args.some(a => /^-(delete|exec|execdir|ok|okdir|fprint0?|fls|fprintf)$/.test(a))) return danger('find -delete/-exec')
    return null
  }
  if (INTERPRETERS.test(prog)) {
    const lead: string[] = []
    for (const a of args) { if (!a.startsWith('-')) break; lead.push(a) }
    if (lead.some(a => /^-[A-Za-z]*[ceEp][A-Za-z]*$/.test(a) || /^--(eval|print|command)/.test(a))) {
      return refuse('inline-code', 'Autonomous mode: inline code (-c / -e) is not auto-approved; put it in a script file inside your directory and run that.')
    }
    return null
  }
  if (prog === 'curl' && args.some(a => /^-[A-Za-z]*[oOJ][A-Za-z]*$/.test(a) || /^--(output|remote-name|remote-header)/.test(a))) return danger('curl -o/-O')
  if (prog === 'wget' && args.some(a => /^-[A-Za-z]*[OP]$/.test(a) || /^--(output-document|directory-prefix)/.test(a))) return danger('wget -O/-P')
  if (/^(npx|bunx|pnpx|pnpm|npm|bun|yarn)$/.test(prog) && args.some(a => /^agentop(@.*)?$/.test(a)) && args.includes('upgrade')) {
    return refuse('agentop-upgrade', 'Autonomous mode: never run `agentop upgrade`; verify through the API instead.')
  }
  if (prog === 'agentop') {
    if (args.some(a => /^(upgrade|server|restart|autostart)$/.test(a))) {
      return refuse('agentop-upgrade', 'Autonomous mode: never run `agentop upgrade|server|restart|autostart`; use a throwaway (`agentop run --rm`) and verify through the API.')
    }
    return null
  }
  if (prog === 'git') return gitVerdict(args, c) ?? dataWrite(args, c)
  if (prog === 'cd') return args[0] && inData(args[0], c.cwd, c.home) ? refuse('agentistics-write', 'Autonomous mode: do not work inside ~/.agentistics.') : null
  if (/^(awk|gawk|mawk|nawk)$/.test(prog) && args.some(a => /system|getline|\|/.test(a))) return danger('awk with system()/getline')
  if (prog === 'sed') {
    const script = args.filter(a => !a.startsWith('-'))
    if (script.some(a => /\/[0-9gIipm]*[ew](?=$|[;\s}])/.test(a) || /^[0-9,$]*[ew]\b/.test(a))) return danger('sed with e/w commands')
  }
  if (prog === 'tar') {
    if (args.some(a => /^--(to-command|checkpoint-action|use-compress-program)/.test(a) || a === '-I')) return danger('tar with a program hook')
    const i = args.findIndex(a => a === '-C' || a === '--directory' || a.startsWith('--directory='))
    const dir = i < 0 ? undefined : args[i]!.includes('=') ? args[i]!.split('=')[1] : args[i + 1]
    if (dir !== undefined && !rmRoots(c.cwd, c.home, c.extra).some(r => toAbs(dir, c.cwd, c.home) === r || strictlyInside(toAbs(dir, c.cwd, c.home), r))) {
      return refuse('write-outside', 'Autonomous mode: extract only into the session directory or /tmp.')
    }
  }
  if (prog === 'unzip') {
    const i = args.indexOf('-d')
    const dir = i < 0 ? undefined : args[i + 1]
    if (dir !== undefined && !rmRoots(c.cwd, c.home, c.extra).some(r => toAbs(dir, c.cwd, c.home) === r || strictlyInside(toAbs(dir, c.cwd, c.home), r))) {
      return refuse('write-outside', 'Autonomous mode: extract only into the session directory or /tmp.')
    }
  }
  if ((prog === 'chmod' || prog === 'chown' || prog === 'chgrp') && args.some(a => /^-[A-Za-z]*R/.test(a) || a === '--recursive')) {
    const roots = rmRoots(c.cwd, c.home, c.extra)
    const targets = args.filter(a => !a.startsWith('-')).slice(1)
    if (targets.length === 0 || targets.some(t => /(^|\/)\.\.(\/|$)/.test(t) || !roots.some(r => strictlyInside(toAbs(t, c.cwd, c.home), r)))) {
      return refuse('write-outside', 'Autonomous mode: recursive chmod/chown only strictly inside the session directory or /tmp.')
    }
  }
  if (WRITERS.has(prog) || (prog === 'sed' && args.some(a => /^(-[A-Za-z]*i|--in-place)/.test(a)))) return dataWrite(args, c)
  return null
}

function dataWrite(args: string[], c: Ctx): Verdict | null {
  return args.some(a => inData(a, c.cwd, c.home))
    ? refuse('agentistics-write', 'Autonomous mode: never write directly into ~/.agentistics; go through agentop or the API.')
    : null
}

function judgeWrapper(prog: string, args: string[], argv: Tok[], c: Ctx, depth: number): Verdict | null {
  let i = 0
  const skipDash = (withValue: readonly string[] = []): void => {
    while (i < args.length && args[i]!.startsWith('-') && args[i] !== '--') {
      i += withValue.includes(args[i]!) ? 2 : 1
    }
    if (args[i] === '--') i++
  }
  if (prog === 'command' || prog === 'builtin') {
    if (args[0] === '-v' || args[0] === '-V') return null
    skipDash()
  } else if (prog === 'exec' || prog === 'nohup' || prog === 'setsid' || prog === 'time') skipDash()
  else if (prog === 'nice') skipDash(['-n', '--adjustment'])
  else if (prog === 'ionice') skipDash(['-c', '-n', '-p'])
  else if (prog === 'stdbuf') skipDash()
  else if (prog === 'timeout') { skipDash(['-s', '-k', '--signal', '--kill-after']); i++ }
  else if (prog === 'flock') {
    if (args.some(a => a === '-c' || a === '--command')) return refuse('inline-code', 'Autonomous mode: flock -c runs a shell string; pass the command as separate words.')
    skipDash(['-w', '-E', '--timeout', '--conflict-exit-code']); i++
  } else if (prog === 'env') {
    if (args.some(a => a === '-S' || a === '--split-string')) return danger('env -S')
    while (i < args.length) {
      const a = args[i]!
      if (a === '-u' || a === '-C' || a === '--unset' || a === '--chdir') i += 2
      else if (a.startsWith('-')) i++
      else if (a.includes('=')) {
        if (/^(LD_|DYLD_|BASH_ENV|ENV=|PATH=|PYTHONPATH|NODE_OPTIONS|GIT_)/.test(a)) return danger(`env ${a.split('=')[0]}=`)
        i++
      } else break
    }
  }
  const rest = argv.slice(1 + i)
  if (rest.length === 0) return null
  return judge(rest, c, depth + 1)
}

/** The deny verdict for one command text, or null when the command may be auto-approved. */
export function denyRule(command: string, cwd: string, home = '/root', extraRoots: readonly string[] = []): Verdict | null {
  if (/\b4729[12]\b/.test(command)) {
    return refuse('agentistics-port', 'Autonomous mode: ports 47291/47292 belong to agentistics; do not touch them. Use a throwaway server on another port.')
  }
  const argv = tokenize(command)
  if (!argv) return refuse('not-simple', REASON_SIMPLE)
  return judge(argv, { cwd, home, extra: extraRoots })
}

/** A Write/Edit of `path`: inside the cwd or /tmp is fine; ~/.agentistics or outside is refused. */
export function fileRule(path: string, cwd: string, home = '/root', extraRoots: readonly string[] = []): Verdict | null {
  if (/(^|\/)\.\.(\/|$)/.test(path)) return refuse('write-outside', 'Autonomous mode: file edits only inside the session directory or /tmp, without `..`.')
  const abs = toAbs(path, cwd, home)
  if (dataDirs(home).some(d => abs === d || strictlyInside(abs, d))) {
    return refuse('agentistics-write', 'Autonomous mode: never write directly into ~/.agentistics; go through agentop or the API.')
  }
  const roots = [resolve(cwd), ...ALLOWED_ROOTS, ...extraRoots]
  return roots.some(r => strictlyInside(abs, r)) ? null : refuse('write-outside', 'Autonomous mode: file edits only inside the session directory or /tmp.')
}

/** The answer for one dialog. `home` is injected so the rule is testable. */
export function decideNoqAnswer(d: NoqDialog, home = '/root', extraRoots: readonly string[] = []): NoqDecision {
  if (d.harness !== 'claude') return { action: 'skip', why: 'harness' }
  if (d.mode !== 'no-questions') return { action: 'skip', why: 'mode' }
  const opts = d.dialogOptions ?? []
  const yes = opts.find(o => /^yes\b/i.test(o.label) && !/always|allow all|don't ask|do not ask|shift\+tab|auto-accept|manually/i.test(o.label))
  const no = opts.find(o => /^no\b/i.test(o.label))
  if (!yes || !no) return { action: 'skip', why: 'not-a-permission-prompt' }
  const lines = d.approvalLines ?? []
  const command = dialogCommand(lines)
  let v: Verdict | null
  let shown: string
  if (command) {
    shown = command
    v = denyRule(command, d.cwd, home, extraRoots)
  } else {
    const file = dialogFile(lines)
    if (!file) return { action: 'skip', why: 'no-command' }
    shown = `file: ${file}`
    v = fileRule(file, d.cwd, home, extraRoots)
  }
  if (v) return { action: 'deny', choice: no.number, rule: v.rule, command: shown, reason: v.reason }
  return { action: 'approve', choice: yes.number, rule: 'allowed', command: shown, reason: 'simple command off the deny list' }
}

export interface NoqMemory { lastKey: Map<string, { key: string; atMs: number; ok: boolean }> }
export const NOQ_RETRY_MS = 15_000

/**
 * May this dialog be answered now? A dialog already answered SUCCESSFULLY is never answered again — only a
 * NEW dialog (a different frame hash) or the same one after it went away (`forget`) is. A FAILED answer is
 * retried after `NOQ_RETRY_MS`. Never a blind second keystroke into a frame that did not change.
 */
export function shouldAnswer(mem: NoqMemory, id: string, key: string, nowMs: number): boolean {
  const prev = mem.lastKey.get(id)
  if (prev && prev.key === key && (prev.ok || nowMs - prev.atMs < NOQ_RETRY_MS)) return false
  mem.lastKey.set(id, { key, atMs: nowMs, ok: false })
  return true
}

export function noteAnswerResult(mem: NoqMemory, id: string, ok: boolean): void {
  const prev = mem.lastKey.get(id)
  if (prev) prev.ok = ok
}

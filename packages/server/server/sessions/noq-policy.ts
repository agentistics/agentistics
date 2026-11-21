/**
 * noq-policy.ts — PURE. What a session in `no-questions` mode answers when its harness asks anyway.
 *
 * Claude Code still draws a permission prompt under `bypassPermissions` for some commands (a heredoc
 * write, a `cd` outside the project inside a compound command). Nobody is there to answer, so the
 * session sat on "THIS SESSION IS ASKING" forever. The fleet already reads the dialog (`approvalLines`,
 * `dialogOptions`); this decides the answer:
 *
 *  - `approve` — the command stays inside the session's directory (or /tmp) and trips no deny rule;
 *  - `deny` — a deny rule matched, or a path escapes the allowed directories. The model is told WHY
 *    in one sentence typed after the dialog closes, so it retries differently instead of stalling;
 *  - `skip` — not our business (another mode, another harness, not a Yes/No permission prompt). The
 *    session keeps waiting for a person exactly as before.
 *
 * Every rule errs toward `deny` over `approve`: a refusal costs one retry, a wrong approval is
 * invisible. The runner (`noq-runner.ts`) does the IO and records every answer.
 */
import { resolve, sep } from 'node:path'

export interface NoqDialog {
  harness?: string
  /** `SessionView.mode.canonical`. */
  mode?: string
  cwd: string
  approvalLines?: string[]
  dialogOptions?: ReadonlyArray<{ number: number; label: string }>
}

export type NoqRule = 'inside-cwd' | 'rm-outside' | 'force-push' | 'agentistics-port' | 'agentop-upgrade' | 'kill-by-name' | 'path-outside'

export type NoqDecision =
  | { action: 'skip'; why: string }
  | { action: 'approve' | 'deny'; choice: number; rule: NoqRule; command: string; reason: string }

/** The command text of a Claude permission dialog: what sits between the tool header and the question. */
export function dialogCommand(lines: readonly string[]): string {
  const clean = lines.map(l => l.replace(/[│╭╮╰╯─┃┌┐└┘]/g, ' ').trim())
  const q = clean.findIndex(l => /^Do you want to /i.test(l))
  const head = clean.findIndex(l => /^(Bash command|Command|Shell command)$/i.test(l))
  if (head < 0 || q < 0 || q <= head) return ''
  return clean.slice(head + 1, q).filter(Boolean).join('\n')
}

const ALLOWED_ROOTS = ['/tmp', '/dev/null', '/usr', '/bin', '/opt']

function inside(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)
}

function allowedPath(p: string, cwd: string, home: string): boolean {
  const abs = p.startsWith('~') ? resolve(home, p.slice(2)) : resolve(cwd, p)
  return inside(abs, resolve(cwd)) || ALLOWED_ROOTS.some(r => inside(abs, r))
}

/** Absolute (`/x`, `~/x`) path tokens of a command — what it names outside any quoting subtlety. */
function absolutePaths(text: string): string[] {
  return [...text.matchAll(/(?:^|[\s='"(:])((?:~|\/)[^\s'"`;|&<>()]*)/g)].map(m => m[1]!).filter(p => p.length > 1 || p === '~')
}

function segments(text: string): string[] {
  return text.split(/&&|\|\||;|\||\n/).map(s => s.trim()).filter(Boolean)
}

function tokens(seg: string): string[] {
  return seg.split(/\s+/).map(t => t.replace(/^['"]|['"]$/g, '')).filter(Boolean)
}

export function denyRule(command: string, cwd: string, home = '/root'): { rule: NoqRule; reason: string } | null {
  if (/\b4729[12]\b/.test(command)) {
    return { rule: 'agentistics-port', reason: 'Autonomous mode: ports 47291/47292 belong to agentistics; do not touch them. Use a throwaway server on another port.' }
  }
  if (/\bagentop\s+upgrade\b/.test(command)) {
    return { rule: 'agentop-upgrade', reason: 'Autonomous mode: never run `agentop upgrade`; verify through the API instead.' }
  }
  if (/(^|[\s;&|(])(pkill|killall)\b/.test(command)) {
    return { rule: 'kill-by-name', reason: 'Autonomous mode: do not kill processes by name; kill only the PID you saved.' }
  }
  for (const seg of segments(command)) {
    const t = tokens(seg)
    const i = t.findIndex((x, n) => x === 'git' && (t[n + 1] === 'push' || t.slice(n + 1, n + 4).includes('push')))
    if (i >= 0) {
      const force = t.some(x => x === '-f' || x === '--force' || x.startsWith('--force-with-lease') || /^\+\S/.test(x))
      const protectedBranch = t.some(x => /^(\+?(refs\/heads\/)?)?(main|master|dev)(:|$)/.test(x) || /:(refs\/heads\/)?(main|master|dev)$/.test(x))
      // `git push --force` with no branch names the upstream — which may be main/dev — so it is refused too.
      const positional = t.slice(i + 2).filter(x => !x.startsWith('-'))
      if (force && (protectedBranch || positional.length <= 1)) {
        return { rule: 'force-push', reason: 'Autonomous mode: no force-push to main/dev. Push a normal commit to your own branch.' }
      }
    }
    const r = t.findIndex(x => x === 'rm')
    if (r >= 0) {
      const args = t.slice(r + 1)
      const recursive = args.some(a => /^-[a-zA-Z]*[rR]/.test(a) || a === '--recursive')
      if (recursive) {
        const targets = args.filter(a => !a.startsWith('-'))
        const bad = targets.length === 0 || targets.some(a => /[$*`]/.test(a) || !allowedPath(a, cwd, home))
        if (bad) return { rule: 'rm-outside', reason: 'Autonomous mode: recursive rm only inside the session directory or /tmp, with explicit absolute paths.' }
      }
    }
  }
  return null
}

const PATH_REASON = 'Autonomous mode: run it without heredoc / without cd in a compound command; use absolute paths inside the working directory or git -C.'

/** The answer for one dialog. `home` is injected so the rule is testable. */
export function decideNoqAnswer(d: NoqDialog, home = '/root'): NoqDecision {
  if (d.harness !== 'claude') return { action: 'skip', why: 'harness' }
  if (d.mode !== 'no-questions') return { action: 'skip', why: 'mode' }
  const opts = d.dialogOptions ?? []
  const yes = opts.find(o => /^yes\b/i.test(o.label) && !/always|allow all|don't ask|do not ask|shift\+tab/i.test(o.label))
  const no = opts.find(o => /^no\b/i.test(o.label))
  if (!yes || !no) return { action: 'skip', why: 'not-a-permission-prompt' }
  const command = dialogCommand(d.approvalLines ?? [])
  if (!command) return { action: 'skip', why: 'no-command' }
  const deny = denyRule(command, d.cwd, home)
  if (deny) return { action: 'deny', choice: no.number, rule: deny.rule, command, reason: deny.reason }
  const outside = absolutePaths(command).find(p => !allowedPath(p, d.cwd, home))
  if (outside) return { action: 'deny', choice: no.number, rule: 'path-outside', command, reason: PATH_REASON }
  return { action: 'approve', choice: yes.number, rule: 'inside-cwd', command, reason: 'inside the session directory' }
}

export interface NoqMemory { lastKey: Map<string, { key: string; atMs: number }> }
export const NOQ_RETRY_MS = 15_000

/**
 * Has this exact dialog already been answered a moment ago? A frame that has not repainted yet shows the
 * same dialog for a poll or two, and answering twice would type into the next prompt. A DIFFERENT dialog
 * (a second prompt right after) is always answered, and the same one after `NOQ_RETRY_MS` is retried —
 * there is no one-shot latch.
 */
export function shouldAnswer(mem: NoqMemory, id: string, key: string, nowMs: number): boolean {
  const prev = mem.lastKey.get(id)
  if (prev && prev.key === key && nowMs - prev.atMs < NOQ_RETRY_MS) return false
  mem.lastKey.set(id, { key, atMs: nowMs })
  return true
}

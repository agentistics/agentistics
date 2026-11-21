/**
 * noq-policy.ts — PURE. What a session in `no-questions` mode answers when its harness asks anyway.
 *
 * Claude Code still draws a permission prompt under `bypassPermissions` for some commands (a heredoc
 * write, a `cd` outside the project inside a compound command). Nobody is there to answer, so the
 * session sat on "THIS SESSION IS ASKING" forever. The fleet already reads the dialog (`approvalLines`,
 * `dialogOptions`); this decides the answer:
 *
 *  - `approve` — everything that trips no deny rule (owner decision: workers legitimately write outside the cwd);
 *  - `deny` — a deny rule matched. The model is told WHY
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

export type NoqRule = 'allowed' | 'rm-outside' | 'force-push' | 'agentistics-port' | 'agentop-upgrade' | 'kill-by-name' | 'agentistics-write'

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

const ALLOWED_ROOTS = ['/tmp']

function inside(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)
}

/**
 * Where a recursive rm may reach: the cwd, /tmp, the throwaway cache, the PARENT project of a worktree
 * (`<project>/.worktrees/<name>` → `<project>`) and any `AGENTISTICS_NOQ_RM_ROOTS` (colon-separated).
 */
export function rmRoots(cwd: string, home: string, extra: readonly string[] = []): string[] {
  const m = cwd.match(/^(.*?)\/\.(?:claude\/)?worktrees\//)
  const fromEnv = (process.env.AGENTISTICS_NOQ_RM_ROOTS ?? '').split(':').filter(Boolean)
  return [resolve(cwd), ...ALLOWED_ROOTS, resolve(home, '.cache/agentistics-throwaway'), ...(m ? [m[1]!] : []), ...fromEnv, ...extra]
}

function allowedPath(p: string, cwd: string, home: string, extra: readonly string[]): boolean {
  const abs = p.startsWith('~') ? resolve(home, p.slice(2)) : resolve(cwd, p)
  return rmRoots(cwd, home, extra).some(r => inside(abs, r))
}

function segments(text: string): string[] {
  return text.split(/&&|\|\||;|\||\n/).map(s => s.trim()).filter(Boolean)
}

function tokens(seg: string): string[] {
  return seg.split(/\s+/).map(t => t.replace(/^['"]|['"]$/g, '')).filter(Boolean)
}

export function denyRule(command: string, cwd: string, home = '/root', extraRoots: readonly string[] = []): { rule: NoqRule; reason: string } | null {
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
    if (/(^|[\s='"(:/])(~|\$HOME|\$\{HOME\}|\/home\/[^/\s]+)\/\.agentistics(\/|\s|['"]|$)/.test(seg)
      && (/>/.test(seg) || /(^|\s)(tee|cp|mv|rm|touch|truncate|dd|ln|install|chmod|rmdir)\s/.test(seg) || /sed\s+(-\w*i|--in-place)/.test(seg))) {
      return { rule: 'agentistics-write', reason: 'Autonomous mode: never write directly into ~/.agentistics; go through agentop or the API.' }
    }
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
        const bad = targets.length === 0 || targets.some(a => /[$*`]|(^|\/)\.\.(\/|$)/.test(a) || !allowedPath(a, cwd, home, extraRoots))
        if (bad) return { rule: 'rm-outside', reason: 'Autonomous mode: recursive rm only inside the session directory or /tmp, with explicit absolute paths.' }
      }
    }
  }
  return null
}

/** The answer for one dialog. `home` is injected so the rule is testable. */
export function decideNoqAnswer(d: NoqDialog, home = '/root', extraRoots: readonly string[] = []): NoqDecision {
  if (d.harness !== 'claude') return { action: 'skip', why: 'harness' }
  if (d.mode !== 'no-questions') return { action: 'skip', why: 'mode' }
  const opts = d.dialogOptions ?? []
  const yes = opts.find(o => /^yes\b/i.test(o.label) && !/always|allow all|don't ask|do not ask|shift\+tab/i.test(o.label))
  const no = opts.find(o => /^no\b/i.test(o.label))
  if (!yes || !no) return { action: 'skip', why: 'not-a-permission-prompt' }
  const command = dialogCommand(d.approvalLines ?? [])
  if (!command) return { action: 'skip', why: 'no-command' }
  const deny = denyRule(command, d.cwd, home, extraRoots)
  if (deny) return { action: 'deny', choice: no.number, rule: deny.rule, command, reason: deny.reason }
  return { action: 'approve', choice: yes.number, rule: 'allowed', command, reason: 'not on the deny list' }
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

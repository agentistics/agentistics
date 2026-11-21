import { describe, expect, test } from 'bun:test'
import { decideNoqAnswer, denyRule, shouldAnswer, type NoqDialog } from './noq-policy'
import { createNoqRunner, type NoqAnswerRecord } from './noq-runner'
import type { SessionSnapshot } from './sessions-host'

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

describe('decideNoqAnswer', () => {
  test('approves a command inside the cwd (heredoc included) with the plain Yes', () => {
    const d = decideNoqAnswer(dialog(`cat > ${CWD}/a.txt <<'EOF'\nhi\nEOF`))
    expect(d).toMatchObject({ action: 'approve', choice: 1, rule: 'allowed' })
  })
  test('approves legitimate work outside the cwd (reports, sibling worktrees, cd in compound)', () => {
    expect(decideNoqAnswer(dialog('cat > /home/u/ws/leader/r.md')).action).toBe('approve')
    expect(decideNoqAnswer(dialog('cd /home/u/other && git worktree remove x')).action).toBe('approve')
  })
  test('refuses with a typed reason when a deny rule matches', () => {
    const d = decideNoqAnswer(dialog('rm -rf /home/u/other'))
    expect(d).toMatchObject({ action: 'deny', choice: 3, rule: 'rm-outside' })
    expect((d as { reason: string }).reason.length).toBeGreaterThan(10)
  })
  test('skips another mode, another harness, and a dialog that is not Yes/No', () => {
    expect(decideNoqAnswer(dialog('ls', { mode: 'default' })).action).toBe('skip')
    expect(decideNoqAnswer(dialog('ls', { mode: undefined })).action).toBe('skip')
    expect(decideNoqAnswer(dialog('ls', { harness: 'codex' })).action).toBe('skip')
    expect(decideNoqAnswer(dialog('ls', { dialogOptions: [{ number: 1, label: 'Apple' }, { number: 2, label: 'Pear' }] })).action).toBe('skip')
  })
})

describe('deny list — one rule per case', () => {
  test('rm -rf outside cwd and /tmp', () => {
    expect(denyRule('rm -rf /home/u/other', CWD)?.rule).toBe('rm-outside')
    expect(denyRule('rm -rf ..', CWD)?.rule).toBe('rm-outside')
    expect(denyRule('rm -rf $DIR', CWD)?.rule).toBe('rm-outside')
    expect(denyRule('rm -rf /tmp/x', CWD)).toBeNull()
    expect(denyRule(`rm -rf ${CWD}/dist`, CWD)).toBeNull()
    expect(denyRule('rm file.txt', CWD)).toBeNull()
    expect(denyRule('rm -rf /home/u/.cache/agentistics-throwaway/x', CWD, '/home/u')).toBeNull()
    expect(denyRule('rm -rf /home/u/proj/other-wt', CWD, '/home/u')).toBeNull() // parent project
    expect(denyRule('rm -rf /home/u/extra/x', CWD, '/home/u', ['/home/u/extra'])).toBeNull()
  })
  test('direct writes into ~/.agentistics', () => {
    expect(denyRule('echo x > ~/.agentistics/prefs.json', CWD, '/home/u')?.rule).toBe('agentistics-write')
    expect(denyRule('rm /home/u/.agentistics/a', CWD, '/home/u')?.rule).toBe('agentistics-write')
    expect(denyRule('cat ~/.agentistics/a', CWD, '/home/u')).toBeNull()
    expect(denyRule('echo x > ~/agentistics-workspace/a', CWD, '/home/u')).toBeNull()
  })
  test('force push to main/dev, including a bare force push', () => {
    expect(denyRule('git push --force origin main', CWD)?.rule).toBe('force-push')
    expect(denyRule('git push -f origin dev', CWD)?.rule).toBe('force-push')
    expect(denyRule('git push origin +main', CWD)?.rule).toBe('force-push')
    expect(denyRule('git push --force', CWD)?.rule).toBe('force-push')
    expect(denyRule('git push --force origin feat/x', CWD)).toBeNull()
    expect(denyRule('git push origin main', CWD)).toBeNull()
  })
  test('agentistics ports', () => {
    expect(denyRule('curl localhost:47291/api/fleet', CWD)?.rule).toBe('agentistics-port')
    expect(denyRule('curl localhost:47292', CWD)?.rule).toBe('agentistics-port')
    expect(denyRule('curl localhost:47293', CWD)).toBeNull()
  })
  test('agentop upgrade', () => {
    expect(denyRule('agentop upgrade', CWD)?.rule).toBe('agentop-upgrade')
    expect(denyRule('agentop upgrades-list', CWD)).toBeNull()
  })
  test('kill by name', () => {
    expect(denyRule('pkill -f agentop', CWD)?.rule).toBe('kill-by-name')
    expect(denyRule('echo x; killall node', CWD)?.rule).toBe('kill-by-name')
    expect(denyRule('kill 1234', CWD)).toBeNull()
  })
})

describe('shouldAnswer — no one-shot latch', () => {
  test('same dialog is not repeated at once, a different one is answered, the same one is retried later', () => {
    const mem = { lastKey: new Map() }
    expect(shouldAnswer(mem, 's', 'A', 0)).toBe(true)
    expect(shouldAnswer(mem, 's', 'A', 5_000)).toBe(false)
    expect(shouldAnswer(mem, 's', 'B', 6_000)).toBe(true)
    expect(shouldAnswer(mem, 's', 'B', 6_000 + 20_000)).toBe(true)
  })
})

function snap(rows: Array<Record<string, unknown> & { id: string }>): SessionSnapshot {
  return { sessions: rows.map(r => ({ cwd: CWD, harness: 'claude', activity: 'waiting-approval', status: 'running', ...r })), attention: 0, rang: [], polledAtMs: 0 } as unknown as SessionSnapshot
}
const row = (id: string, cmd: string, canonical = 'no-questions') => ({
  id, mode: canonical !== 'none' ? { id: 'bypass', label: 'bypass', canonical: canonical as 'no-questions' } : undefined, approvalLines: screen(cmd), dialogOptions: OPTIONS,
})

describe('runner', () => {
  function harness() {
    const sent: Array<[string, number]> = []
    const prompts: Array<[string, string]> = []
    const records: NoqAnswerRecord[] = []
    const runner = createNoqRunner({
      answer: async (id, c) => { sent.push([id, c]); return { ok: true, message: 'ok' } },
      prompt: async (id, t) => { prompts.push([id, t]); return { ok: true, message: 'ok' } },
      record: r => { records.push(r) },
      sleep: async () => {},
      now: () => now,
      home: '/home/u',
    })
    let now = 0
    return { sent, prompts, records, runner, at: (n: number) => { now = n } }
  }

  test('approves inside cwd and records it', async () => {
    const h = harness()
    await h.runner.consume(snap([row('s1', `echo hi > ${CWD}/a`)]))
    expect(h.sent).toEqual([['s1', 1]])
    expect(h.records[0]).toMatchObject({ decision: 'approve', id: 's1', ok: true })
    expect(h.prompts).toEqual([])
  })
  test('refuses a deny-list command, then types the reason', async () => {
    const h = harness()
    await h.runner.consume(snap([row('s1', 'pkill -f agentop')]))
    expect(h.sent).toEqual([['s1', 3]])
    expect(h.prompts[0]![1]).toContain('Autonomous mode')
    expect(h.records[0]).toMatchObject({ decision: 'deny', rule: 'kill-by-name' })
  })
  test('uses the mode the session was started in when the dialog frame shows no mode chip', async () => {
    const h = harness()
    const r = createNoqRunner({
      answer: async (id, c) => { h.sent.push([id, c]); return { ok: true, message: 'ok' } },
      prompt: async () => ({ ok: true, message: '' }), record: () => {}, sleep: async () => {}, home: '/home/u',
      startMode: async id => (id === 's1' ? 'no-questions' : 'default'),
    })
    await r.consume(snap([row('s1', 'ls', 'none'), row('s2', 'ls', 'none')]))
    expect(h.sent).toEqual([['s1', 1]])
  })
  test('a default-mode session is untouched', async () => {
    const h = harness()
    await h.runner.consume(snap([row('s1', 'ls', 'default'), row('s2', 'ls', 'none')]))
    expect(h.sent).toEqual([])
    expect(h.records).toEqual([])
  })
  test('a second prompt right after the first is answered too', async () => {
    const h = harness()
    await h.runner.consume(snap([row('s1', 'echo one')]))
    h.at(5_000)
    await h.runner.consume(snap([row('s1', 'echo one')])) // same frame, not repainted yet
    h.at(10_000)
    await h.runner.consume(snap([row('s1', 'echo two')]))
    expect(h.sent.length).toBe(2)
  })
})

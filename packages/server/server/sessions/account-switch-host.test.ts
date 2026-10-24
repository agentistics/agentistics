import { describe, expect, test } from 'bun:test'
import type { ResumeSessionRequest } from '@agentistics/tui/control'
import { switchSessionAccountImpl, type SwitchHostDeps } from './account-switch-host'
import { withResumeLock } from './resume-lock'
import type { SpawnAccountRow } from './spawn-account'
import type { ManagedSession } from './types'

const acc = (o: Partial<SpawnAccountRow> & { id: string }): SpawnAccountRow =>
  ({ harness: 'claude', root: null, bound: true, available: true, firstSeen: 1, ...o })

function world(opts: { copyFails?: boolean; transcript?: boolean; pending?: string; accounts?: SpawnAccountRow[] } = {}) {
  let n = 0
  const rows: ManagedSession[] = [{
    id: 'm1', harness: 'claude', cwd: '/w', createdAt: '2026-10-24T00:00:00Z', conversationId: 'conv1', accountId: 'acc_a', label: 'Fix', note: 'n',
  }]
  const alive = new Set(['m1'])
  const killed: string[] = []
  const resumed: ResumeSessionRequest[] = []
  const copied: unknown[] = []
  const deps: SwitchHostDeps = {
    lang: 'en',
    backend: {
      list: async () => [...alive].map(id => ({ id, alive: true })) as never,
      kill: async id => { alive.delete(id); killed.push(id); return true },
    },
    withLock: withResumeLock,
    resume: async r => {
      resumed.push(r)
      // The real reopen retires the replaced row and adds the continuation.
      const prev = rows.find(m => m.id === r.replaces)
      if (prev) prev.endedAt = prev.endedAt ?? 'now'
      const id = `m${++n + 1}`
      rows.push({ ...prev!, id, endedAt: undefined, accountId: r.switchToAccount ?? prev?.accountId })
      alive.add(id)
      return { ok: true, message: 'ok', id }
    },
    io: {
      readRows: async () => rows.map(r => ({ ...r })),
      context: async () => ({ enabled: true, accounts: opts.accounts ?? [acc({ id: 'acc_a' }), acc({ id: 'acc_b', root: '/r/b' })] }),
      findFiles: async () => opts.transcript === false ? {} : { transcript: '/home/u/.claude/projects/-w/conv1.jsonl' },
      copy: async c => { if (opts.copyFails) throw new Error('disk full'); copied.push(...c) },
      limit: async () => opts.pending ? { pendingPrompt: opts.pending } : null,
      killAndRetire: async (id, kill) => { const r = rows.find(m => m.id === id)!; r.endedAt = 'now'; return kill() },
    },
  }
  const live = () => rows.filter(r => !r.endedAt)
  return { deps, rows, killed, resumed, copied, live }
}

describe('switchSessionAccountImpl', () => {
  test('ends, copies, resumes the same conversation on the target; one live row', async () => {
    const w = world({ pending: 'fix the bug' })
    const out = await switchSessionAccountImpl({ id: 'm1', accountId: 'acc_b', resendPending: true }, w.deps)
    expect(out.ok).toBe(true)
    expect(w.killed).toEqual(['m1'])
    expect(w.copied).toEqual([{ from: '/home/u/.claude/projects/-w/conv1.jsonl', to: '/r/b/projects/-w/conv1.jsonl', kind: 'file' }])
    expect(w.resumed).toHaveLength(1)
    expect(w.resumed[0]).toMatchObject({ sessionId: 'conv1', replaces: 'm1', switchToAccount: 'acc_b', prompt: 'fix the bug', label: 'Fix' })
    expect(w.live().map(r => [r.id, r.accountId])).toEqual([['m2', 'acc_b']])
  })

  test('two requests at once: one switch, the pending prompt sent ONCE, the second refused', async () => {
    const w = world({ pending: 'again' })
    const [a, b] = await Promise.all([
      switchSessionAccountImpl({ id: 'm1', accountId: 'acc_b', resendPending: true }, w.deps),
      switchSessionAccountImpl({ id: 'm1', accountId: 'acc_b', resendPending: true }, w.deps),
    ])
    expect([a.ok, b.ok].sort()).toEqual([false, true])
    expect((a.ok ? b : a).code).toBe('no_target')
    expect(w.resumed.filter(r => r.prompt === 'again')).toHaveLength(1)
    expect(w.live()).toHaveLength(1)
  })

  test('without resendPending, no prompt rides the resume', async () => {
    const w = world({ pending: 'x' })
    await switchSessionAccountImpl({ id: 'm1', accountId: 'acc_b' }, w.deps)
    expect(w.resumed[0]!.prompt).toBeUndefined()
  })

  test('a failed copy gives the session back on its own account', async () => {
    const w = world({ copyFails: true })
    const out = await switchSessionAccountImpl({ id: 'm1', accountId: 'acc_b' }, w.deps)
    expect(out.ok).toBe(false)
    expect(w.resumed).toHaveLength(1)
    expect(w.resumed[0]!.switchToAccount).toBeUndefined()
    expect(w.live().map(r => r.accountId)).toEqual(['acc_a'])
  })

  test('refusals end nothing', async () => {
    for (const [o, req, code] of [
      [{ accounts: [acc({ id: 'acc_a' }), acc({ id: 'acc_b', root: '/r/b', bound: false })] }, 'acc_b', 'account_signed_out'],
      [{ accounts: [acc({ id: 'acc_a' }), acc({ id: 'acc_b', root: '/r/b', available: false })] }, 'acc_b', 'account_unavailable'],
      [{ accounts: [acc({ id: 'acc_a' }), acc({ id: 'acc_b', root: '/r/b', retired: true })] }, 'acc_b', 'account_retired'],
      [{}, 'acc_a', 'same_account'],
      [{ transcript: false }, 'acc_b', 'no_transcript'],
    ] as const) {
      const w = world(o as never)
      const out = await switchSessionAccountImpl({ id: 'm1', accountId: req }, w.deps)
      expect(out).toMatchObject({ ok: false, code })
      expect(out.message.length).toBeGreaterThan(10)
      expect(w.killed).toEqual([])
      expect(w.resumed).toEqual([])
    }
  })

  test('an unknown row is refused in words', async () => {
    const w = world()
    expect(await switchSessionAccountImpl({ id: 'nope', accountId: 'acc_b' }, w.deps)).toMatchObject({ ok: false, code: 'not_running_here' })
  })
})

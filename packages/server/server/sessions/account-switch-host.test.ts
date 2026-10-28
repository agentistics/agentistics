import { describe, expect, test } from 'bun:test'
import type { ResumeSessionRequest, SpawnSessionRequest } from '@agentistics/tui/control'
import { switchSessionAccountImpl, type SwitchHostDeps } from './account-switch-host'
import { withResumeLock } from './resume-lock'
import type { SpawnAccountRow } from './spawn-account'
import type { ManagedSession } from './types'

const acc = (o: Partial<SpawnAccountRow> & { id: string }): SpawnAccountRow =>
  ({ harness: 'claude', root: null, bound: true, available: true, firstSeen: 1, ...o })

function world(opts: { copyFails?: boolean; transcript?: boolean; pending?: string; accounts?: SpawnAccountRow[]; refuseTarget?: boolean; refuseAll?: boolean } = {}) {
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
      if (opts.refuseAll || (opts.refuseTarget && r.switchToAccount)) {
        return { ok: false, message: 'the session exited as soon as it started: claude: boom' }
      }
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

  test('a resume forced below the memory floor says so in the switch message', async () => {
    const w = world()
    const resume = w.deps.resume
    w.deps.resume = async r => ({ ...(await resume(r)), overridden: true, note: 'WARNING — started BELOW THE HARD MEMORY FLOOR (2 GB free)' })
    const out = await switchSessionAccountImpl({ id: 'm1', accountId: 'acc_b' }, w.deps)
    expect(out.ok).toBe(true)
    expect(out.message).toContain('BELOW THE HARD MEMORY FLOOR')
  })

  test('a failed copy gives the session back on its own account', async () => {
    const w = world({ copyFails: true })
    const out = await switchSessionAccountImpl({ id: 'm1', accountId: 'acc_b' }, w.deps)
    expect(out.ok).toBe(false)
    expect(w.resumed).toHaveLength(1)
    expect(w.resumed[0]!.switchToAccount).toBeUndefined()
    expect(w.live().map(r => r.accountId)).toEqual(['acc_a'])
  })

  test('every resume is forced: the process it replaces was just ended', async () => {
    const w = world()
    await switchSessionAccountImpl({ id: 'm1', accountId: 'acc_b' }, w.deps)
    expect(w.resumed.every(r => r.force === true)).toBe(true)
  })

  test('a target that refuses to start gives the session back on its own account, in words', async () => {
    const w = world({ refuseTarget: true })
    const out = await switchSessionAccountImpl({ id: 'm1', accountId: 'acc_b' }, w.deps)
    expect(out.ok).toBe(false)
    expect(w.resumed.map(r => r.switchToAccount)).toEqual(['acc_b', undefined])
    expect(w.resumed[1]).toMatchObject({ sessionId: 'conv1', replaces: 'm1', force: true })
    expect(w.live().map(r => r.accountId)).toEqual(['acc_a'])
    expect(out.message).toBe('The session did not start on the other account; it continues on its previous account. It exited as soon as it started (details are in the server log).')
    expect(out.message).not.toContain('boom')
  })

  test('when even the old account cannot start, the message says the conversation is kept', async () => {
    const w = world({ refuseAll: true })
    const out = await switchSessionAccountImpl({ id: 'm1', accountId: 'acc_b' }, w.deps)
    expect(out).toMatchObject({ ok: false })
    expect(w.resumed).toHaveLength(2)
    expect(out.message).toContain('Reopen')
    // The session WAS ended, the person is told so plainly, and the UI gets the row to reopen.
    expect(out.message).toContain('was ended')
    expect(out.message).not.toMatch(/nothing (was ended|changed)/i)
    expect(out).toMatchObject({ ended: true, endedId: 'm1' })
    expect(w.live()).toEqual([])
  })

  test('the double failure speaks Portuguese too, and a single failure carries no ended flag', async () => {
    const w = world({ refuseAll: true })
    const out = await switchSessionAccountImpl({ id: 'm1', accountId: 'acc_b' }, { ...w.deps, lang: 'pt' })
    expect(out.message).toContain('foi encerrada')
    expect(out.message).toContain('Reabrir')
    expect(out).toMatchObject({ ended: true, endedId: 'm1' })
    const soft = world({ refuseTarget: true })
    const back = await switchSessionAccountImpl({ id: 'm1', accountId: 'acc_b' }, soft.deps)
    expect(back.ended).toBeUndefined()
    expect(back.message).toContain('continues on its previous account')
  })

  test('text audit: "nothing was ended / nada foi encerrado" appears only on refusals that end nothing', async () => {
    for (const lang of ['en', 'pt'] as const) {
      const w = world({ transcript: false })
      const out = await switchSessionAccountImpl({ id: 'm1', accountId: 'acc_b' }, { ...w.deps, lang })
      expect(out.message).toMatch(/nothing was ended|nada foi encerrado/i)
      expect(w.killed).toEqual([])
      // Once the kill has happened no result may claim otherwise.
      const after = world({ refuseAll: true })
      const lost = await switchSessionAccountImpl({ id: 'm1', accountId: 'acc_b' }, { ...after.deps, lang })
      expect(after.killed).toEqual(['m1'])
      expect(lost.message).not.toMatch(/nothing was ended|nada foi encerrado|nothing changed|nada mudou/i)
    }
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

describe('switchSessionAccountImpl — another harness (v2 hand-off)', () => {
  function cross(opts: { spawnFails?: boolean; diesAtLaunch?: boolean; installed?: string[] } = {}) {
    const order: string[] = []
    const alive = new Set(['m1'])
    const rows: ManagedSession[] = [{
      id: 'm1', harness: 'claude', cwd: '/w', createdAt: '2026-10-24T00:00:00Z', conversationId: 'conv1', accountId: 'acc_a',
      label: 'Fix', task: 'T', taskId: 't1', subtaskId: 's1', parentSessionId: 'lead', mode: 'accept-edits', away: true,
    }]
    const spawned: SpawnSessionRequest[] = []
    const links: string[] = []
    const deps: SwitchHostDeps = {
      lang: 'en',
      backend: {
        list: async () => [...alive].map(id => ({ id, alive: true })) as never,
        kill: async id => { order.push(`kill:${id}`); alive.delete(id); return true },
      },
      withLock: withResumeLock,
      resume: async () => { throw new Error('a hand-off never resumes') },
      spawn: async r => {
        order.push(`spawn:${r.harness}`)
        spawned.push(r)
        if (opts.spawnFails) return { ok: false, message: 'codex: command not found' }
        if (!opts.diesAtLaunch) alive.add('m9')
        return { ok: true, message: 'started', id: 'm9' }
      },
      io: {
        readRows: async () => rows.map(r => ({ ...r })),
        context: async () => ({ enabled: true, accounts: [acc({ id: 'acc_a' }), acc({ id: 'acc_k', harness: 'codex', root: '/r/k' })] }),
        limit: async () => ({ pendingPrompt: 'fix the CSV header' }),
        killAndRetire: async (id, kill) => { order.push(`retire:${id}`); return kill() },
        startable: async () => (opts.installed ?? ['claude', 'codex']) as never,
        turns: async () => ({ turns: [{ role: 'user', text: 'Add export' }, { role: 'assistant', text: 'Done; tests next.' }, { role: 'assistant', text: "You've hit your session limit · resets 6:30pm" }] }),
        role: async () => 'worker',
        label: async () => 'a@x',
        link: async (a, b) => { links.push(`${a}->${b}`) },
      },
    }
    return { deps, order, spawned, links, alive }
  }

  test('starts the new session FIRST, briefed with a summary, inheriting cwd/filing/role/parent; ends the old one after', async () => {
    const w = cross()
    const out = await switchSessionAccountImpl({ id: 'm1', accountId: 'acc_k', harness: 'codex', resendPending: true }, w.deps)
    expect(out).toMatchObject({ ok: true, id: 'm9' })
    expect(w.order).toEqual(['spawn:codex', 'retire:m1', 'kill:m1'])
    expect(w.spawned[0]).toMatchObject({
      harness: 'codex', cwd: '/w', switchFrom: 'm1', accountId: 'acc_k', accountDecided: true, label: 'Fix', task: 'T',
      role: 'worker', parentSessionId: 'lead', parentVerified: true, mode: 'accept-edits', away: true, attach: false,
    })
    expect(w.spawned[0]!.prompt).toContain('Claude Code (account a@x)')
    expect(w.spawned[0]!.prompt).toContain('Add export')
    expect(w.spawned[0]!.prompt).toContain('## State (last assistant reply)\nDone; tests next.')
    expect(w.spawned[0]!.prompt).not.toContain("You've hit your session limit")
    expect(w.spawned[0]!.prompt!.endsWith('fix the CSV header')).toBe(true)
    expect(w.links).toEqual(['m1->m9'])
    expect([...w.alive]).toEqual(['m9'])
  })

  test('a spawn that fails, or a pane that died at launch, leaves the old session untouched', async () => {
    for (const o of [{ spawnFails: true }, { diesAtLaunch: true }]) {
      const w = cross(o)
      const out = await switchSessionAccountImpl({ id: 'm1', accountId: 'acc_k', harness: 'codex' }, w.deps)
      expect(out.ok).toBe(false)
      expect(out.message).toContain('continues as it was')
      expect(w.order.filter(s => s.startsWith('kill') || s.startsWith('retire'))).toEqual([])
      expect(w.links).toEqual([])
      expect(w.alive.has('m1')).toBe(true)
    }
  })

  test('refusals start and end nothing', async () => {
    for (const [o, req, code] of [
      [{ installed: ['claude'] }, 'acc_k', 'harness_unavailable'],
      [{}, 'acc_a', 'unknown_account'],
    ] as const) {
      const w = cross(o as never)
      const out = await switchSessionAccountImpl({ id: 'm1', accountId: req, harness: 'codex' }, w.deps)
      expect(out).toMatchObject({ ok: false, code })
      expect(w.order).toEqual([])
    }
  })

  test('without --resend no pending message rides the summary', async () => {
    const w = cross()
    await switchSessionAccountImpl({ id: 'm1', accountId: 'acc_k', harness: 'codex' }, w.deps)
    expect(w.spawned[0]!.prompt).not.toContain('fix the CSV header')
  })
})

// CONTA.IDENTIDADE (QA r1): the switch resolves WHO a session runs as through `session-account.ts`,
// exactly like the dialog's GET, and keeps WHERE its files are the row's own record.
describe('switchSessionAccountImpl — CONTA.IDENTIDADE', () => {
  const defaultHome = () => {
    const w = world({ pending: 'go on' })
    delete w.rows[0]!.accountId // started before accounts: runs in the default home, bound to acc_a
    const limitArgs: unknown[] = []
    w.deps.io!.limit = async a => { limitArgs.push(a); return { pendingPrompt: 'go on' } }
    return { ...w, limitArgs }
  }

  test('a default-home row IS the account bound there: asking for it again is same_account', async () => {
    const w = defaultHome()
    expect(await switchSessionAccountImpl({ id: 'm1', accountId: 'acc_a' }, w.deps)).toMatchObject({ ok: false, code: 'same_account' })
    expect(w.killed).toEqual([])
  })

  test('a default-home row is same_account when that login also has its own root', async () => {
    const w = defaultHome()
    w.deps.io!.context = async () => ({ enabled: true, accounts: [
      acc({ id: 'acc_a', root: '/r/a', defaultRoot: true }), acc({ id: 'acc_b', root: '/r/b' }),
    ] })
    expect(await switchSessionAccountImpl({ id: 'm1', accountId: 'acc_a' }, w.deps)).toMatchObject({ ok: false, code: 'same_account' })
    expect(w.killed).toEqual([])
  })

  test('a default-home row still copies FROM the default home and reads its limit there (no account root)', async () => {
    const w = defaultHome()
    const out = await switchSessionAccountImpl({ id: 'm1', accountId: 'acc_b', resendPending: true }, w.deps)
    expect(out.ok).toBe(true)
    expect(w.copied).toEqual([{ from: '/home/u/.claude/projects/-w/conv1.jsonl', to: '/r/b/projects/-w/conv1.jsonl', kind: 'file' }])
    expect(w.limitArgs).toEqual([{ harness: 'claude', conversationId: 'conv1', cwd: '/w' }])
  })

  test('a row on its own account reads its limit under that account', async () => {
    const w = world({ pending: 'x' })
    const limitArgs: unknown[] = []
    w.deps.io!.limit = async a => { limitArgs.push(a); return null }
    await switchSessionAccountImpl({ id: 'm1', accountId: 'acc_b', resendPending: true }, w.deps)
    expect(limitArgs).toEqual([{ harness: 'claude', conversationId: 'conv1', cwd: '/w', accountId: 'acc_a' }])
  })
})

describe('switchSessionAccountImpl — CONTA.IDENTIDADE hand-off label', () => {
  test('the "from" account of a default-home row is the account bound there, not nothing', async () => {
    const rows: ManagedSession[] = [{ id: 'm1', harness: 'claude', cwd: '/w', createdAt: '2026-10-24T00:00:00Z', conversationId: 'conv1' }]
    const asked: (string | undefined)[] = []
    const deps: SwitchHostDeps = {
      lang: 'en',
      backend: { list: async () => [{ id: 'm1', alive: true }] as never, kill: async () => true },
      withLock: withResumeLock,
      resume: async () => { throw new Error('no resume') },
      spawn: async () => ({ ok: true, message: 'started', id: 'm9' }),
      io: {
        readRows: async () => rows.map(r => ({ ...r })),
        context: async () => ({ enabled: true, accounts: [acc({ id: 'acc_a' }), acc({ id: 'acc_k', harness: 'codex', root: '/r/k' })] }),
        limit: async () => null,
        killAndRetire: async (_id, kill) => kill(),
        startable: async () => ['claude', 'codex'] as never,
        turns: async () => ({ turns: [] }),
        role: async () => undefined,
        label: async (_h, id) => { asked.push(id); return id === 'acc_a' ? 'a@x' : undefined },
        link: async () => {},
      },
    }
    await switchSessionAccountImpl({ id: 'm1', accountId: 'acc_k', harness: 'codex' }, deps)
    expect(asked).toEqual(['acc_a'])
  })
})

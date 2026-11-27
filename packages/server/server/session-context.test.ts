import { describe, expect, test } from 'bun:test'
import { planSessionContext, tildePath, type ContextSession } from './session-context'

const HOME = '/home/u'
const CWD = '/home/u/app'

const s = (o: Partial<ContextSession> & { id: string }): ContextSession => ({
  status: 'running', cwd: CWD, harness: 'claude', ...o,
})

const plan = (sessions: ContextSession[], cwd = CWD) =>
  planSessionContext({ sessions, cwd, home: HOME })

describe('saying nothing', () => {
  test('an empty fleet costs the session zero tokens', () => {
    expect(plan([])).toBeNull()
  })

  test('so does a machine whose only rows are ones agentop does not host', () => {
    expect(plan([
      s({ id: 'ext1', status: 'external', task: undefined }),
      s({ id: 'clo1', status: 'closed', task: 'old' }),
    ])).toBeNull()
  })

  test('a finished task somewhere ELSE is not this directory\'s business', () => {
    expect(plan([s({ id: 'a1', status: 'lost', cwd: '/home/u/other', task: 'elsewhere' })])).toBeNull()
  })
})

describe('a leader waiting on its workers', () => {
  test('is not counted as waiting on a person, and says what it waits on', () => {
    const out = plan([
      s({ id: 'leadlead11', activity: 'waiting', waitingOnWorkers: 1 }),
      s({ id: 'workwork22', activity: 'working' }),
    ])!
    expect(out).not.toContain('waiting on a person')
    expect(out).toContain('waiting on workers')
  })

  test('without busy workers it is the person\'s again', () => {
    expect(plan([s({ id: 'leadlead11', activity: 'waiting' }), s({ id: 'workwork22', activity: 'working' })]))
      .toContain('1 of them is waiting on a person')
  })
})

describe('what is running', () => {
  test('counts them and names each one', () => {
    const out = plan([
      s({ id: 'aaaaaaaa11', activity: 'working', task: 'auth' }),
      s({ id: 'bbbbbbbb22', activity: 'working', task: 'auth', harness: 'codex' }),
    ])
    expect(out).toContain('agentop is hosting 2 assistant sessions')
    expect(out).toContain('aaaaaaaa')
    expect(out).toContain('codex')
    expect(out).toContain('task "auth"')
    expect(out).toContain('~/app')
  })

  test('singular reads as one session, not "1 sessions"', () => {
    expect(plan([s({ id: 'a1', activity: 'working' })])).toContain('hosting 1 assistant session on this machine.')
  })

  test('a fleet that is entirely blocked says so, rather than reading as a subset', () => {
    expect(plan([s({ id: 'a1', activity: 'waiting' }), s({ id: 'a2', activity: 'waiting-approval' })]))
      .toContain('All of them are waiting on a person.')
    expect(plan([s({ id: 'a1', activity: 'waiting-approval' })])).toContain('It is waiting on a person.')
  })

  test('what is blocked on a person leads the list and is counted in words', () => {
    const out = plan([
      s({ id: 'work1', activity: 'working' }),
      s({ id: 'appr1', activity: 'waiting-approval' }),
      s({ id: 'wait1', activity: 'waiting' }),
    ])!
    expect(out).toContain('2 of them are waiting on a person')
    const rows = out.split('\n').filter(l => l.startsWith('  '))
    expect(rows[0]).toContain('appr1')
    expect(rows[0]).toContain('needs approval')
    expect(rows[1]).toContain('wait1')
    expect(rows[2]).toContain('work1')
  })

  test('a long fleet is capped and says how many it did not list', () => {
    const many = Array.from({ length: 12 }, (_, i) => s({ id: `id${String(i).padStart(2, '0')}`, activity: 'working' }))
    const out = planSessionContext({ sessions: many, cwd: CWD, home: HOME, maxRows: 3 })!
    expect(out).toContain('…and 9 more')
    expect(out.split('\n').filter(l => l.startsWith('  ') && !l.includes('more'))).toHaveLength(3)
  })
})

describe('what can be reopened here', () => {
  test('a task with no live session left is offered, with its session count', () => {
    const out = plan([s({ id: 'a1', status: 'lost', task: 'docs-sweep' }), s({ id: 'a2', status: 'exited', task: 'docs-sweep' })])!
    expect(out).toContain('"docs-sweep" (2 sessions)')
    expect(out).toContain('agentop session open "<task>"')
  })

  test('a task that is still running is not offered as reopenable — it is already open', () => {
    const out = plan([
      s({ id: 'live1', activity: 'working', task: 'auth' }),
      s({ id: 'dead1', status: 'lost', task: 'auth' }),
    ])!
    expect(out).not.toContain('Filed in this directory')
  })

  test('a session in a SUBdirectory counts as here; a sibling with the same prefix does not', () => {
    const out = plan([
      s({ id: 'sub1', status: 'lost', cwd: '/home/u/app/packages/api', task: 'inside' }),
      s({ id: 'sib1', status: 'lost', cwd: '/home/u/apple', task: 'outside' }),
    ])!
    expect(out).toContain('"inside"')
    expect(out).not.toContain('"outside"')
  })
})

describe('the block itself', () => {
  test('is fenced, so the model can see where the injected facts start and stop', () => {
    const out = plan([s({ id: 'a1', activity: 'working' })])!
    expect(out.startsWith('<agentop-sessions>\n')).toBe(true)
    expect(out.endsWith('\n</agentop-sessions>')).toBe(true)
  })

  test('says outright that it is state, not an instruction to act on', () => {
    expect(plan([s({ id: 'a1', activity: 'working' })])).toContain('not a request')
  })
})

describe('tildePath', () => {
  test('shortens the home directory and leaves a lookalike alone', () => {
    expect(tildePath('/home/u/app', '/home/u')).toBe('~/app')
    expect(tildePath('/home/u', '/home/u')).toBe('~')
    expect(tildePath('/home/user2/app', '/home/u')).toBe('/home/user2/app')
    expect(tildePath('/srv/x', '')).toBe('/srv/x')
  })
})

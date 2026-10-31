import { describe, expect, test } from 'bun:test'
import { pgidOfStat, planSweep, RUNNER_ENV, type ProcInfo } from './test-orphans'

const ROOT = '/work/agentistics'
const proc = (pid: number, cmdline: string, runner: number | null, pgid = pid): ProcInfo => ({
  pid, pgid, cmdline, env: ['PATH=/usr/bin', ...(runner === null ? [] : [`${RUNNER_ENV}=${runner}`])],
})

describe('planSweep', () => {
  test('ends what THIS run started under the checkout or the temp dir, and nothing else', () => {
    const plan = planSweep([
      proc(10, 'bun run /work/agentistics/packages/server/server/sessions/structured-relay.ts /tmp/f2b-x/structured/m-1', 7),
      proc(11, 'bun run /work/agentistics/packages/server/bin/cli.ts __relay-worker', 7, 10),
      proc(12, 'bash /tmp/structured-relay-abc/child.sh', 7),
      proc(13, 'tmux -L agentop-test -S /tmp/sock-1 new-session', 7, 99),
      proc(7, 'bun test', 7), // the runner itself
      proc(20, 'bun run /work/agentistics/packages/server/server/sessions/structured-relay.ts /x', 8), // another run
      proc(21, 'bun run /work/agentistics/x.ts', null), // nobody's run
      proc(22, 'tmux new-session', 7), // carries the mark but names neither place: spared
    ], 7, [ROOT, '/tmp'])
    expect(plan.kill).toEqual([10, 11, 12, 13])
    expect(plan.groups).toEqual([10, 12]) // leaders only; 11 is in 10's group, 13 in a group it does not lead
    expect(plan.relays).toHaveLength(3)
    expect(plan.others).toEqual(['tmux -L agentop-test -S /tmp/sock-1 new-session'])
  })

  test('the mark must match exactly: a pid that merely starts with ours is another run', () => {
    expect(planSweep([proc(10, '/work/agentistics/a.ts', 77)], 7, [ROOT]).kill).toEqual([])
  })

  test('an empty root never matches everything', () => {
    expect(planSweep([proc(10, 'anything', 7)], 7, ['']).kill).toEqual([])
  })
})

describe('pgidOfStat', () => {
  test('reads field 5, after a comm that may hold spaces and parentheses', () => {
    expect(pgidOfStat('123 (bun) S 1 456 456 0 -1')).toBe(456)
    expect(pgidOfStat('123 (a b) c)) S 1 789 789 0 -1')).toBe(789)
    expect(pgidOfStat('garbage')).toBeNull()
  })
})

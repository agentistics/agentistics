import { describe, expect, it } from 'bun:test'
import { planLateWatches } from './watch-plan'

const W = (dir: string, label = dir) => ({ dir, label })

describe('planLateWatches', () => {
  it('returns only directories that exist now and are not watched yet', () => {
    const exists = (d: string) => d !== '/h/.kimi-code/sessions'
    const plan = planLateWatches(
      [W('/h/.codex/sessions'), W('/h/.gemini/tmp'), W('/h/.kimi-code/sessions')],
      new Set(['/h/.codex/sessions']),
      exists,
    )
    expect(plan.map(p => p.dir)).toEqual(['/h/.gemini/tmp'])
  })

  it('a directory that appears later is planned on the next ask, then never again once watched', () => {
    const present = new Set<string>()
    const watched = new Set<string>()
    const wanted = [W('/h/.gemini/tmp', 'gemini')]
    expect(planLateWatches(wanted, watched, d => present.has(d))).toEqual([])
    present.add('/h/.gemini/tmp')
    const plan = planLateWatches(wanted, watched, d => present.has(d))
    expect(plan.map(p => p.label)).toEqual(['gemini'])
    for (const p of plan) watched.add(p.dir)
    expect(planLateWatches(wanted, watched, d => present.has(d))).toEqual([])
  })

  it('a directory wanted twice is planned once', () => {
    expect(planLateWatches([W('/a', 'x'), W('/a', 'y')], new Set(), () => true)).toEqual([W('/a', 'x')])
  })
})

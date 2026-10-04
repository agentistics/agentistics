import { describe, expect, test } from 'bun:test'
import { createBuildTimer } from './build-timer'

describe('createBuildTimer', () => {
  test('one line: the total, then each phase in order with its ms, the slowest marked', () => {
    let t = 1000
    const timer = createBuildTimer(() => t)
    t += 120; timer.mark('read')
    t += 4000; timer.mark('projects')
    t += 30; timer.mark('codex')
    t += 30; timer.mark('codex')
    expect(timer.line()).toBe('built in 4180 ms: read 120, projects 4000 (slowest), codex 60')
  })

  test('phases under 1 ms are dropped from the line, never the total', () => {
    let t = 0
    const timer = createBuildTimer(() => t)
    t += 0.4; timer.mark('tiny')
    t += 10; timer.mark('real')
    expect(timer.line()).toBe('built in 10 ms: real 10 (slowest)')
  })
})

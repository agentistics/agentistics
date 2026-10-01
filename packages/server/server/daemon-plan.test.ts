import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { serverDaemonPlan } from './daemon-plan'

describe('serverDaemonPlan', () => {
  test('a native machine runs everything — the behaviour `agentop server` always had', () => {
    expect(serverDaemonPlan({ central: false, container: false }))
      .toEqual({ watcher: true, eventProducer: true, scheduledBackup: true, updateBanner: true })
  })

  // A central has no host sessions: no fleet to poll, no ~/.claude to snapshot, no machine history
  // to back up. Natively or in the published image.
  test('a central starts none of the daemon, natively or in a container', () => {
    for (const container of [false, true]) {
      const p = serverDaemonPlan({ central: true, container })
      expect(p.watcher, `container=${container}`).toBe(false)
      expect(p.eventProducer, `container=${container}`).toBe(false)
      expect(p.scheduledBackup, `container=${container}`).toBe(false)
    }
  })

  test('a container never polls the fleet, never backs up the mounted dir, never says "run agentop upgrade"', () => {
    for (const central of [false, true]) {
      const p = serverDaemonPlan({ central, container: true })
      expect(p.eventProducer).toBe(false)
      expect(p.scheduledBackup).toBe(false)
      expect(p.updateBanner).toBe(false)
    }
  })

  test('a native central still prints the update banner — it IS upgraded by `agentop upgrade`', () => {
    expect(serverDaemonPlan({ central: true, container: false }).updateBanner).toBe(true)
  })
})

// The plan is only worth something if both places that start the riders read it. A refactor that
// goes back to unconditional imports compiles and reintroduces the event producer on every central.
describe('the plan is wired where the daemon starts', () => {
  const src = (rel: string) => readFileSync(join(import.meta.dir, rel), 'utf8')

  test('cli.ts loads the watcher and the banner only through the plan', () => {
    const cli = src('../bin/cli.ts')
    expect(cli).toContain('plan.watcher ? import(\'../server/otel-watcher.ts\') : null')
    expect(cli).toContain('plan.updateBanner ? checkVersionAndWarn() : null')
  })

  test('otel-watcher.ts starts the event producer and the backup only through the plan', () => {
    const w = src('otel-watcher.ts')
    expect(w).toContain('if (plan.eventProducer) {')
    expect(w).toContain('if (plan.scheduledBackup) {')
    expect(w.indexOf('startEventProducer()')).toBeGreaterThan(w.indexOf('if (plan.eventProducer) {'))
    expect(w.indexOf('startScheduledBackup()')).toBeGreaterThan(w.indexOf('if (plan.scheduledBackup) {'))
  })

  test('the image sets AGENTISTICS_CONTAINER=1 in its runtime stage', () => {
    const df = readFileSync(join(import.meta.dir, '..', '..', '..', 'Dockerfile'), 'utf8')
    const runner = df.slice(df.indexOf('AS runner'))
    expect(runner).toContain('AGENTISTICS_CONTAINER=1')
  })
})

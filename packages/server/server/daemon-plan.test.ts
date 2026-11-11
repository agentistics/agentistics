import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { serverDaemonPlan } from './daemon-plan'

describe('serverDaemonPlan', () => {
  test('a native machine runs everything — the behaviour `agentop server` always had', () => {
    expect(serverDaemonPlan({ container: false }))
      .toEqual({ watcher: true, eventProducer: true, scheduledBackup: true, updateBanner: true })
  })

  test('a container never polls the fleet, never backs up the mounted dir, never says "run agentop upgrade"', () => {
    const p = serverDaemonPlan({ container: true })
    expect(p.eventProducer).toBe(false)
    expect(p.scheduledBackup).toBe(false)
    expect(p.updateBanner).toBe(false)
  })
})

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

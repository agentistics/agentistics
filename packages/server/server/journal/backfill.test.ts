import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  backfillComplete, backfillPending, backgroundImportArgv, cliArgv, maybeStartAutoBackfill, memoryPause, planAutoBackfill,
  readBackfillProgress, writeBackfillProgress, type BackfillProgress,
} from './backfill'
import { fileIdentity } from './shadow'

const NOW = Date.parse('2026-10-03T12:00:00Z')
const progress = (p: Partial<BackfillProgress>): BackfillProgress => ({
  v: 1, identity: 'id-1', state: 'running', startedAt: '2026-10-03T11:00:00Z', updatedAt: '2026-10-03T11:59:00Z', written: 0, ...p,
})
const plan = (o: Partial<Parameters<typeof planAutoBackfill>[0]> = {}) => planAutoBackfill({
  journalEnabled: true, central: false, optedOut: false, progress: null, journalIdentity: 'id-1', nowMs: NOW, staleMs: 10 * 60_000, ...o,
})

describe('planAutoBackfill: the first import starts by itself, once', () => {
  test('a journal never imported: start', () => expect(plan()).toEqual({ start: true }))
  test('journal off, a central, or opted out: never', () => {
    expect(plan({ journalEnabled: false })).toEqual({ start: false, reason: 'journal-off' })
    expect(plan({ central: true })).toEqual({ start: false, reason: 'central' })
    expect(plan({ optedOut: true })).toEqual({ start: false, reason: 'opted-out' })
  })
  test('completed for THIS journal: never again; completed for a replaced journal: start over', () => {
    const done = progress({ state: 'done', completedAt: '2026-10-03T11:30:00Z' })
    expect(plan({ progress: done })).toEqual({ start: false, reason: 'complete' })
    expect(plan({ progress: done, journalIdentity: 'id-2' })).toEqual({ start: true })
  })
  test('another live import (fresh running/paused record) is left alone; a stale one is resumed', () => {
    expect(plan({ progress: progress({ state: 'paused' }) })).toEqual({ start: false, reason: 'running-elsewhere' })
    expect(plan({ progress: progress({ updatedAt: '2026-10-03T10:00:00Z' }) })).toEqual({ start: true })
    expect(plan({ progress: progress({ state: 'interrupted' }) })).toEqual({ start: true })
  })
})

describe('backfillComplete / backfillPending', () => {
  test('pending until a completed record names this journal file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'backfill-'))
    const journal = join(dir, 'journal.db')
    const prog = join(dir, 'journal.db.backfill.json')
    writeFileSync(journal, 'x')
    expect(backfillPending(journal, prog)).toBe(true)
    await writeBackfillProgress(prog, progress({ identity: fileIdentity(journal), state: 'running' }))
    expect(backfillPending(journal, prog)).toBe(true)
    await writeBackfillProgress(prog, progress({ identity: fileIdentity(journal), state: 'done', completedAt: '2026-10-03T12:00:00Z' }))
    expect(backfillPending(journal, prog)).toBe(false)
    expect(readBackfillProgress(prog)?.state).toBe('done')
    expect(backfillComplete(readBackfillProgress(prog), null)).toBe(false)
  })
})

describe('memoryPause: the import waits while the gate refuses', () => {
  test('admitted: returns at once, says nothing', async () => {
    const events: string[] = []
    await memoryPause({ ask: async () => ({ admit: true }), onPause: () => { events.push('pause') }, onResume: () => { events.push('resume') } })()
    expect(events).toEqual([])
  })
  test('refused twice, then admitted: one pause, one resume, and it re-asked on its interval', async () => {
    const answers = [{ admit: false, reason: 'swap' }, { admit: false, reason: 'swap' }, { admit: true }] as const
    let i = 0
    const events: string[] = []
    const slept: number[] = []
    await memoryPause({
      ask: async () => answers[i++]!,
      onPause: r => { events.push(`pause:${r}`) }, onResume: () => { events.push('resume') },
      sleep: async ms => { slept.push(ms) }, recheckMs: 5,
    })()
    expect(events).toEqual(['pause:swap', 'resume'])
    expect(slept).toEqual([5, 5])
  })
  test('a gate that throws admits (an unmeasurable machine is admitted everywhere)', async () => {
    await memoryPause({ ask: async () => { throw new Error('no /proc') }, onPause: () => { throw new Error('must not pause') }, onResume: () => {} })()
  })
})

describe('the child process', () => {
  test('lowest CPU and I/O priority where the tools exist, plain otherwise', () => {
    expect(backgroundImportArgv(['agentop'], { nice: '/usr/bin/nice', ionice: '/usr/bin/ionice' }))
      .toEqual(['/usr/bin/nice', '-n', '19', '/usr/bin/ionice', '-c', '3', 'agentop', 'journal', 'import', '--background'])
    expect(backgroundImportArgv(['agentop'], { nice: null, ionice: null })).toEqual(['agentop', 'journal', 'import', '--background'])
  })
  test('the compiled binary re-invokes itself; a checkout runs bin/cli.ts', () => {
    expect(cliArgv('/usr/local/bin/agentop', undefined, '/x/server/journal')).toEqual(['/usr/local/bin/agentop'])
    expect(cliArgv('/usr/bin/bun', '/repo/packages/server/server/index.ts', '/repo/packages/server/server/journal'))
      .toEqual(['/usr/bin/bun', '/repo/packages/server/bin/cli.ts'])
  })
  test('maybeStartAutoBackfill spawns once the plan says start, and not otherwise', () => {
    const dir = mkdtempSync(join(tmpdir(), 'backfill-'))
    const spawned: string[][] = []
    const deps = { journalEnabled: true, central: false, journalPath: join(dir, 'journal.db'), progressPath: join(dir, 'p.json'), env: {}, spawn: (a: string[]) => { spawned.push(a) } }
    expect(maybeStartAutoBackfill(deps)).toEqual({ start: true })
    expect(spawned[0]!.slice(-3)).toEqual(['journal', 'import', '--background'])
    expect(maybeStartAutoBackfill({ ...deps, env: { AGENTISTICS_JOURNAL_BACKFILL: '0' } })).toEqual({ start: false, reason: 'opted-out' })
    expect(spawned).toHaveLength(1)
  })
})

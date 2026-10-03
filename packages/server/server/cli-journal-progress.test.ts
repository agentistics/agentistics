import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runJournalImport } from './cli-journal'
import { JOURNAL_PATH } from './config'
import { backfillComplete, readBackfillProgress } from './journal/backfill'
import { fileIdentity } from './journal/shadow'

describe('a real import records its progress, and its completion, for the projections', () => {
  test('ran to its end: done, completedAt, bound to this journal file', async () => {
    const progressPath = join(mkdtempSync(join(tmpdir(), 'jprog-')), 'p.json')
    const code = await runJournalImport(['--harness', 'claude', '--json'], { integrations: {}, progressPath })
    expect(code).toBe(0)
    const p = readBackfillProgress(progressPath)!
    expect(p.state).toBe('done')
    expect(p.completedAt).toBeDefined()
    expect(backfillComplete(p, fileIdentity(JOURNAL_PATH))).toBe(true)
  })

  test('a dry run records nothing', async () => {
    const progressPath = join(mkdtempSync(join(tmpdir(), 'jprog-')), 'p.json')
    expect(await runJournalImport(['--dry-run', '--json'], { integrations: {}, progressPath })).toBe(0)
    expect(readBackfillProgress(progressPath)).toBeNull()
  })

  test('interrupted: no completedAt, so the projections keep waiting', async () => {
    const progressPath = join(mkdtempSync(join(tmpdir(), 'jprog-')), 'p.json')
    const { runImport } = await import('./journal/import')
    const code = await runJournalImport(['--background', '--json'], {
      integrations: {}, progressPath,
      run: async o => { const r = await runImport(o); return r.ok ? { ok: true, report: { ...r.report, interrupted: true } } : r },
    })
    expect(code).toBe(130)
    const p = readBackfillProgress(progressPath)!
    expect(p.state).toBe('interrupted')
    expect(p.completedAt).toBeUndefined()
  })
})

import { backfillLine } from './cli-journal'

describe('journal status: the first import in one line', () => {
  const base = { v: 1 as const, identity: 'i', startedAt: 's', updatedAt: 'u', written: 1234 }
  test('each state says what the surfaces do and what happens next', () => {
    expect(backfillLine(null, false)).toContain('not run yet')
    expect(backfillLine({ ...base, state: 'running', harness: 'codex', phase: 'artifacts', done: 3, total: 19 }, false)).toContain('running · codex artifacts 3/19 · 1,234 events written')
    expect(backfillLine({ ...base, state: 'paused', pausedReason: 'swap' }, false)).toContain('PAUSED — memory pressure (swap over its alarm)')
    expect(backfillLine({ ...base, state: 'interrupted' }, false)).toContain('resumes on the next server start')
    expect(backfillLine({ ...base, state: 'done', completedAt: 'c' }, true)).toContain('complete (c)')
  })
})

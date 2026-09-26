/**
 * health-journal.test.ts — the journal's health-panel half (A1.5): `analyzeJournalStatus` (pure)
 * and `setJournalStatusSource` / its wiring into `runHealthChecks`.
 *
 * The end-to-end case makes the journal genuinely unwritable on disk (a parent path that is a
 * plain file, so mkdir fails) rather than only asserting against a hand-built status — the
 * hand-built cases below cover every `JournalDisabledReason` the pure function must turn into
 * words, which a single end-to-end run cannot reach.
 */
import { afterEach, beforeAll, afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HealthIssue } from '@agentistics/core'
import { analyzeJournalStatus, runHealthChecks, setJournalStatusSource } from './health'
import { openJournal } from './journal/journal'
import { defaultPathProbe } from './journal/schema'
import type { JournalCounters, JournalDisabledReason, JournalStatus } from './journal/types'

let root = ''
beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'agentistics-health-journal-')) })
afterAll(() => { rmSync(root, { recursive: true, force: true }) })
afterEach(() => { setJournalStatusSource(null) })

const ALL_REASONS: JournalDisabledReason[] = [
  'network-filesystem',
  'no-sqlite',
  'open-failed',
  'wal-unavailable',
  'db-schema-too-new',
  'migrate-failed',
]

function emptyCounters(overrides: Partial<JournalCounters> = {}): JournalCounters {
  return { written: 0, duplicates: 0, rejected: 0, dropped: 0, failedAppends: 0, failedReads: 0, ...overrides }
}

function disabledStatus(reason: JournalDisabledReason | undefined, path = '/tmp/agentistics-journal/journal.db'): JournalStatus {
  return { state: 'disabled', reason, path, pathKind: 'local', counters: emptyCounters() }
}

function openStatus(path: string, counters: JournalCounters = emptyCounters()): JournalStatus {
  return { state: 'open', path, pathKind: 'local', counters }
}

function closedStatus(path: string): JournalStatus {
  return { state: 'closed', path, pathKind: 'local', counters: emptyCounters() }
}

describe('an unwritable journal, end to end', () => {
  test('a parent path that is a plain file fails to open, and analyzeJournalStatus names the path', async () => {
    const blocker = join(root, 'blocker-file')
    writeFileSync(blocker, 'x')
    const path = join(blocker, 'journal.db')

    const j = await openJournal({ path, probe: defaultPathProbe() })
    expect(j.status().state).toBe('disabled')
    expect(j.status().reason).toBeDefined()

    const issues: HealthIssue[] = []
    analyzeJournalStatus(j.status(), issues)

    expect(issues.length).toBe(1)
    expect(issues[0]).toMatchObject({ id: 'journal-unwritable', severity: 'warning' })
    expect(issues[0]!.description).toContain(path)
  })
})

describe('every JournalDisabledReason gets its own words', () => {
  test('one issue per reason, distinct descriptions, and a non-empty guide each', () => {
    const descriptions = new Set<string>()
    for (const reason of ALL_REASONS) {
      const issues: HealthIssue[] = []
      analyzeJournalStatus(disabledStatus(reason), issues)
      expect(issues.length).toBe(1)
      const issue = issues[0]!
      expect(issue.id).toBe('journal-unwritable')
      expect(issue.severity).toBe('warning')
      expect(issue.guide).toBeTruthy()
      descriptions.add(issue.description)
    }
    expect(descriptions.size).toBe(ALL_REASONS.length)
  })

  test('a disabled status with reason undefined still yields exactly one issue, and never throws', () => {
    const issues: HealthIssue[] = []
    expect(() => analyzeJournalStatus(disabledStatus(undefined), issues)).not.toThrow()
    expect(issues.length).toBe(1)
    expect(issues[0]).toMatchObject({ id: 'journal-unwritable', severity: 'warning' })
  })
})

describe('when there is nothing to warn about', () => {
  test('a null status raises no issue', () => {
    const issues: HealthIssue[] = []
    analyzeJournalStatus(null, issues)
    expect(issues).toEqual([])
  })

  test('a closed journal raises no issue', () => {
    const issues: HealthIssue[] = []
    analyzeJournalStatus(closedStatus('/tmp/x/journal.db'), issues)
    expect(issues).toEqual([])
  })

  test('an open journal with zero failedAppends raises no issue', () => {
    const issues: HealthIssue[] = []
    analyzeJournalStatus(openStatus('/tmp/x/journal.db'), issues)
    expect(issues).toEqual([])
  })
})

describe('an open journal that is failing writes', () => {
  test('failedAppends with a dropped count raises one issue mentioning the dropped count', () => {
    const issues: HealthIssue[] = []
    const status = openStatus('/tmp/x/journal.db', emptyCounters({ written: 10, failedAppends: 2, dropped: 150 }))
    analyzeJournalStatus(status, issues)
    expect(issues.length).toBe(1)
    expect(issues[0]).toMatchObject({ id: 'journal-unwritable', severity: 'warning' })
    expect(issues[0]!.description).toContain('150')
  })
})

describe('runHealthChecks integration', () => {
  test('a disabled journal source surfaces as a journal-unwritable health issue', async () => {
    setJournalStatusSource(() => disabledStatus('open-failed'))
    const issues = await runHealthChecks()
    expect(issues.some(i => i.id === 'journal-unwritable')).toBe(true)
  })

  test('a source that throws never makes runHealthChecks reject', async () => {
    setJournalStatusSource(() => { throw new Error('boom') })
    await expect(runHealthChecks()).resolves.toBeDefined()
  })

  test('no source registered: no journal-unwritable issue is invented', async () => {
    setJournalStatusSource(null)
    const issues = await runHealthChecks()
    expect(issues.some(i => i.id === 'journal-unwritable')).toBe(false)
  })
})

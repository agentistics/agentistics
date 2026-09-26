/**
 * cli-journal.test.ts — `agentop journal status`, against the API stated in A1.5's contract
 * (see cli-journal.ts's own header once it lands). The load-bearing case is §12.6: a machine that
 * has never had the journal on must ANSWER, saying so, rather than failing or lying with a zero —
 * and asking about it must never be the thing that turns it on.
 *
 * Nothing here mocks the filesystem for a pure function; every path is a real temp directory
 * (mkdtempSync under os.tmpdir()), and the one thing that IS faked is the mount-table PROBE, the
 * same injection point journal.test.ts already uses so a test never depends on the host's real
 * filesystem layout.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectJournalReport, readSinceBoot, renderJournalStatus, runJournal } from './cli-journal'
import { openJournal, type OpenJournalOptions } from './journal/journal'
import type { PathProbe } from './journal/schema'

let root = ''
let seq = 0

beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'agentistics-cli-journal-')) })
afterAll(() => { rmSync(root, { recursive: true, force: true }) })

/** A probe that says every path is on a local ext4 root — mirrors journal.test.ts's own localProbe. */
function localProbe(): PathProbe {
  return {
    platform: 'linux',
    realpath: p => p,
    readMountinfo: () => '58 42 8:32 / / rw,relatime - ext4 /dev/sdc rw',
    readDarwinMounts: () => null,
  }
}

/** A path under a directory that has never been created, and never will be by this test. */
function freshMissingPath(): string {
  return join(root, `missing-${++seq}`, 'here', 'journal.db')
}

describe('a machine that has never had the journal on', () => {
  test('asking about status never opens the journal, and creates nothing on disk', async () => {
    const missingRoot = join(root, `never-${++seq}`)
    const path = join(missingRoot, 'here', 'journal.db')
    expect(existsSync(missingRoot)).toBe(false)

    let openCalls = 0
    const openSpy: typeof openJournal = async (_opts?: OpenJournalOptions) => {
      openCalls++
      throw new Error('open must not be called just to answer a status question')
    }

    const report = await collectJournalReport({ path, env: {}, probe: localProbe(), open: openSpy })

    expect(report.present).toBe(false)
    expect(openCalls).toBe(0)
    expect(existsSync(missingRoot)).toBe(false)
    expect(existsSync(path)).toBe(false)
  })

  test('renders in words: names the path, says there has never been a journal, and never a confident zero', async () => {
    const path = freshMissingPath()
    const report = await collectJournalReport({ path, env: {}, probe: localProbe() })
    const text = renderJournalStatus(report)

    expect(text).toContain(path)
    expect(text).toMatch(/no journal|never/i)
    // A rows count implies a journal that exists; nothing here may claim a confident zero for a
    // thing that has never been written.
    expect(text).not.toMatch(/rows:\s*0/i)
  })

  test('says counters since boot are unavailable, and that no differential has run', async () => {
    const path = freshMissingPath()
    const report = await collectJournalReport({ path, env: {}, probe: localProbe() })

    expect(report.sinceBoot).toBeNull()
    expect(report.differential).toBeNull()

    const text = renderJournalStatus(report).toLowerCase()
    expect(text).toMatch(/since (boot|the writing process)/)
    expect(text).toMatch(/not available|unavailable|n\/a/)
    expect(text).toMatch(/differential/)
    expect(text).toMatch(/no differential|not (?:been )?run|none|never run/)
  })

  test('runJournal status exits 0', async () => {
    const path = freshMissingPath()
    const code = await runJournal(['status'], { path, env: {}, probe: localProbe() })
    expect(code).toBe(0)
  })

  test('runJournal status --json exits 0 and prints parseable JSON with present: false', async () => {
    const path = freshMissingPath()
    const originalLog = console.log
    const lines: string[] = []
    console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')) }
    let code: number
    try {
      code = await runJournal(['status', '--json'], { path, env: {}, probe: localProbe() })
    } finally {
      console.log = originalLog
    }
    expect(code).toBe(0)

    const printed = lines.join('\n')
    const start = printed.indexOf('{')
    const end = printed.lastIndexOf('}')
    expect(start).toBeGreaterThanOrEqual(0)
    const parsed = JSON.parse(printed.slice(start, end + 1)) as { present: boolean }
    expect(parsed.present).toBe(false)
  })

  test('an unknown subcommand is refused with exit 1', async () => {
    const path = freshMissingPath()
    const code = await runJournal(['bogus'], { path, env: {}, probe: localProbe() })
    expect(code).toBe(1)
  })
})

describe('a machine that HAS had the journal on', () => {
  test('present, status defined, stats.rows === 0, and the render mentions rows', async () => {
    const path = join(root, `present-${++seq}`, 'journal.db')
    const setup = await openJournal({ path, probe: localProbe() })
    const sqliteAvailable = setup.status().state === 'open'
    setup.close()

    const report = await collectJournalReport({ path })

    expect(report.present).toBe(true)

    if (sqliteAvailable) {
      expect(report.status).toBeDefined()
      expect(report.stats).toBeDefined()
      expect(report.stats?.rows).toBe(0)
      const text = renderJournalStatus(report).toLowerCase()
      expect(text).toContain('rows')
    } else {
      // bun:sqlite could not even be loaded by the real journal used for setup: whatever this
      // report says, it must still describe a disabled state in words, never a silent blank.
      const text = renderJournalStatus(report).toLowerCase()
      expect(text).toMatch(/disabled|no-sqlite|not available|unavailable/)
    }
  })
})

describe('since-boot counters from the shadow writer\'s status file', () => {
  const counters = { written: 12, duplicates: 3, rejected: 1, dropped: 0, failedAppends: 0, failedReads: 0 }
  function statusFile(over: Record<string, unknown> = {}): string {
    const dir = join(root, `status-${++seq}`)
    mkdirSync(dir, { recursive: true })
    const p = join(dir, 'journal.db.status.json')
    writeFileSync(p, JSON.stringify({ v: 1, pid: 4242, sinceBoot: { counters, rejectedByReason: { 'bad-timestamp': 1 } }, ...over }))
    return p
  }

  test('a live writer\'s numbers are reported, with the per-reason breakdown', () => {
    expect(readSinceBoot(statusFile(), () => true)).toEqual({ counters, rejectedByReason: { 'bad-timestamp': 1 } })
  })

  test('a writer that has exited reports NOTHING — its numbers are not the running server\'s', () => {
    expect(readSinceBoot(statusFile(), () => false)).toBeNull()
  })

  test('absent, unparseable or foreign-version files answer null, never a zero', () => {
    expect(readSinceBoot(join(root, 'nope.json'), () => true)).toBeNull()
    const bad = statusFile()
    writeFileSync(bad, '{not json')
    expect(readSinceBoot(bad, () => true)).toBeNull()
    expect(readSinceBoot(statusFile({ v: 2 }), () => true)).toBeNull()
  })

  test('collectJournalReport fills sinceBoot from the file beside the journal, and renders it', async () => {
    const path = freshMissingPath()
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(`${path}.status.json`, JSON.stringify({ v: 1, pid: 4242, sinceBoot: { counters } }))
    const report = await collectJournalReport({ path, alive: () => true })
    expect(report.sinceBoot?.counters.written).toBe(12)
    expect(renderJournalStatus(report)).toContain('Written: 12')
  })
})

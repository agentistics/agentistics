import { afterEach, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BuildIdentity } from './build-identity.ts'
import { INSTALLS_CAP, parseLedger, planInstall, readInstalls, recordInstall, renderInstalls, type InstallEntry } from './installs-ledger.ts'

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'installs-')); dirs.push(d); return join(d, 'installs.jsonl') }

const B = (o: Partial<BuildIdentity> = {}): BuildIdentity => ({ repoKey: 'github.com/o/r', sha: 'a'.repeat(40), tree: 't'.repeat(40), builtAt: '2026-11-13T00:00:00.000Z', capabilities: [], ...o })
const T0 = new Date('2026-11-13T10:00:00.000Z')
const lines = (f: string) => readFileSync(f, 'utf8').split('\n').filter(Boolean)

describe('install ledger', () => {
  test('first boot appends one line with previousBuildSha null', () => {
    const f = tmp()
    const r = recordInstall({ file: f, build: B(), version: '2.211.0', now: T0 })
    expect(r.appended).toBe(true)
    const e = JSON.parse(lines(f)[0]!) as InstallEntry
    expect(e).toEqual({ repoKey: 'github.com/o/r', version: '2.211.0', buildSha: 'a'.repeat(40), tree: 't'.repeat(40), firstSeenAt: T0.toISOString(), previousBuildSha: null })
  })

  test('idempotent: repeated boots of the same {repoKey, sha, version} add nothing', () => {
    const f = tmp()
    for (let i = 0; i < 5; i++) recordInstall({ file: f, build: B(), version: '2.211.0', now: new Date(T0.getTime() + i) })
    expect(lines(f)).toHaveLength(1)
  })

  test.each([
    ['repoKey', B({ repoKey: 'github.com/o/other' }), '2.211.0'],
    ['sha', B({ sha: 'b'.repeat(40) }), '2.211.0'],
    ['version', B(), '2.212.0'],
  ])('a change of %s appends, carrying the previous sha', (_n, build, version) => {
    const f = tmp()
    recordInstall({ file: f, build: B(), version: '2.211.0', now: T0 })
    const r = recordInstall({ file: f, build, version, now: new Date(T0.getTime() + 1000) })
    expect(r.appended).toBe(true)
    expect(lines(f)).toHaveLength(2)
    expect((JSON.parse(lines(f)[1]!) as InstallEntry).previousBuildSha).toBe('a'.repeat(40))
  })

  test('a tree-only change does not append (the key is {repoKey, sha, version})', () => {
    const f = tmp()
    recordInstall({ file: f, build: B(), version: '1', now: T0 })
    expect(recordInstall({ file: f, build: B({ tree: 'x'.repeat(40) }), version: '1', now: T0 }).appended).toBe(false)
  })

  test('null identity (no git) is recorded once and is stable', () => {
    const f = tmp()
    const nb = B({ repoKey: null, sha: null, tree: null })
    recordInstall({ file: f, build: nb, version: '1', now: T0 })
    recordInstall({ file: f, build: nb, version: '1', now: T0 })
    expect(lines(f)).toHaveLength(1)
    expect(JSON.parse(lines(f)[0]!).buildSha).toBeNull()
  })

  test('the file is mode 0600, also after a trim rewrite', () => {
    const f = tmp()
    recordInstall({ file: f, build: B(), version: '1', now: T0 })
    expect(statSync(f).mode & 0o777).toBe(0o600)
    for (let i = 0; i < INSTALLS_CAP + 3; i++) recordInstall({ file: f, build: B(), version: `v${i}`, now: T0 })
    expect(statSync(f).mode & 0o777).toBe(0o600)
  })

  test('capped at 500 lines: the oldest go, the newest stay, no tmp left behind', () => {
    const f = tmp()
    for (let i = 0; i < INSTALLS_CAP + 20; i++) recordInstall({ file: f, build: B(), version: `v${i}`, now: T0 })
    const ls = lines(f)
    expect(ls).toHaveLength(INSTALLS_CAP)
    expect((JSON.parse(ls[0]!) as InstallEntry).version).toBe('v20')
    expect((JSON.parse(ls.at(-1)!) as InstallEntry).version).toBe(`v${INSTALLS_CAP + 19}`)
    expect(existsSync(`${f}.${process.pid}.tmp`)).toBe(false)
  })

  test('a corrupt last line does not crash boot; it is skipped and not glued onto', () => {
    const f = tmp()
    recordInstall({ file: f, build: B(), version: '1', now: T0 })
    appendFileSync(f, '{"version":"trunc') // truncated, no newline
    const same = recordInstall({ file: f, build: B(), version: '1', now: T0 })
    expect(same.appended).toBe(false) // compared against the last VALID line
    const next = recordInstall({ file: f, build: B(), version: '2', now: T0 })
    expect(next.appended).toBe(true)
    expect(readInstalls(f).map(e => e.version)).toEqual(['1', '2'])
    expect(parseLedger(readFileSync(f, 'utf8')).skipped).toBe(1)
  })

  test('a wholly unreadable ledger path never throws', () => {
    const r = recordInstall({ file: join(tmp(), 'no', 'such', 'dir', 'installs.jsonl'), build: B(), version: '1', now: T0 })
    expect(r.appended).toBe(false)
    expect((r as { error?: string }).error).toBeString()
  })

  test('planInstall is pure and readInstalls/render handle an absent file', () => {
    expect(planInstall(null, { build: B(), version: '1' }, T0)?.previousBuildSha).toBeNull()
    expect(readInstalls(join(tmp(), 'missing'))).toEqual([])
    expect(renderInstalls([])).toBe('no installs recorded yet')
    writeFileSync(tmp(), '')
  })
})

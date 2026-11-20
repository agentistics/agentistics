/**
 * CICLO.LIMPEZA — backup retention by size. QA-B1 and QA-B3 from the slice-1 QA (Sonnet 5.5) incorporated, plus R3: the
 * size cap reads the archive's REAL size (stat), the record's `archiveBytes` only as a fallback. Big archives are SPARSE
 * files (`truncate`), so nothing real is written.
 */
import { afterEach, expect, test } from 'bun:test'
import { existsSync, symlinkSync } from 'node:fs'
import { mkdir, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGENTISTICS_DATA_DIR } from '../config'
import { pruneOldBackups, withRealSizes } from '../cli-backup'
import { recordBackup, readPrunedPaths, type BackupRecord } from './backup-store'

const GiB = 1024 ** 3
const mk = (at: string, path: string, archiveBytes = 1): BackupRecord => ({
  at, path, layers: ['metrics'], harnesses: ['claude'], bytesUncompressed: 1,
  archiveBytes, sha256: 'x'.repeat(64), durationMs: 1,
})
const sparse = async (p: string, bytes: number) => { await writeFile(p, ''); await truncate(p, bytes) }
afterEach(async () => { await rm(AGENTISTICS_DATA_DIR, { recursive: true, force: true }) })

test('QA-B1 the newest alone is over 3 GiB: it stays, every older one goes (by size), never zero backups; a second run prunes nothing', async () => {
  const backups = join(AGENTISTICS_DATA_DIR, 'backups'); await mkdir(backups, { recursive: true })
  const ps = [1, 2, 3].map(n => join(backups, `b${n}.tar.zst`))
  for (const [i, p] of ps.entries()) {
    const size = i === 2 ? 4 * GiB : 100
    await sparse(p, size)
    await recordBackup(mk(`2026-01-0${i + 1}T00:00:00Z`, p, size))
  }
  await pruneOldBackups(7, () => {}, 3 * GiB)
  expect(ps.map(p => existsSync(p))).toEqual([false, false, true])
  const logs: string[] = []
  await pruneOldBackups(7, l => logs.push(l), 3 * GiB)
  expect(logs.filter(l => l.startsWith('pruned'))).toHaveLength(0)
  expect(existsSync(ps[2]!)).toBe(true)
})

test('QA-B3 a symlink in backups/ pointing outside is refused even under the size rule; the outside file stays', async () => {
  const backups = join(AGENTISTICS_DATA_DIR, 'backups'); await mkdir(backups, { recursive: true })
  const outside = await mkdtemp(join(tmpdir(), 'agentistics-qa-b3-'))
  const victim = join(outside, 'v.tar.zst'); await sparse(victim, 5 * GiB)
  const link = join(backups, 'old.tar.zst'); symlinkSync(victim, link)
  const newest = join(backups, 'new.tar.zst'); await writeFile(newest, 'n')
  await recordBackup(mk('2026-01-01T00:00:00Z', link, 5 * GiB)); await recordBackup(mk('2026-01-02T00:00:00Z', newest, 1))
  const logs: string[] = []
  await pruneOldBackups(7, l => logs.push(l), 3 * GiB)
  expect(existsSync(victim)).toBe(true)
  expect(logs.some(l => l.startsWith('backup prune refused'))).toBe(true)
  expect((await readPrunedPaths()).has(link)).toBe(false)
  await rm(outside, { recursive: true, force: true })
})

test('R3 a record that UNDER-states the size cannot fool the cap: the real (stat) size decides', async () => {
  const backups = join(AGENTISTICS_DATA_DIR, 'backups'); await mkdir(backups, { recursive: true })
  const ps = [1, 2, 3].map(n => join(backups, `r${n}.tar.zst`))
  for (const [i, p] of ps.entries()) { await sparse(p, 2 * GiB); await recordBackup(mk(`2026-02-0${i + 1}T00:00:00Z`, p, 1)) } // records say 1 byte
  await pruneOldBackups(7, () => {}, 3 * GiB)
  // 2 GiB each, cap 3 GiB → only the newest fits
  expect(ps.map(p => existsSync(p))).toEqual([false, false, true])
})

test('R3 a record that OVER-states the size prunes nothing that really fits; a missing file falls back to the record', async () => {
  const backups = join(AGENTISTICS_DATA_DIR, 'backups'); await mkdir(backups, { recursive: true })
  const ps = [1, 2, 3].map(n => join(backups, `o${n}.tar.zst`))
  for (const [i, p] of ps.entries()) { await writeFile(p, 'tiny'); await recordBackup(mk(`2026-03-0${i + 1}T00:00:00Z`, p, 2 * GiB)) } // records say 2 GiB
  await pruneOldBackups(7, () => {}, 3 * GiB)
  expect(ps.map(p => existsSync(p))).toEqual([true, true, true])
  const sized = await withRealSizes([{ path: ps[0]!, present: true, archiveBytes: 99 }, { path: join(backups, 'gone'), present: true, archiveBytes: 77 }, { path: ps[1]!, present: false, archiveBytes: 55 }])
  expect(sized.map(e => e.archiveBytes)).toEqual([4, 77, 55])
})

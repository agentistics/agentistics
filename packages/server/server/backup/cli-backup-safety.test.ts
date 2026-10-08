import { afterEach, expect, test } from 'bun:test'
import { existsSync, symlinkSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AGENTISTICS_DATA_DIR } from '../config'
import { pruneOldBackups } from '../cli-backup'
import { recordBackup, readPrunedPaths, type BackupRecord } from './backup-store'

const makeRecord = (at: string, path: string): BackupRecord => ({
  at, path, layers: ['metrics'], harnesses: ['claude'], bytesUncompressed: 1,
  archiveBytes: 1, sha256: 'x'.repeat(64), durationMs: 1,
})

afterEach(async () => { await rm(AGENTISTICS_DATA_DIR, { recursive: true, force: true }) })

test('prune deletes only a real file strictly inside the backups directory', async () => {
  const backups = join(AGENTISTICS_DATA_DIR, 'backups')
  const outside = await mkdtemp('/tmp/agentistics-backup-safety-')
  await mkdir(backups, { recursive: true })
  const normal = join(backups, 'normal.tar.zst')
  const absolute = join(outside, 'absolute.tar.zst')
  const traversal = join(backups, '..', 'traversal.tar.zst')
  const symlink = join(backups, 'symlink.tar.zst')
  await Promise.all([normal, absolute, traversal].map(p => writeFile(p, 'keep')))
  symlinkSync(absolute, symlink)
  await Promise.all([
    recordBackup(makeRecord('2026-01-01T00:00:00Z', normal)),
    recordBackup(makeRecord('2026-01-02T00:00:00Z', absolute)),
    recordBackup(makeRecord('2026-01-03T00:00:00Z', traversal)),
    recordBackup(makeRecord('2026-01-04T00:00:00Z', symlink)),
    recordBackup(makeRecord('2026-01-05T00:00:00Z', join(backups, 'newest.tar.zst'))),
  ])
  await writeFile(join(backups, 'newest.tar.zst'), 'new')

  const logs: string[] = []
  await pruneOldBackups(1, line => logs.push(line))

  expect(existsSync(normal)).toBe(false)
  expect(existsSync(absolute)).toBe(true)
  expect(existsSync(traversal)).toBe(true)
  expect(existsSync(symlink)).toBe(true)
  expect(logs.filter(line => line.startsWith('backup prune refused'))).toHaveLength(3)
  expect((await readPrunedPaths()).has(normal)).toBe(true)
  expect((await readPrunedPaths()).has(absolute)).toBe(false)
})

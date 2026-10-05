import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SNAPSHOT_FORMAT, decodeSnapshot, encodeSnapshot, readSnapshotFile, snapshotPath, writeSnapshotFile } from './data-snapshot'

const data = { statsCache: { dailyActivity: [] }, sessions: [{ session_id: 'a' }], projects: [], homeDir: '/h' }
const header = { v: SNAPSHOT_FORMAT, appVersion: '2.104.0', homeDir: '/h', builtAt: '2026-10-04T00:00:00.000Z' }
const expectHere = { appVersion: '2.104.0', homeDir: '/h' }

describe('data snapshot', () => {
  test('round-trips the already-serialized build without re-stringifying it', () => {
    const text = encodeSnapshot(header, JSON.stringify(data))
    const v = decodeSnapshot<typeof data>(text, expectHere)
    expect(v).toEqual({ ok: true, data, builtAt: header.builtAt })
  })

  test('another version, another home or another format is DROPPED, never adapted', () => {
    const text = encodeSnapshot(header, JSON.stringify(data))
    expect(decodeSnapshot(text, { ...expectHere, appVersion: '2.103.1' })).toEqual({ ok: false, reason: 'version' })
    expect(decodeSnapshot(text, { ...expectHere, homeDir: '/other' })).toEqual({ ok: false, reason: 'home' })
    expect(decodeSnapshot(encodeSnapshot({ ...header, v: 99 }, JSON.stringify(data)), expectHere)).toEqual({ ok: false, reason: 'format' })
  })

  test('a truncated file or a payload missing what the app reads is refused', () => {
    const text = encodeSnapshot(header, JSON.stringify(data))
    expect(decodeSnapshot(text.slice(0, -10), expectHere)).toEqual({ ok: false, reason: 'unreadable' })
    expect(decodeSnapshot(encodeSnapshot(header, JSON.stringify({ sessions: [] })), expectHere)).toEqual({ ok: false, reason: 'shape' })
  })

  test('written atomically with owner-only permissions; a missing file reads as null', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'snap-'))
    try {
      const path = snapshotPath(dir)
      expect(await readSnapshotFile(path)).toBeNull()
      await writeSnapshotFile(path, encodeSnapshot(header, JSON.stringify(data)))
      expect(statSync(path).mode & 0o777).toBe(0o600)
      expect(decodeSnapshot(await readSnapshotFile(path) ?? '', expectHere).ok).toBe(true)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

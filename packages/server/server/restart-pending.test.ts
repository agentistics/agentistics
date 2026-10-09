import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compareDisk, diskMayDiffer, parseBinaryVersion, withRestartPending } from './restart-pending'
import { cleanExecPath, readDiskVersion, resetDiskVersionMemo } from './restart-pending-io'
import { upgradeArgs, upgradableHint } from './upgrade-web'
import { shouldShowToast } from '../../web/src/lib/updateToast'

describe('disk binary against the running process', () => {
  test('newer / same / older / unreadable', () => {
    expect(compareDisk('2.112.1', '2.112.2')).toBe('newer')
    expect(compareDisk('2.112.2', '2.112.2')).toBe('same')
    expect(compareDisk('2.112.2', '2.112.1')).toBe('older')
    expect(compareDisk('2.112.2', null)).toBe('unknown')
    expect(compareDisk('2.112.2', 'garbage')).toBe('unknown')
  })
  test('parses the --version banner, nothing else', () => {
    expect(parseBinaryVersion('agentop v2.112.2\nengine none\n')).toBe('2.112.2')
    expect(parseBinaryVersion('boom')).toBeNull()
  })
  test('the probe is only paid when the file may differ', () => {
    expect(diskMayDiffer({ exeReplaced: true, diskMtimeMs: null, processStartMs: 1000 })).toBe(true)
    expect(diskMayDiffer({ exeReplaced: false, diskMtimeMs: 5000, processStartMs: 1000 })).toBe(true)
    expect(diskMayDiffer({ exeReplaced: false, diskMtimeMs: 500, processStartMs: 1000 })).toBe(false)
  })
})

describe('/api/version in the restart-pending case', () => {
  const info = { current: '2.112.1', latest: '2.112.2', hasUpdate: true }
  test('flags restartNeeded and keeps the update installable', () => {
    const r = withRestartPending({ ...info, latest: '2.112.1', hasUpdate: false }, '2.112.2')
    expect(r).toMatchObject({ restartNeeded: true, hasUpdate: true, latest: '2.112.2', diskVersion: '2.112.2' })
  })
  test('same / older / unreadable disk changes nothing', () => {
    for (const d of ['2.112.1', '2.100.0', null]) {
      expect(withRestartPending(info, d).restartNeeded).toBe(false)
    }
  })
  test('the toast is offered (upgradable never a refusal for it)', () => {
    const v = withRestartPending({ ...info, latest: '2.112.1', hasUpdate: false }, '2.112.2')
    expect(shouldShowToast({ info: { ...v, upgradable: null }, snooze: null, now: 0, central: false })).toEqual({ show: true })
    expect(upgradableHint).toBeDefined()
  })
})

describe('the route restarts instead of downloading', () => {
  test('restart-only runs `restart server`, otherwise `upgrade`', () => {
    expect(upgradeArgs(true)).toEqual(['restart', 'server'])
    expect(upgradeArgs(false)).toEqual(['upgrade'])
  })
})

describe('reading the disk binary', () => {
  test('a binary newer than the process reports its own version, memoized', () => {
    resetDiskVersionMemo()
    const dir = mkdtempSync(join(tmpdir(), 'rp-'))
    const bin = join(dir, 'agentop')
    writeFileSync(bin, '#!/bin/sh\necho "agentop v9.9.9"\n'); chmodSync(bin, 0o755)
    utimesSync(bin, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000))
    let runs = 0
    const run = (b: string) => { runs++; return `agentop v9.9.9\n` }
    expect(readDiskVersion(bin, run)).toBe('9.9.9')
    expect(readDiskVersion(`${bin} (deleted)`, run)).toBe('9.9.9')
    expect(runs).toBe(1)
    expect(cleanExecPath(`${bin} (deleted)`)).toBe(bin)
  })
  test('a missing binary is unknown', () => {
    expect(readDiskVersion('/nonexistent/agentop', () => '')).toBeNull()
  })
})

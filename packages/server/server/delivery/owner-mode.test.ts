/**
 * ENTREGA.GARANTIDA S0d.1 (QA F1, CRITICAL) — `required` must not drop to `legacy` by editing, dropping or garbling
 * `preferences.json` (§1.1: the adversary edits `~/.agentistics/*.json`). The vault is faked by a MAC function with a
 * fixed throwaway key that can be "locked" (returns null); the record and the preferences are real files in this test
 * process's own data dir.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  OWNER_MODE_FILE, __resetOwnerModeForTests, ownerModeMessage, readOwnerModeState, readOwnerProofMode, resolveOwnerMode,
  writeOwnerProofMode, type ModeRecordView, type OwnerModeIo,
} from './owner-mode'
import { PREFERENCES_FILE } from '../preferences'
import { analyzeOwnerModeTamper } from './owner-health'
import type { HealthIssue } from '@agentistics/core'

let dir = ''
let open = true
let T = 1_800_000_000_000
const KEY = Buffer.alloc(32, 7) // a throwaway test key, not a credential
const io = (): OwnerModeIo => ({
  vaultDir: () => dir,
  async readFile(p) { try { return new Uint8Array(readFileSync(p)) } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e } },
  async writeFile(p, b) { writeFileSync(p, b) },
  mac: (m, kid) => (open && (kid === undefined || kid === 'kid-1') ? { kid: 'kid-1', mac: createHmac('sha256', KEY).update(m).digest('base64url') } : null),
  now: () => T,
})
const recordPath = () => join(dir, OWNER_MODE_FILE)
const prefs = () => JSON.parse(readFileSync(PREFERENCES_FILE, 'utf8')) as Record<string, unknown>
const writePrefs = (text: string) => { mkdirSync(join(PREFERENCES_FILE, '..'), { recursive: true }); writeFileSync(PREFERENCES_FILE, text); T += 10 }
/** A fresh process: same files, empty memory. */
const restart = () => __resetOwnerModeForTests(io())

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'owner-mode-')); open = true; T += 1_000_000
  rmSync(PREFERENCES_FILE, { force: true })
  __resetOwnerModeForTests(io())
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }); rmSync(PREFERENCES_FILE, { force: true }); __resetOwnerModeForTests(null) })

describe('resolveOwnerMode — every branch that cannot PROVE legacy answers required', () => {
  const rec = (mode: 'legacy' | 'required', mac: 'ok' | 'bad' | 'unknown', atMs = 100): ModeRecordView => ({ state: 'present', mode, atMs, mac })
  test.each([
    ['never chosen, no preference', { state: 'absent' }, undefined, null, 'legacy', undefined],
    ['never chosen, preference says required', { state: 'absent' }, 'required', null, 'required', undefined],
    ['never chosen, preference garbage', { state: 'absent' }, 42, null, 'legacy', undefined],
    ['record unreadable', { state: 'unreadable' }, 'legacy', null, 'required', 'unreadable'],
    ['record required, prefs edited to legacy', rec('required', 'unknown'), 'legacy', null, 'required', 'disagree'],
    ['record required, prefs dropped', rec('required', 'ok'), undefined, null, 'required', undefined],
    ['record legacy with a verified MAC', rec('legacy', 'ok'), undefined, null, 'legacy', undefined],
    ['record legacy, forged MAC', rec('legacy', 'bad'), 'legacy', null, 'required', 'forged'],
    ['record legacy, vault locked, fresh process', rec('legacy', 'unknown'), 'legacy', null, 'required', undefined],
    ['record legacy, vault locked, this process verified it', rec('legacy', 'unknown'), 'legacy', { mode: 'legacy', atMs: 100 }, 'legacy', undefined],
    ['record deleted under a running process', { state: 'absent' }, 'legacy', { mode: 'required', atMs: 100 }, 'required', 'vanished'],
    ['an older (valid) legacy record replayed', rec('legacy', 'ok', 50), undefined, { mode: 'required', atMs: 100 }, 'required', 'replayed'],
  ] as const)('%s', (_n, record, prefsValue, latch, mode, tampered) => {
    const r = resolveOwnerMode({ record: record as ModeRecordView, prefs: prefsValue, latch: latch as never })
    expect(r.mode).toBe(mode)
    expect(r.tampered).toBe(tampered as never)
  })
})

describe('the QA F1 attacks, against the real files (attack-mode-file.ts edit | drop | garbage)', () => {
  test('a machine that never chose required behaves exactly as before (legacy)', async () => {
    expect(await readOwnerProofMode()).toBe('legacy')
    writePrefs('{ not json')
    expect(await readOwnerProofMode()).toBe('legacy')
  })
  for (const attack of ['edit', 'drop', 'garbage'] as const) {
    test(`required survives "${attack}" of preferences.json — in the running process AND after a restart`, async () => {
      await writeOwnerProofMode('required')
      expect(prefs().delivery).toEqual({ ownerProof: 'required' }) // the display mirror is still written
      const j = prefs()
      if (attack === 'edit') writePrefs(JSON.stringify({ ...j, delivery: { ownerProof: 'legacy' } }))
      if (attack === 'drop') { delete j.delivery; writePrefs(JSON.stringify(j)) }
      if (attack === 'garbage') writePrefs('{ not json')
      expect(await readOwnerProofMode()).toBe('required')
      restart()
      expect(await readOwnerProofMode()).toBe('required')
    })
  }
  test('deleting the record under the running server: still required, WARN vanished', async () => {
    await writeOwnerProofMode('required')
    unlinkSync(recordPath()); writePrefs('{}')
    expect(await readOwnerModeState()).toEqual({ mode: 'required', tampered: 'vanished' })
  })
  test('a hand-written legacy record (no seal, or a wrong one) is forged → required', async () => {
    await writeOwnerProofMode('required')
    writeFileSync(recordPath(), JSON.stringify({ v: 1, kid: 'kid-1', mode: 'legacy', atMs: T + 5 }))
    restart()
    expect(await readOwnerModeState()).toEqual({ mode: 'required', tampered: 'forged' })
    writeFileSync(recordPath(), JSON.stringify({ v: 1, kid: 'kid-1', mode: 'legacy', atMs: T + 5, mac: 'A'.repeat(43) }))
    expect(await readOwnerModeState()).toEqual({ mode: 'required', tampered: 'forged' })
  })
  test('garbage in the record is unreadable → required', async () => {
    await writeOwnerProofMode('required')
    writeFileSync(recordPath(), '{ nope')
    expect(await readOwnerModeState()).toEqual({ mode: 'required', tampered: 'unreadable' })
  })
  test('putting back an older valid legacy record is a replay', async () => {
    await writeOwnerProofMode('legacy')
    const old = readFileSync(recordPath())
    T += 1000
    await writeOwnerProofMode('required')
    writeFileSync(recordPath(), old)
    expect(await readOwnerModeState()).toEqual({ mode: 'required', tampered: 'replayed' })
  })
  test('the owner going back to legacy (vault open) is legacy; with the vault locked a fresh process reads required', async () => {
    await writeOwnerProofMode('required')
    T += 1000
    await writeOwnerProofMode('legacy')
    expect(await readOwnerProofMode()).toBe('legacy')
    open = false
    expect(await readOwnerProofMode()).toBe('legacy') // this process wrote/verified it
    restart()
    expect(await readOwnerProofMode()).toBe('required') // cannot be verified: fail closed
    open = true
    expect(await readOwnerProofMode()).toBe('legacy')
  })
  test('legacy cannot be recorded without the vault open (it would read required anyway)', async () => {
    open = false
    await expect(writeOwnerProofMode('legacy')).rejects.toThrow(/vault must be open/)
    expect(existsSync(recordPath())).toBe(false)
  })
  test('health names the tamper', () => {
    const issues: HealthIssue[] = []
    analyzeOwnerModeTamper('forged', issues)
    analyzeOwnerModeTamper(undefined, issues)
    expect(issues.map(i => i.id)).toEqual(['delivery-owner-mode-tampered'])
    expect(issues[0]!.description).toMatch(/seal/)
  })
  test('the message the MAC covers binds the kid, the mode and the time', () => {
    expect(ownerModeMessage('k', 'legacy', 1)).not.toBe(ownerModeMessage('k', 'required', 1))
    expect(ownerModeMessage('k', 'legacy', 1)).not.toBe(ownerModeMessage('j', 'legacy', 1))
  })
})

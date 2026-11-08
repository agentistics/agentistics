import { test, expect } from 'bun:test'
import { TEAM_CONN_DIR, safeConnId, teamSentFile, teamSyncFile, teamRulesFile, teamForgetFile } from './config'
import { journalLiveEnabled } from './journal/live-flag'

test('live journal feeds every install by default, with explicit off and journal master gate', () => {
  for (const raw of [undefined, '', '1', 'true', 'yes', 'on']) expect(journalLiveEnabled(true, raw)).toBe(true)
  for (const raw of ['0', 'false', ' OFF ', 'no']) expect(journalLiveEnabled(true, raw)).toBe(false)
  expect(journalLiveEnabled(false, '1')).toBe(false)
})

test('safeConnId accepts the exact id format', () => {
  expect(safeConnId('c_0123456789ab')).toBe('c_0123456789ab')
})

test('safeConnId rejects anything that could escape the directory', () => {
  for (const bad of ['../etc/passwd', 'c_../aaaaaaaa', 'c_0123456789AB', 'c_short', '', 'c_0123456789abc', 'nope']) {
    expect(() => safeConnId(bad)).toThrow()
  }
})

test('the four path builders live under TEAM_CONN_DIR and are distinct', () => {
  const id = 'c_0123456789ab'
  const paths = [teamSentFile(id), teamSyncFile(id), teamRulesFile(id), teamForgetFile(id)]
  for (const p of paths) expect(p.startsWith(TEAM_CONN_DIR)).toBe(true)
  expect(new Set(paths).size).toBe(4)
  expect(teamSentFile(id).endsWith('team-sent-c_0123456789ab.json')).toBe(true)
  expect(teamForgetFile(id).endsWith('team-forget-c_0123456789ab.json')).toBe(true)
})

test('the path builders reject a malicious id', () => {
  expect(() => teamSentFile('../../escape')).toThrow()
})

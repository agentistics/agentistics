import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isPlanId, opencodeDbPath, readGoCostRows, resolvePlan } from './opencode-usage'
import { mkdirSync, writeFileSync } from 'node:fs'

describe('opencodeDbPath', () => {
  test('macOS: the Application Support database is used only when the default one is absent', () => {
    const home = mkdtempSync(join(tmpdir(), 'oc-home-'))
    try {
      const alt = join(home, 'Library', 'Application Support', 'opencode')
      mkdirSync(alt, { recursive: true })
      writeFileSync(join(alt, 'opencode.db'), '')
      expect(opencodeDbPath({}, home, 'darwin')).toBe(join(alt, 'opencode.db'))
      expect(opencodeDbPath({}, home, 'linux')).toBe(join(home, '.local', 'share', 'opencode', 'opencode.db'))
      mkdirSync(join(home, '.local', 'share', 'opencode'), { recursive: true })
      writeFileSync(join(home, '.local', 'share', 'opencode', 'opencode.db'), '')
      expect(opencodeDbPath({}, home, 'darwin')).toBe(join(home, '.local', 'share', 'opencode', 'opencode.db'))
    } finally { rmSync(home, { recursive: true, force: true }) }
  })
})

describe('resolvePlan', () => {
  test('the person\'s choice wins; otherwise the credential decides', () => {
    expect(resolvePlan('go-plus', ['opencode-go'])).toEqual({ plan: 'go-plus', chosen: true })
    expect(resolvePlan(undefined, ['opencode-go', 'opencode'])).toEqual({ plan: 'go', chosen: false })
    expect(resolvePlan(undefined, ['opencode'])).toEqual({ plan: 'zen', chosen: false })
    expect(resolvePlan(undefined, [])).toEqual({ plan: 'none', chosen: false })
    expect(resolvePlan('nonsense', ['opencode-go'])).toEqual({ plan: 'go', chosen: false })
  })
  test('isPlanId is a closed set', () => {
    expect(isPlanId('go-teams')).toBe(true)
    expect(isPlanId('enterprise')).toBe(false)
  })
})

describe('readGoCostRows (an OpenCode-shaped fixture, built here)', () => {
  const NOW = Date.UTC(2026, 10, 7, 12)
  function fixture(): { dir: string; path: string } {
    const dir = mkdtempSync(join(tmpdir(), 'oc-usage-'))
    const path = join(dir, 'opencode.db')
    const db = new Database(path)
    db.run('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)')
    const add = (id: string, at: number, data: unknown) => db.run('INSERT INTO message VALUES (?,?,?,?,?)', [id, 's', at, at, JSON.stringify(data)])
    const msg = (provider: string, model: string, cost: number, at: number) => ({ role: 'assistant', providerID: provider, modelID: model, cost, tokens: { input: 1 }, time: { created: at } })
    add('a', NOW - 3_600_000, msg('opencode-go', 'glm-5.3-flash', 0.0045261, NOW - 3_600_000))
    add('b', NOW - 3_600_000, msg('opencode', 'big-pickle', 0, NOW - 3_600_000))           // Zen: not the Go allowance
    add('c', NOW - 40 * 86_400_000, msg('opencode-go', 'glm-5.3', 5, NOW - 40 * 86_400_000)) // older than a month
    add('d', NOW - 1000, { role: 'user', providerID: 'opencode-go', modelID: 'x', cost: 9 })  // not an assistant message
    add('e', NOW - 1000, 'not json')
    db.close()
    return { dir, path }
  }

  test('only recent assistant messages of the opencode-go provider, with their stamped cost', () => {
    const { dir, path } = fixture()
    try {
      expect(readGoCostRows(path, NOW)).toEqual([{ model: 'glm-5.3-flash', costUsd: 0.0045261, at: NOW - 3_600_000 }])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  test('a missing store is empty and an unreadable one is null', () => {
    expect(readGoCostRows('/nonexistent/opencode.db', NOW)).toEqual([])
    const dir = mkdtempSync(join(tmpdir(), 'oc-usage-'))
    try {
      const path = join(dir, 'opencode.db')
      new Database(path).close() // a database with no `message` table
      expect(readGoCostRows(path, NOW)).toBeNull()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

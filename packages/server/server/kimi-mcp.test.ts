import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { planKimiMcp, ensureKimiMcp, kimiMcpPath, writeKimiMcp } from './kimi-mcp'

const want = { command: '/usr/bin/agentop', args: ['mcp'] }
const API = 'http://localhost:47291'

describe('planKimiMcp (pure)', () => {
  test('no file: writes the entry under mcpServers with the API address', () => {
    const p = planKimiMcp(null, want, API)
    expect(p.action).toBe('write')
    if (p.action === 'write') expect(JSON.parse(p.text)).toEqual({ mcpServers: { agentistics: { command: '/usr/bin/agentop', args: ['mcp'], env: { AGENTISTICS_API: API } } } })
  })
  test('preserves every key it did not author, including other servers and the entry\'s own extra fields', () => {
    const existing = JSON.stringify({ theme: 'x', mcpServers: { other: { url: 'https://o' }, agentistics: { command: 'bun', args: ['run', '/old.ts'], enabled: true, env: { KEEP: '1' } } } })
    const p = planKimiMcp(existing, want, API)
    if (p.action !== 'write') throw new Error('write')
    expect(JSON.parse(p.text)).toEqual({ theme: 'x', mcpServers: { other: { url: 'https://o' }, agentistics: { command: '/usr/bin/agentop', args: ['mcp'], enabled: true, env: { KEEP: '1', AGENTISTICS_API: API } } } })
  })
  test('up to date: nothing to do — running it twice changes nothing', () => {
    const first = planKimiMcp(null, want, API)
    if (first.action !== 'write') throw new Error('write')
    expect(planKimiMcp(first.text, want, API)).toEqual({ action: 'noop' })
  })
  test('another port is an update, not a no-op', () => {
    const first = planKimiMcp(null, want, API)
    if (first.action !== 'write') throw new Error('write')
    expect(planKimiMcp(first.text, want, 'http://localhost:1').action).toBe('write')
  })
  test('a document it cannot merge into is REFUSED, never repaired', () => {
    for (const bad of ['{ nope', '[]', '{"mcpServers": []}']) expect(planKimiMcp(bad, want, API).action).toBe('refuse')
  })
  test('an empty file is a fresh start', () => { expect(planKimiMcp('  \n', want, API).action).toBe('write') })
})

describe('writeKimiMcp / ensureKimiMcp (IO, in a throwaway directory)', () => {
  test('a machine without kimi is untouched; with kimi it writes once (0600), keeps other keys, and is idempotent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kimi-mcp-test-'))
    expect(await writeKimiMcp(join(root, 'absent', 'mcp.json'), 47291)).toBe('no-kimi')
    expect(existsSync(join(root, 'absent'))).toBe(false)
    const file = join(root, 'mcp.json')
    writeFileSync(file, JSON.stringify({ mcpServers: { other: { command: 'x' } }, keep: 1 }))
    expect(await writeKimiMcp(file, 47291)).toBe('written')
    const doc = JSON.parse(readFileSync(file, 'utf8'))
    expect(doc.keep).toBe(1)
    expect(doc.mcpServers.other).toEqual({ command: 'x' })
    expect(doc.mcpServers.agentistics.env.AGENTISTICS_API).toBe('http://localhost:47291')
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(await writeKimiMcp(file, 47291)).toBe('unchanged')
    writeFileSync(file, '{ broken')
    expect(await writeKimiMcp(file, 47291)).toBe('refused')
    expect(readFileSync(file, 'utf8')).toBe('{ broken')
  })
  test('the server-wide gate refuses a non-canonical server (throwaway ports/dirs never touch the user\'s kimi)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kimi-mcp-gate-'))
    const prev = process.env.KIMI_CODE_HOME
    try {
      process.env.KIMI_CODE_HOME = root
      expect(kimiMcpPath()).toBe(join(root, 'mcp.json'))
      await ensureKimiMcp(47291)
      expect(existsSync(join(root, 'mcp.json'))).toBe(false)
    } finally { if (prev === undefined) delete process.env.KIMI_CODE_HOME; else process.env.KIMI_CODE_HOME = prev }
  })
})

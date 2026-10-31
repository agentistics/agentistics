import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { planOpencodeMcp, planOpencodeMcpRemoval, writeOpencodeMcp, removeOpencodeMcp, ensureOpencodeMcp, opencodeMcpPath } from './opencode-mcp'

const want = { command: '/usr/bin/agentop', args: ['mcp'] }
const API = 'http://localhost:47291'
const entry = { type: 'local', command: ['/usr/bin/agentop', 'mcp'], environment: { AGENTISTICS_API: API } }

describe('planOpencodeMcp (pure) — the shape `opencode mcp add` writes on 1.17.9', () => {
  test('no file: schema + mcp entry with a command ARRAY and `environment`', () => {
    const p = planOpencodeMcp(null, want, API)
    if (p.action !== 'write') throw new Error('write')
    expect(JSON.parse(p.text)).toEqual({ $schema: 'https://opencode.ai/config.json', mcp: { agentistics: entry } })
  })
  test('preserves other servers, other keys and the entry\'s extra fields', () => {
    const existing = JSON.stringify({ theme: 'x', mcp: { other: { type: 'remote', url: 'https://o' }, agentistics: { ...entry, command: ['bun', '/old.ts'], enabled: false, environment: { KEEP: '1' } } } })
    const p = planOpencodeMcp(existing, want, API)
    if (p.action !== 'write') throw new Error('write')
    expect(JSON.parse(p.text)).toEqual({ theme: 'x', mcp: { other: { type: 'remote', url: 'https://o' }, agentistics: { ...entry, enabled: false, environment: { KEEP: '1', AGENTISTICS_API: API } } } })
  })
  test('idempotent; another port is an update', () => {
    const first = planOpencodeMcp(null, want, API)
    if (first.action !== 'write') throw new Error('write')
    expect(planOpencodeMcp(first.text, want, API)).toEqual({ action: 'noop' })
    expect(planOpencodeMcp(first.text, want, 'http://localhost:1').action).toBe('write')
  })
  test('a config it cannot merge into (comments, non-object, bad mcp) is REFUSED', () => {
    for (const bad of ['{ // c\n}', '[]', '{"mcp": []}']) expect(planOpencodeMcp(bad, want, API).action).toBe('refuse')
  })
})

describe('planOpencodeMcpRemoval (pure)', () => {
  test('removes only our entry, drops an emptied mcp key, keeps the rest', () => {
    const both = JSON.stringify({ a: 1, mcp: { agentistics: entry, other: { type: 'local', command: ['x'] } } })
    const p1 = planOpencodeMcpRemoval(both)
    if (p1.action !== 'write') throw new Error('write')
    expect(JSON.parse(p1.text)).toEqual({ a: 1, mcp: { other: { type: 'local', command: ['x'] } } })
    const only = planOpencodeMcpRemoval(JSON.stringify({ a: 1, mcp: { agentistics: entry } }))
    if (only.action !== 'write') throw new Error('write')
    expect(JSON.parse(only.text)).toEqual({ a: 1 })
  })
  test('nothing of ours: noop; unparseable: refuse', () => {
    expect(planOpencodeMcpRemoval(null)).toEqual({ action: 'noop' })
    expect(planOpencodeMcpRemoval('{"a":1}')).toEqual({ action: 'noop' })
    expect(planOpencodeMcpRemoval('{ // c\n}').action).toBe('refuse')
  })
})

describe('IO in a throwaway directory', () => {
  test('absent dir untouched; writes once (0600); idempotent; removable; broken file refused', async () => {
    const root = mkdtempSync(join(tmpdir(), 'opencode-mcp-test-'))
    expect(await writeOpencodeMcp(join(root, 'absent', 'opencode.json'), 47291)).toBe('no-opencode')
    expect(existsSync(join(root, 'absent'))).toBe(false)
    const file = join(root, 'opencode.json')
    writeFileSync(file, JSON.stringify({ keep: 1, mcp: { other: { type: 'local', command: ['x'] } } }))
    expect(await writeOpencodeMcp(file, 47291)).toBe('written')
    const doc = JSON.parse(readFileSync(file, 'utf8'))
    expect(doc.keep).toBe(1)
    expect(doc.mcp.agentistics.environment.AGENTISTICS_API).toBe(API)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(await writeOpencodeMcp(file, 47291)).toBe('unchanged')
    expect(await removeOpencodeMcp(file)).toBe('written')
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ keep: 1, mcp: { other: { type: 'local', command: ['x'] } } })
    expect(await removeOpencodeMcp(file)).toBe('unchanged')
    writeFileSync(file, '{ broken')
    expect(await writeOpencodeMcp(file, 47291)).toBe('refused')
    expect(readFileSync(file, 'utf8')).toBe('{ broken')
  })
  test('path follows XDG_CONFIG_HOME and prefers an existing .json, then .jsonc; the gate refuses non-canonical servers', async () => {
    const root = mkdtempSync(join(tmpdir(), 'opencode-mcp-gate-'))
    const prev = process.env.XDG_CONFIG_HOME
    try {
      process.env.XDG_CONFIG_HOME = root
      expect(opencodeMcpPath()).toBe(join(root, 'opencode', 'opencode.json'))
      require('node:fs').mkdirSync(join(root, 'opencode'))
      writeFileSync(join(root, 'opencode', 'opencode.jsonc'), '{}')
      expect(opencodeMcpPath()).toBe(join(root, 'opencode', 'opencode.jsonc'))
      writeFileSync(join(root, 'opencode', 'opencode.json'), '{}')
      expect(opencodeMcpPath()).toBe(join(root, 'opencode', 'opencode.json'))
      await ensureOpencodeMcp(47291)
      expect(readFileSync(join(root, 'opencode', 'opencode.json'), 'utf8')).toBe('{}')
    } finally { if (prev === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prev }
  })
})

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mcpTargetPath, mcpTargets, MCP_HARNESSES } from './mcp-targets'
import { AGY_MCP_CONFIG } from './agy-mcp'
import { kimiMcpPath } from './kimi-mcp'
import { HOME_DIR } from './config'

describe('mcpTargets (I13)', () => {
  test('lists one file per harness for the given HOME and the real account roots', () => {
    const t = mcpTargets('/h', { accountRoots: [{ harness: 'codex', root: '/acc/codex' }, { harness: 'kimi', root: '/acc/k' }] })
    for (const h of MCP_HARNESSES) expect(t.some(x => x.harness === h)).toBe(true)
    expect(t.find(x => x.path === '/acc/codex/config.toml')).toBeTruthy()
    expect(t.some(x => x.path.startsWith('/acc/k'))).toBe(false)
    expect(t.some(x => x.path.endsWith('opencode.jsonc'))).toBe(true)
  })
  test('every ensure* writer derives its path from mcpTargetPath (paritiy with what boot rewrites)', () => {
    expect(AGY_MCP_CONFIG).toBe(mcpTargetPath('antigravity', HOME_DIR))
    expect(kimiMcpPath()).toBe(mcpTargetPath('kimi', HOME_DIR, { KIMI_CODE_HOME: process.env.KIMI_CODE_HOME, KIMI_DIR: process.env.KIMI_DIR ?? join(HOME_DIR, '.kimi-code') }))
    const drivers: Array<[string, string]> = [['chat-drivers/codex.ts', 'codex'], ['chat-drivers/gemini.ts', 'gemini'], ['chat-drivers/copilot.ts', 'copilot']]
    for (const [file, h] of drivers) expect(readFileSync(join(import.meta.dir, file), 'utf8')).toContain(`mcpTargetPath('${h}', HOME_DIR)`)
  })
  test('XDG_CONFIG_HOME moves only opencode', () => {
    expect(mcpTargetPath('opencode', '/h', { XDG_CONFIG_HOME: '/x' })).toBe('/x/opencode/opencode.json')
    expect(mcpTargetPath('codex', '/h', { XDG_CONFIG_HOME: '/x' })).toBe('/h/.codex/config.toml')
  })
})

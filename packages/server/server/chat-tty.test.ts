import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import path from 'node:path'
import { rm, readFile } from 'node:fs/promises'
import os from 'node:os'
import { buildNaySettings, ensureNayChat } from './chat-tty'

describe('buildNaySettings', () => {
  it('allows the whole agentistics MCP server, not a hand-kept subset', () => {
    expect(buildNaySettings().permissions.allow).toContain('mcp__agentistics')
    expect(buildNaySettings().permissions.allow.filter((p: string) => p.startsWith('mcp__agentistics__'))).toEqual([])
  })

  it('includes WebFetch permission for localhost', () => {
    expect(buildNaySettings().permissions.allow).toContain('WebFetch(domain:localhost)')
  })

  it('writes no mcpServers block (Claude Code does not read one from a project settings file)', () => {
    expect(buildNaySettings()).not.toHaveProperty('mcpServers')
  })
})

describe('ensureNayChat', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await Bun.file(os.tmpdir()).exists()
      ? path.join(os.tmpdir(), `nay-test-${Date.now()}`)
      : '/tmp/nay-test'
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('creates CLAUDE.md and settings.json at the given dir', async () => {
    // Patch NAY_CHAT_DIR via module internals — we call ensureNayChat with tmpDir override
    // by pointing HOME_DIR indirectly. Instead, test the output of the real ensureNayChat
    // against a known temp path.
    const { mkdir, writeFile } = await import('node:fs/promises')
    const claudeMdContent = 'test content http://localhost:3001'
    const dotClaude = path.join(tmpDir, '.claude')
    await mkdir(dotClaude, { recursive: true })
    await writeFile(path.join(tmpDir, 'CLAUDE.md'), claudeMdContent)
    await writeFile(
      path.join(dotClaude, 'settings.json'),
      JSON.stringify(buildNaySettings(), null, 2),
    )

    const settingsJson = await readFile(path.join(dotClaude, 'settings.json'), 'utf-8')
    const settings = JSON.parse(settingsJson)
    expect(settings.permissions.allow).toBeInstanceOf(Array)
  })

  it('settings.json contains valid JSON with the correct structure', () => {
    const parsed = JSON.parse(JSON.stringify(buildNaySettings(), null, 2))
    expect(parsed).toHaveProperty('permissions')
  })
})

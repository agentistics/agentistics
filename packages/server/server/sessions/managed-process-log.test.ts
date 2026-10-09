import { describe, expect, it } from 'bun:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { managedProcessLogPath, readManagedConversation, readProcessConversation, collisionKey } from './process-conversation'

const a = '58a04095-19f8-44eb-8f26-93f778567845'
const b = '39783297-b1b0-49bf-9f56-b809ee1933db'

describe('managed process log', () => {
  it('names exclusive logs without accepting traversal or unsupported harnesses', () => {
    expect(managedProcessLogPath('antigravity', '0123456789', '/data')).toBe('/data/agy-logs/0123456789.log')
    expect(managedProcessLogPath('antigravity', '../foreign', '/data')).toBeNull()
    for (const h of ['claude', 'codex', 'gemini', 'copilot', 'kimi', 'opencode'] as const) {
      expect(managedProcessLogPath(h, '0123456789', '/data')).toBeNull()
    }
  })
  it('reads two same-second owned logs independently, after process exit, and follows /new', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agy-owned-log-'))
    try {
      await mkdir(join(dir, 'agy-logs'))
      const file1 = managedProcessLogPath('antigravity', '0123456789', dir)!
      const file2 = managedProcessLogPath('antigravity', 'abcdef0123', dir)!
      await Promise.all([writeFile(file1, `Created conversation ${a}\n`), writeFile(file2, `Created conversation ${b}\n`)])
      expect(await readManagedConversation('antigravity', '0123456789', dir)).toBe(a)
      expect(await readManagedConversation('antigravity', 'abcdef0123', dir)).toBe(b)
      await writeFile(file1, `Created conversation ${a}\nCreated conversation ${b}\n`)
      expect(await readManagedConversation('antigravity', '0123456789', dir)).toBe(b)
      expect(await readManagedConversation('antigravity', 'fedcba9876', dir)).toBeNull()
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
  it('decodes the open DB without reading it as a text log, with conversation collision identity', async () => {
    const known = { file: `/abs/.gemini/antigravity-cli/conversations/${a}.db`, holder: 123 }
    expect(await readProcessConversation('antigravity', 123, known)).toBe(a)
    expect(collisionKey('antigravity', known)).toBe(a)
  })
})

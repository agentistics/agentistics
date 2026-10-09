import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The real watcher, in a child process with a throwaway HOME (never the developer's own data): the
 * harness directory does not exist when the watcher starts, is created afterwards, and a write inside
 * it must then be seen. The child prints what it logs; the parent asserts on the lines.
 */
describe('setupFileWatcher — a harness directory created after boot', () => {
  it('is watched once it appears, with no restart', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agentop-late-'))
    const script = join(home, 'child.ts')
    writeFileSync(script, `
      import { mkdirSync, writeFileSync } from 'node:fs'
      import { join } from 'node:path'
      const { setupFileWatcher } = await import(${JSON.stringify(join(import.meta.dir, 'sse.ts'))})
      mkdirSync(process.env.HOME + '/.claude/projects', { recursive: true })
      mkdirSync(process.env.HOME + '/.claude/usage-data/session-meta', { recursive: true })
      await setupFileWatcher({ lateIntervalMs: 100 })
      console.log('BOOT_DONE')
      await new Promise(r => setTimeout(r, 300))
      mkdirSync(join(process.env.HOME!, '.gemini', 'tmp', 'proj', 'chats'), { recursive: true })
      await new Promise(r => setTimeout(r, 600))
      writeFileSync(join(process.env.HOME!, '.gemini', 'tmp', 'proj', 'chats', 'x.jsonl'), '{}\\n')
      await new Promise(r => setTimeout(r, 400))
      process.exit(0)
    `)
    try {
      const proc = Bun.spawn([process.execPath, script], {
        env: { PATH: process.env.PATH ?? '', HOME: home, USERPROFILE: home },
        stdout: 'pipe', stderr: 'pipe',
      })
      const out = await new Response(proc.stdout).text()
      await proc.exited
      const lines = out.split('\n')
      const boot = lines.indexOf('BOOT_DONE')
      expect(boot).toBeGreaterThan(-1)
      const geminiDir = join(home, '.gemini', 'tmp')
      // At boot it was reported missing, not silently dropped…
      expect(lines.slice(0, boot).some(l => l.includes('Skipping') && l.includes(geminiDir))).toBe(true)
      // …and picked up after it appeared.
      expect(lines.slice(boot).some(l => l.includes('gemini') && l.includes('appeared after boot'))).toBe(true)
      expect(lines.slice(boot).some(l => l.includes('Watching') && l.includes(geminiDir))).toBe(true)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 20_000)
})

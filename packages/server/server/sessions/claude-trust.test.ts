import { describe, expect, test } from 'bun:test'
import { chmod, link, mkdtemp, open, readdir, readFile, readlink, rename, rm, stat, symlink, unlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { __setClaudeTrustFsForTest, __withConfigLockForTest, ensureClaudeProjectTrusted } from './claude-trust'

describe('ensureClaudeProjectTrusted', () => {
  test('writes the trust entry for a managed account root and cwd', async () => {
    const root = await mkdtemp('/tmp/agentop-claude-trust-')
    const cwd = join(root, 'worktree')

    try {
      await ensureClaudeProjectTrusted(root, cwd)

      const config = JSON.parse(await readFile(join(root, '.claude.json'), 'utf8'))
      expect(config.projects[cwd].hasTrustDialogAccepted).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('preserves existing account data and file mode', async () => {
    const root = await mkdtemp('/tmp/agentop-claude-trust-')
    const cwd = join(root, 'worktree')
    const original = { oauthAccount: { email: 'account@example.invalid', organizationUuid: 'org-1' }, projects: {} }
    try {
      await writeFile(join(root, '.claude.json'), `${JSON.stringify(original)}\n`, { mode: 0o640 })
      await chmod(join(root, '.claude.json'), 0o640)
      await ensureClaudeProjectTrusted(root, cwd)

      const config = JSON.parse(await readFile(join(root, '.claude.json'), 'utf8'))
      expect(config.oauthAccount).toEqual(original.oauthAccount)
      expect(config.projects[cwd].hasTrustDialogAccepted).toBe(true)
      expect((await stat(join(root, '.claude.json'))).mode & 0o777).toBe(0o640)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('leaves a corrupt config untouched and does not fail the spawn preparation', async () => {
    const root = await mkdtemp('/tmp/agentop-claude-trust-')
    const file = join(root, '.claude.json')
    const corrupt = '{"oauthAccount":'
    try {
      await writeFile(file, corrupt)
      await expect(ensureClaudeProjectTrusted(root, join(root, 'worktree'))).resolves.toBeUndefined()
      expect(await readFile(file, 'utf8')).toBe(corrupt)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('serializes concurrent roots and keeps every trust entry', async () => {
    const root = await mkdtemp('/tmp/agentop-claude-trust-')
    try {
      await Promise.all(Array.from({ length: 20 }, (_, i) => ensureClaudeProjectTrusted(root, join(root, `worktree-${i}`))))
      const config = JSON.parse(await readFile(join(root, '.claude.json'), 'utf8'))
      expect(Object.keys(config.projects)).toHaveLength(20)
      expect(Object.values(config.projects).every(project => (
        typeof project === 'object' && project !== null
        && (project as { hasTrustDialogAccepted?: boolean }).hasTrustDialogAccepted === true
      ))).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('writes through a symlink without replacing it', async () => {
    const root = await mkdtemp('/tmp/agentop-claude-trust-')
    const target = join(root, 'real.json')
    const link = join(root, '.claude.json')
    const cwd = join(root, 'worktree')
    try {
      await writeFile(target, '{}\n')
      await symlink(target, link)
      await ensureClaudeProjectTrusted(root, cwd)
      expect(await readlink(link)).toBe(target)
      const config = JSON.parse(await readFile(target, 'utf8'))
      expect(config.projects[cwd].hasTrustDialogAccepted).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('does not remove another process lock after a non-contention open error', async () => {
    const root = await mkdtemp('/tmp/agentop-claude-trust-')
    const file = join(root, '.claude.json')
    const lock = `${file}.lock`
    try {
      await writeFile(lock, 'held')
      __setClaudeTrustFsForTest({
        open: async (...args) => {
          if (args[0] === lock) throw Object.assign(new Error('too many open files'), { code: 'EMFILE' })
          return open(...args)
        },
      })
      const unlinks: string[] = []
      __setClaudeTrustFsForTest({
        open: async (...args) => {
          if (args[0] === lock) throw Object.assign(new Error('too many open files'), { code: 'EMFILE' })
          return open(...args)
        },
        unlink: async path => { unlinks.push(String(path)); return unlink(path) },
      })
      await expect(ensureClaudeProjectTrusted(root, join(root, 'worktree'))).resolves.toBeUndefined()
      expect(unlinks).toEqual([])
      expect(await readFile(lock, 'utf8')).toBe('held')
    } finally {
      __setClaudeTrustFsForTest(null)
      await rm(root, { recursive: true, force: true })
    }
  })

  test('reclaims stale locks by renaming them before retrying', async () => {
    const root = await mkdtemp('/tmp/agentop-claude-trust-')
    const file = join(root, '.claude.json')
    const lock = `${file}.lock`
    try {
      await writeFile(lock, 'stale')
      const old = new Date(Date.now() - 60_000)
      await utimes(lock, old, old)
      const renames: string[] = []
      __setClaudeTrustFsForTest({
        rename: async (from, to) => { renames.push(String(to)); return rename(from, to) },
      })
      await ensureClaudeProjectTrusted(root, join(root, 'worktree'))
      expect(renames).toHaveLength(1)
      expect(renames[0]).toEndWith('.stale')
      expect((await readdir(root)).filter(name => name.endsWith('.stale'))).toEqual([])
      expect(await readFile(join(root, '.claude.json'), 'utf8')).toContain('hasTrustDialogAccepted')
      await expect(stat(lock)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      __setClaudeTrustFsForTest(null)
      await rm(root, { recursive: true, force: true })
    }
  })

  async function staleLock(lock: string, content = 'stale'): Promise<void> {
    await writeFile(lock, content)
    const old = new Date(Date.now() - 60_000)
    await utimes(lock, old, old)
  }
  const leftovers = async (root: string) => (await readdir(root)).filter(name => name.endsWith('.stale'))

  test('a second reclaimer that moves a live lock away puts it back and never overlaps the holder', async () => {
    const root = await mkdtemp('/tmp/agentop-claude-trust-')
    const file = join(root, '.claude.json')
    const lock = `${file}.lock`
    let aHolds = false
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await staleLock(lock)
      let raced = false
      __setClaudeTrustFsForTest({
        // Interleaving: after B judged the lock stale and before its rename, A reclaims it and takes a LIVE lock.
        rename: async (from, to) => {
          if (!raced && from === lock) {
            raced = true
            await rename(lock, `${lock}.a-reclaimed`)
            await unlink(`${lock}.a-reclaimed`)
            await writeFile(lock, 'a-live', { flag: 'wx' })
            aHolds = true
            timer = setTimeout(() => { aHolds = false; void unlink(lock).catch(() => {}) }, 60)
          }
          return rename(from, to)
        },
      })
      let overlapped: boolean | undefined
      await __withConfigLockForTest(file, async () => { overlapped = aHolds })
      expect(raced).toBe(true)
      expect(overlapped).toBe(false)
      expect(await leftovers(root)).toEqual([])
    } finally {
      clearTimeout(timer)
      __setClaudeTrustFsForTest(null)
      await rm(root, { recursive: true, force: true })
    }
  })

  test('a long operation whose lock was reclaimed does not delete the new holder lock', async () => {
    const root = await mkdtemp('/tmp/agentop-claude-trust-')
    const file = join(root, '.claude.json')
    const lock = `${file}.lock`
    try {
      await __withConfigLockForTest(file, async () => {
        // Another process judged us stale, reclaimed and now holds the lock.
        await unlink(lock)
        await writeFile(lock, 'other-holder', { flag: 'wx' })
      })
      expect(await readFile(lock, 'utf8')).toBe('other-holder')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('restoring a displaced lock that fails with EEXIST leaves no .stale file', async () => {
    const root = await mkdtemp('/tmp/agentop-claude-trust-')
    const file = join(root, '.claude.json')
    const lock = `${file}.lock`
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await staleLock(lock)
      let raced = false
      __setClaudeTrustFsForTest({
        rename: async (from, to) => {
          if (!raced && from === lock) {
            raced = true
            await unlink(lock)
            await writeFile(lock, 'a-live', { flag: 'wx' })
            timer = setTimeout(() => { void unlink(lock).catch(() => {}) }, 50)
          }
          await rename(from, to)
          // A third process re-creates the name before B can link back: link will see EEXIST.
          await writeFile(lock, 'c-live', { flag: 'wx' })
        },
      })
      await __withConfigLockForTest(file, async () => {})
      expect(await leftovers(root)).toEqual([])
    } finally {
      clearTimeout(timer)
      __setClaudeTrustFsForTest(null)
      await rm(root, { recursive: true, force: true })
    }
  })

  test('restoring a displaced lock that fails with ENOENT leaves no .stale file', async () => {
    const root = await mkdtemp('/tmp/agentop-claude-trust-')
    const file = join(root, '.claude.json')
    const lock = `${file}.lock`
    try {
      await staleLock(lock)
      let raced = false
      __setClaudeTrustFsForTest({
        rename: async (from, to) => {
          if (!raced && from === lock) {
            raced = true
            await unlink(lock)
            await writeFile(lock, 'a-live', { flag: 'wx' })
          }
          return rename(from, to)
        },
        link: async () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }) },
      })
      await __withConfigLockForTest(file, async () => {})
      expect(await leftovers(root)).toEqual([])
    } finally {
      __setClaudeTrustFsForTest(null)
      await rm(root, { recursive: true, force: true })
    }
  })

  test('a link that is unsupported (EPERM) does not fail the lock and leaves no .stale file', async () => {
    const root = await mkdtemp('/tmp/agentop-claude-trust-')
    const file = join(root, '.claude.json')
    const lock = `${file}.lock`
    const warn = console.warn
    const warnings: string[] = []
    console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')) }
    try {
      await staleLock(lock)
      let raced = false
      __setClaudeTrustFsForTest({
        rename: async (from, to) => {
          if (!raced && from === lock) {
            raced = true
            await unlink(lock)
            await writeFile(lock, 'a-live', { flag: 'wx' })
          }
          return rename(from, to)
        },
        link: async () => { throw Object.assign(new Error('not permitted'), { code: 'EPERM' }) },
      })
      let ran = false
      await __withConfigLockForTest(file, async () => { ran = true })
      expect(ran).toBe(true)
      expect(await leftovers(root)).toEqual([])
      expect(warnings.some(line => line.includes('could not restore'))).toBe(true)
    } finally {
      console.warn = warn
      __setClaudeTrustFsForTest(null)
      await rm(root, { recursive: true, force: true })
    }
  })

  test('a displaced lock is really linked back when the name is free', async () => {
    const root = await mkdtemp('/tmp/agentop-claude-trust-')
    const file = join(root, '.claude.json')
    const lock = `${file}.lock`
    let restoredContent: string | undefined
    try {
      await staleLock(lock)
      let raced = false
      __setClaudeTrustFsForTest({
        rename: async (from, to) => {
          if (!raced && from === lock) {
            raced = true
            await unlink(lock)
            await writeFile(lock, 'a-live', { flag: 'wx' })
          }
          return rename(from, to)
        },
        link: async (from, to) => {
          await link(from, to)
          restoredContent = await readFile(to, 'utf8')
          // A releases right after being restored so B can proceed.
          setTimeout(() => { void unlink(lock).catch(() => {}) }, 30)
        },
      })
      await __withConfigLockForTest(file, async () => {})
      expect(restoredContent).toBe('a-live')
      expect(await leftovers(root)).toEqual([])
    } finally {
      __setClaudeTrustFsForTest(null)
      await rm(root, { recursive: true, force: true })
    }
  })

  test('a lock file we created but could not write is removed, not left to block others', async () => {
    const root = await mkdtemp('/tmp/agentop-claude-trust-')
    const file = join(root, '.claude.json')
    const lock = `${file}.lock`
    try {
      __setClaudeTrustFsForTest({
        open: async (...args) => {
          const handle = await open(...args)
          if (args[0] === lock) {
            handle.write = (async () => { throw Object.assign(new Error('no space'), { code: 'ENOSPC' }) }) as typeof handle.write
          }
          return handle
        },
      })
      await expect(__withConfigLockForTest(file, async () => 'ran')).rejects.toMatchObject({ code: 'ENOSPC' })
      await expect(stat(lock)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      __setClaudeTrustFsForTest(null)
      await rm(root, { recursive: true, force: true })
    }
  })
})

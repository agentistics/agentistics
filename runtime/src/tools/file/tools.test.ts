/**
 * tools/file/tools.test.ts — the file tools driven end to end through `runTool` (`../gate.ts`),
 * the only door a real caller ever goes through. Every test runs in a FRESH `mkdtemp` workspace and
 * touches nothing under `~/.agentistics` — no network, no real home dir.
 */
import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { GateDeps, GateScope } from '../gate.ts'
import { runTool } from '../gate.ts'
import { memoryContent, recordingEvents, scriptedPolicy } from '../testing.ts'
import { createFileTools, type FileTools } from './index.ts'
import type { FilePatchToolResult } from './patch.ts'

async function withWorkspace(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'agentistics-file-tools-'))
  try {
    await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function scopeOf(root: string): GateScope {
  return { workspaceRoot: root, cwd: root, signal: new AbortController().signal }
}

function depsOf(answer: Parameters<typeof scriptedPolicy>[0]): GateDeps & { policy: ReturnType<typeof scriptedPolicy> } {
  const policy = scriptedPolicy(answer)
  return { policy, events: recordingEvents(), content: memoryContent() }
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path)
    return true
  } catch {
    return false
  }
}

const patchText = (body: string) => `*** Begin Patch\n${body}\n*** End Patch`

describe('file.read', () => {
  test('denied: nothing is read, model gets the refusal', async () => {
    await withWorkspace(async (root) => {
      await writeFile(join(root, 'a.txt'), 'hello\n')
      const tools = createFileTools()
      const deps = depsOf('deny')
      const r = await runTool(tools.read, { path: 'a.txt' }, scopeOf(root), deps)
      expect(r.status).toBe('denied')
      expect(r.outcome.modelText).toBe('Refused by the test policy.')
    })
  })

  test('allowed: reads and line-numbers the whole small file', async () => {
    await withWorkspace(async (root) => {
      await writeFile(join(root, 'a.txt'), 'one\ntwo\nthree\n')
      const tools = createFileTools()
      const r = await runTool(tools.read, { path: 'a.txt' }, scopeOf(root), depsOf('allow'))
      expect(r.status).toBe('completed')
      expect(r.outcome.modelText).toContain('Showing the whole file.')
      expect(r.outcome.modelText).toContain('     1\tone')
      expect(r.outcome.modelText).toContain('     2\ttwo')
      expect(r.outcome.modelText).toContain('     3\tthree')
    })
  })

  test('records the FULL file in the ledger even when offset/limit narrows what is shown', async () => {
    await withWorkspace(async (root) => {
      const content = Array.from({ length: 50 }, (_, i) => `line${i + 1}`).join('\n') + '\n'
      await writeFile(join(root, 'big.txt'), content)
      const tools = createFileTools()
      await runTool(tools.read, { path: 'big.txt', offset: 10, limit: 5 }, scopeOf(root), depsOf('allow'))
      const resolved = resolve(root, 'big.txt')
      const entry = tools.ledger.get(resolved)
      expect(entry).toBeDefined()
      expect(entry!.size).toBe(Buffer.byteLength(content))
    })
  })

  test('truncation states what was cut and the file totals', async () => {
    await withWorkspace(async (root) => {
      const lines = Array.from({ length: 30 }, (_, i) => `line${i + 1}`)
      await writeFile(join(root, 'a.txt'), lines.join('\n') + '\n')
      const tools = createFileTools()
      const r = await runTool(tools.read, { path: 'a.txt', limit: 10 }, scopeOf(root), depsOf('allow'))
      expect(r.outcome.modelText).toContain('30 line(s)')
      expect(r.outcome.modelText).toContain('Showing lines 1-10')
      expect(r.outcome.modelText).toContain('20 more line(s) not shown')
      expect(r.outcome.modelText).toContain('(line cap reached)')
    })
  })

  test('an image is returned by reference, never its bytes', async () => {
    await withWorkspace(async (root) => {
      const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03])
      await writeFile(join(root, 'pic.png'), bytes)
      const tools = createFileTools()
      const r = await runTool(tools.read, { path: 'pic.png' }, scopeOf(root), depsOf('allow'))
      expect(r.status).toBe('completed')
      expect(r.outcome.modelText).toContain('binary file (image/png')
      expect(r.outcome.modelText).not.toContain('\x89')
      expect(r.outcome.result).toMatchObject({ kind: 'binary', mime: 'image/png', bytes: bytes.length })
    })
  })

  test('a PDF is returned by reference', async () => {
    await withWorkspace(async (root) => {
      await writeFile(join(root, 'doc.pdf'), Buffer.from('%PDF-1.4\n...'))
      const tools = createFileTools()
      const r = await runTool(tools.read, { path: 'doc.pdf' }, scopeOf(root), depsOf('allow'))
      expect(r.outcome.result).toMatchObject({ kind: 'binary', mime: 'application/pdf' })
    })
  })

  test('a symlink inside the workspace pointing outside yields the OUTSIDE path as the subject', async () => {
    await withWorkspace(async (root) => {
      const outsideDir = await mkdtemp(join(tmpdir(), 'agentistics-outside-'))
      try {
        const outsideFile = join(outsideDir, 'secret.txt')
        await writeFile(outsideFile, 'shh\n')
        await symlink(outsideFile, join(root, 'link.txt'))
        const tools = createFileTools()
        const deps = depsOf('allow')
        await runTool(tools.read, { path: 'link.txt' }, scopeOf(root), deps)
        expect(deps.policy.seen).toHaveLength(1)
        expect(deps.policy.seen[0]!.subjects).toEqual([{ action: 'read', path: outsideFile }])
      } finally {
        await rm(outsideDir, { recursive: true, force: true })
      }
    })
  })

  test('not-found', async () => {
    await withWorkspace(async (root) => {
      const tools = createFileTools()
      const r = await runTool(tools.read, { path: 'nope.txt' }, scopeOf(root), depsOf('allow'))
      expect(r.outcome.error?.class).toBe('not-found')
    })
  })
})

describe('file.write', () => {
  test('denied: the file is not created', async () => {
    await withWorkspace(async (root) => {
      const tools = createFileTools()
      const r = await runTool(tools.write, { path: 'a.txt', content: 'x' }, scopeOf(root), depsOf('deny'))
      expect(r.status).toBe('denied')
      expect(await exists(join(root, 'a.txt'))).toBe(false)
    })
  })

  test('allowed: creates a new file, no prior read required', async () => {
    await withWorkspace(async (root) => {
      const tools = createFileTools()
      const r = await runTool(tools.write, { path: 'a.txt', content: 'hello\n' }, scopeOf(root), depsOf('allow'))
      expect(r.status).toBe('completed')
      expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('hello\n')
    })
  })

  test('creates parent directories', async () => {
    await withWorkspace(async (root) => {
      const tools = createFileTools()
      const r = await runTool(tools.write, { path: 'a/b/c.txt', content: 'x' }, scopeOf(root), depsOf('allow'))
      expect(r.status).toBe('completed')
      expect(await readFile(join(root, 'a/b/c.txt'), 'utf8')).toBe('x')
    })
  })

  test('overwriting without a prior read is refused stale', async () => {
    await withWorkspace(async (root) => {
      await writeFile(join(root, 'a.txt'), 'old\n')
      const tools = createFileTools()
      const r = await runTool(tools.write, { path: 'a.txt', content: 'new\n' }, scopeOf(root), depsOf('allow'))
      expect(r.outcome.error?.class).toBe('stale')
      expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('old\n')
    })
  })

  test('overwriting after a read, unchanged since, succeeds', async () => {
    await withWorkspace(async (root) => {
      await writeFile(join(root, 'a.txt'), 'old\n')
      const tools = createFileTools()
      await runTool(tools.read, { path: 'a.txt' }, scopeOf(root), depsOf('allow'))
      const r = await runTool(tools.write, { path: 'a.txt', content: 'new\n' }, scopeOf(root), depsOf('allow'))
      expect(r.status).toBe('completed')
      expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('new\n')
    })
  })

  test('overwriting after a read, changed on disk since, is refused stale', async () => {
    await withWorkspace(async (root) => {
      const path = join(root, 'a.txt')
      await writeFile(path, 'old\n')
      const tools = createFileTools()
      await runTool(tools.read, { path: 'a.txt' }, scopeOf(root), depsOf('allow'))
      await writeFile(path, 'edited by someone else\n')
      const r = await runTool(tools.write, { path: 'a.txt', content: 'new\n' }, scopeOf(root), depsOf('allow'))
      expect(r.outcome.error?.class).toBe('stale')
      expect(await readFile(path, 'utf8')).toBe('edited by someone else\n')
    })
  })
})

describe('file.patch — add', () => {
  test('denied: file is not created', async () => {
    await withWorkspace(async (root) => {
      const tools = createFileTools()
      const r = await runTool(tools.patch, { patch: patchText('*** Add File: a.txt\n+hi') }, scopeOf(root), depsOf('deny'))
      expect(r.status).toBe('denied')
      expect(await exists(join(root, 'a.txt'))).toBe(false)
    })
  })

  test('allowed: creates the file with the given content', async () => {
    await withWorkspace(async (root) => {
      const tools = createFileTools()
      const r = await runTool(
        tools.patch,
        { patch: patchText('*** Add File: a.txt\n+line1\n+line2') },
        scopeOf(root),
        depsOf('allow')
      )
      expect(r.status).toBe('completed')
      expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('line1\nline2')
      const result = r.outcome.result as FilePatchToolResult
      expect(result.files[0]).toMatchObject({ applied: true, linesAdded: 2, linesRemoved: 0 })
    })
  })

  test('refuses to add over an existing file', async () => {
    await withWorkspace(async (root) => {
      await writeFile(join(root, 'a.txt'), 'already here\n')
      const tools = createFileTools()
      const r = await runTool(tools.patch, { patch: patchText('*** Add File: a.txt\n+x') }, scopeOf(root), depsOf('allow'))
      expect(r.outcome.error?.class).toBe('invalid-input')
    })
  })
})

describe('file.patch — delete', () => {
  test('allowed: removes the file', async () => {
    await withWorkspace(async (root) => {
      await writeFile(join(root, 'a.txt'), 'bye\n')
      const tools = createFileTools()
      await runTool(tools.read, { path: 'a.txt' }, scopeOf(root), depsOf('allow'))
      const r = await runTool(tools.patch, { patch: patchText('*** Delete File: a.txt') }, scopeOf(root), depsOf('allow'))
      expect(r.status).toBe('completed')
      expect(await exists(join(root, 'a.txt'))).toBe(false)
    })
  })

  test('deleting without a prior read is refused stale, file untouched', async () => {
    await withWorkspace(async (root) => {
      await writeFile(join(root, 'a.txt'), 'bye\n')
      const tools = createFileTools()
      const r = await runTool(tools.patch, { patch: patchText('*** Delete File: a.txt') }, scopeOf(root), depsOf('allow'))
      expect(r.outcome.error?.class).toBe('stale')
      expect(await exists(join(root, 'a.txt'))).toBe(true)
    })
  })

  test('deleting a missing file is not-found', async () => {
    await withWorkspace(async (root) => {
      const tools = createFileTools()
      const r = await runTool(tools.patch, { patch: patchText('*** Delete File: nope.txt') }, scopeOf(root), depsOf('allow'))
      expect(r.outcome.error?.class).toBe('not-found')
    })
  })
})

describe('file.patch — update, tiers', () => {
  const hunk = (before: string, after: string) =>
    ['*** Update File: a.txt', '@@', ` ${before}`, `-${before}mid`, `+${after}mid`, ` end`].join('\n')

  test('exact tier matches', async () => {
    await withWorkspace(async (root) => {
      await writeFile(join(root, 'a.txt'), 'top\nmid\nend\n')
      const tools = createFileTools()
      await runTool(tools.read, { path: 'a.txt' }, scopeOf(root), depsOf('allow'))
      const patch = patchText(['*** Update File: a.txt', '@@', ' top', '-mid', '+MID', ' end'].join('\n'))
      const r = await runTool(tools.patch, { patch }, scopeOf(root), depsOf('allow'))
      expect(r.status).toBe('completed')
      expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('top\nMID\nend\n')
      const result = r.outcome.result as FilePatchToolResult
      expect(result.matchedTier).toBe('exact')
    })
  })

  test('trailing-ws tier matches when only trailing whitespace differs', async () => {
    await withWorkspace(async (root) => {
      await writeFile(join(root, 'a.txt'), 'top  \nmid\t\nend\n')
      const tools = createFileTools()
      await runTool(tools.read, { path: 'a.txt' }, scopeOf(root), depsOf('allow'))
      const patch = patchText(['*** Update File: a.txt', '@@', ' top', '-mid', '+MID', ' end'].join('\n'))
      const r = await runTool(tools.patch, { patch }, scopeOf(root), depsOf('allow'))
      expect(r.status).toBe('completed')
      const result = r.outcome.result as FilePatchToolResult
      expect(result.matchedTier).toBe('trailing-ws')
      // The ORIGINAL trailing whitespace on the untouched "top" context line is preserved.
      expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('top  \nMID\nend\n')
    })
  })

  test('surrounding-ws tier matches when leading whitespace also differs', async () => {
    await withWorkspace(async (root) => {
      await writeFile(join(root, 'a.txt'), '  top\n  mid\nend\n')
      const tools = createFileTools()
      await runTool(tools.read, { path: 'a.txt' }, scopeOf(root), depsOf('allow'))
      const patch = patchText(['*** Update File: a.txt', '@@', ' top', '-mid', '+MID', ' end'].join('\n'))
      const r = await runTool(tools.patch, { patch }, scopeOf(root), depsOf('allow'))
      expect(r.status).toBe('completed')
      const result = r.outcome.result as FilePatchToolResult
      expect(result.matchedTier).toBe('surrounding-ws')
      // The ORIGINAL leading whitespace on the untouched "top" context line is preserved.
      expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('  top\nMID\nend\n')
    })
  })

  test('no-match names that all three tiers failed', async () => {
    await withWorkspace(async (root) => {
      await writeFile(join(root, 'a.txt'), 'totally\ndifferent\ncontent\n')
      const tools = createFileTools()
      await runTool(tools.read, { path: 'a.txt' }, scopeOf(root), depsOf('allow'))
      const patch = patchText(['*** Update File: a.txt', '@@', ' top', '-mid', '+MID', ' end'].join('\n'))
      const r = await runTool(tools.patch, { patch }, scopeOf(root), depsOf('allow'))
      expect(r.outcome.error?.class).toBe('no-match')
      expect(r.outcome.error?.detail).toMatch(/exact, trailing-ws, surrounding-ws/)
      expect(r.outcome.error?.detail).toContain('hunk 1')
      // nothing written
      expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('totally\ndifferent\ncontent\n')
    })
  })

  test('ambiguous when the context matches in more than one place', async () => {
    await withWorkspace(async (root) => {
      await writeFile(join(root, 'a.txt'), 'x\nmid\ny\nmid\nz\n')
      const tools = createFileTools()
      await runTool(tools.read, { path: 'a.txt' }, scopeOf(root), depsOf('allow'))
      const patch = patchText(['*** Update File: a.txt', '@@', '-mid', '+MID'].join('\n'))
      const r = await runTool(tools.patch, { patch }, scopeOf(root), depsOf('allow'))
      expect(r.outcome.error?.class).toBe('ambiguous')
      expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('x\nmid\ny\nmid\nz\n')
    })
  })

  test('patching without a prior read is refused', async () => {
    await withWorkspace(async (root) => {
      await writeFile(join(root, 'a.txt'), 'top\nmid\nend\n')
      const tools = createFileTools()
      const patch = patchText(['*** Update File: a.txt', '@@', ' top', '-mid', '+MID', ' end'].join('\n'))
      const r = await runTool(tools.patch, { patch }, scopeOf(root), depsOf('allow'))
      expect(r.outcome.error?.class).toBe('stale')
      expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('top\nmid\nend\n')
    })
  })

  test('stale: patching after the file changed on disk since the read is refused', async () => {
    await withWorkspace(async (root) => {
      const path = join(root, 'a.txt')
      await writeFile(path, 'top\nmid\nend\n')
      const tools = createFileTools()
      await runTool(tools.read, { path: 'a.txt' }, scopeOf(root), depsOf('allow'))
      await writeFile(path, 'top\nCHANGED\nend\n')
      const patch = patchText(['*** Update File: a.txt', '@@', ' top', '-mid', '+MID', ' end'].join('\n'))
      const r = await runTool(tools.patch, { patch }, scopeOf(root), depsOf('allow'))
      expect(r.outcome.error?.class).toBe('stale')
      expect(await readFile(path, 'utf8')).toBe('top\nCHANGED\nend\n')
    })
  })

  test('a second read clears staleness (re-reading the changed file authorises a new patch)', async () => {
    await withWorkspace(async (root) => {
      const path = join(root, 'a.txt')
      await writeFile(path, 'top\nmid\nend\n')
      const tools = createFileTools()
      await runTool(tools.read, { path: 'a.txt' }, scopeOf(root), depsOf('allow'))
      await writeFile(path, 'top\nCHANGED\nend\n')
      await runTool(tools.read, { path: 'a.txt' }, scopeOf(root), depsOf('allow'))
      const patch = patchText(['*** Update File: a.txt', '@@', ' top', '-CHANGED', '+FIXED', ' end'].join('\n'))
      const r = await runTool(tools.patch, { patch }, scopeOf(root), depsOf('allow'))
      expect(r.status).toBe('completed')
      expect(await readFile(path, 'utf8')).toBe('top\nFIXED\nend\n')
    })
  })
})

describe('file.patch — rename', () => {
  test('renames the file and applies the content change', async () => {
    await withWorkspace(async (root) => {
      await writeFile(join(root, 'old.txt'), 'top\nmid\nend\n')
      const tools = createFileTools()
      await runTool(tools.read, { path: 'old.txt' }, scopeOf(root), depsOf('allow'))
      const patch = patchText(
        ['*** Update File: old.txt', '*** Move to: new.txt', '@@', ' top', '-mid', '+MID', ' end'].join('\n')
      )
      const r = await runTool(tools.patch, { patch }, scopeOf(root), depsOf('allow'))
      expect(r.status).toBe('completed')
      expect(await exists(join(root, 'old.txt'))).toBe(false)
      expect(await readFile(join(root, 'new.txt'), 'utf8')).toBe('top\nMID\nend\n')
    })
  })

  test('a pure rename (no content change) just moves the file', async () => {
    await withWorkspace(async (root) => {
      await writeFile(join(root, 'old.txt'), 'unchanged\n')
      const tools = createFileTools()
      await runTool(tools.read, { path: 'old.txt' }, scopeOf(root), depsOf('allow'))
      const patch = patchText(['*** Update File: old.txt', '*** Move to: new.txt'].join('\n'))
      const r = await runTool(tools.patch, { patch }, scopeOf(root), depsOf('allow'))
      expect(r.status).toBe('completed')
      expect(await exists(join(root, 'old.txt'))).toBe(false)
      expect(await readFile(join(root, 'new.txt'), 'utf8')).toBe('unchanged\n')
    })
  })

  test('subjects state rename-from and rename-to on the resolved paths', async () => {
    await withWorkspace(async (root) => {
      await writeFile(join(root, 'old.txt'), 'top\nmid\nend\n')
      const tools = createFileTools()
      await runTool(tools.read, { path: 'old.txt' }, scopeOf(root), depsOf('allow'))
      const deps = depsOf('allow')
      const patch = patchText(
        ['*** Update File: old.txt', '*** Move to: new.txt', '@@', ' top', '-mid', '+MID', ' end'].join('\n')
      )
      await runTool(tools.patch, { patch }, scopeOf(root), deps)
      const subjects = deps.policy.seen[0]!.subjects
      expect(subjects).toContainEqual({ action: 'write', path: join(root, 'old.txt'), op: 'rename-from' })
      expect(subjects).toContainEqual({ action: 'write', path: join(root, 'new.txt'), op: 'rename-to' })
    })
  })
})

describe('file.patch — multi-file, all-or-nothing', () => {
  test('a second file that fails validation leaves the first file untouched', async () => {
    await withWorkspace(async (root) => {
      const tools = createFileTools()
      const patch = patchText(['*** Add File: ok.txt', '+created', '*** Delete File: missing.txt'].join('\n'))
      const r = await runTool(tools.patch, { patch }, scopeOf(root), depsOf('allow'))
      expect(r.outcome.error?.class).toBe('not-found')
      expect(await exists(join(root, 'ok.txt'))).toBe(false)
    })
  })

  test('when the SECOND file fails to WRITE, the first file (already written) is rolled back', async () => {
    await withWorkspace(async (root) => {
      // Force a write failure on the second file by making its target path a DIRECTORY —
      // writing a file over an existing directory of the same name fails deterministically (EISDIR).
      await mkdir(join(root, 'blocked.txt'))
      await writeFile(join(root, 'existing.txt'), 'v1\n')
      const tools = createFileTools()
      await runTool(tools.read, { path: 'existing.txt' }, scopeOf(root), depsOf('allow'))
      const patch = patchText(
        [
          '*** Update File: existing.txt',
          '@@',
          '-v1',
          '+v2',
          '*** Add File: blocked.txt',
          '+this can never land',
        ].join('\n')
      )
      const r = await runTool(tools.patch, { patch }, scopeOf(root), depsOf('allow'))
      expect(r.status).toBe('failed')
      // The first file's write DID succeed and then was rolled back — nothing half-applied.
      expect(await readFile(join(root, 'existing.txt'), 'utf8')).toBe('v1\n')
    })
  })
})

describe('checkpoint (wired through the file tools)', () => {
  test('restores a patch-driven edit', async () => {
    await withWorkspace(async (root) => {
      const path = join(root, 'a.txt')
      await writeFile(path, 'top\nmid\nend\n')
      const tools = createFileTools()
      await runTool(tools.read, { path: 'a.txt' }, scopeOf(root), depsOf('allow'))
      const gateScope: GateScope = { ...scopeOf(root), toolExecutionId: 'tx_fixed' }
      const patch = patchText(['*** Update File: a.txt', '@@', ' top', '-mid', '+MID', ' end'].join('\n'))
      await runTool(tools.patch, { patch }, gateScope, depsOf('allow'))
      expect(await readFile(path, 'utf8')).toBe('top\nMID\nend\n')

      const out = await tools.checkpoint.restore('tx_fixed', {
        read: async (p) => {
          try {
            return await readFile(p, 'utf8')
          } catch {
            return null
          }
        },
        write: async (p, c) => {
          await writeFile(p, c, 'utf8')
        },
        remove: async (p) => {
          await import('node:fs/promises').then((m) => m.unlink(p))
        },
      })
      expect(out.restored).toEqual([path])
      expect(await readFile(path, 'utf8')).toBe('top\nmid\nend\n')
    })
  })

  test('refuses to restore a file changed since the write, in words', async () => {
    await withWorkspace(async (root) => {
      const path = join(root, 'a.txt')
      await writeFile(path, 'old\n')
      const tools = createFileTools()
      await runTool(tools.read, { path: 'a.txt' }, scopeOf(root), depsOf('allow'))
      const gateScope: GateScope = { ...scopeOf(root), toolExecutionId: 'tx_fixed' }
      await runTool(tools.write, { path: 'a.txt', content: 'new\n' }, gateScope, depsOf('allow'))
      await writeFile(path, 'someone edited this after the tool ran\n')

      const disk = {
        read: async (p: string) => {
          try {
            return await readFile(p, 'utf8')
          } catch {
            return null
          }
        },
        write: async (p: string, c: string) => writeFile(p, c, 'utf8'),
        remove: async (p: string) => import('node:fs/promises').then((m) => m.unlink(p)),
      }
      const out = await tools.checkpoint.restore('tx_fixed', disk)
      expect(out.restored).toEqual([])
      expect(out.skipped).toEqual([{ path, reason: 'the file changed since the editor wrote it' }])
      expect(await readFile(path, 'utf8')).toBe('someone edited this after the tool ran\n')
    })
  })
})

describe('shared ledger and checkpoint across the three tools', () => {
  test('createFileTools() wires one ledger and one checkpoint used by all three tools', async () => {
    await withWorkspace(async (root) => {
      const tools: FileTools = createFileTools()
      const path = join(root, 'a.txt')
      await writeFile(path, 'v1\n')
      await runTool(tools.read, { path: 'a.txt' }, scopeOf(root), depsOf('allow'))
      // file.write's own staleness check must see the ledger entry file.read just made.
      const r = await runTool(tools.write, { path: 'a.txt', content: 'v2\n' }, scopeOf(root), depsOf('allow'))
      expect(r.status).toBe('completed')
    })
  })
})

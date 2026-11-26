import { expect, spyOn, test } from 'bun:test'
import { runClean } from '../cli-clean'
import * as io from './clean-io'
import type { WorktreeFacts } from './clean-plan'

test('CLI prints short pause reasons while applying, without repeating every poll', async () => {
  const reasons = ['waiting for cleanup lock', 'waiting for cleanup rate limit', 'machine is tight', 'waiting for heavy jobs']
  const messages: string[] = []
  const facts: WorktreeFacts = { repo: '/test-repo', path: '/test-repo/wt', branch: 'wip', isMain: false,
    missing: false, locked: false, dirty: false, merged: false, pushed: false, squashed: false, inUse: false,
    lastCommitMs: 1, lastActivityMs: 1, sizeBytes: 8192, nodeModulesBytes: 4096 }
  const mocks = [
    spyOn(io, 'repoOf').mockResolvedValue('/test-repo'),
    spyOn(io, 'worktreeFacts').mockResolvedValue([facts]),
    spyOn(io, 'applyClean').mockImplementation(async (_items, opts) => {
      for (const reason of reasons) { opts?.cleanup?.onPause?.(reason); opts?.cleanup?.onPause?.(reason) }
      return []
    }),
    spyOn(process.stderr, 'write').mockImplementation(((message: string) => { messages.push(String(message)); return true }) as never),
    spyOn(console, 'log').mockImplementation(() => {}),
  ]
  try {
    await runClean(['--repo', '/test-repo', '--yes'])
    for (const reason of reasons) expect(messages.filter(m => m.includes(reason))).toEqual([`[clean] ${reason}\n`])
  } finally { for (const mock of mocks) mock.mockRestore() }
})

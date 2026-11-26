import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyCleanSelection, processIn, protectedPaths } from './clean-web'
import * as cliClean from '../cli-clean'
import * as cleanIo from './clean-io'
import type { WorktreeFacts } from './clean-plan'
import * as fleetWeb from '../sessions/fleet-web'

const fixtures: string[] = []
afterEach(() => { for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true }) })

describe('clean process safety guard', () => {
  for (const problem of ['skipped, it is in use now', 'Error: paced unlink failed']) {
    test(`node_modules ${problem} is not counted as freed`, async () => {
      const fixture = mkdtempSync(join(tmpdir(), 'clean-web-result-')); fixtures.push(fixture)
      const facts: WorktreeFacts = { repo: fixture, path: join(fixture, 'worktree'), branch: 'wip', isMain: false,
        missing: false, locked: false, dirty: false, merged: false, pushed: false, squashed: false, inUse: false,
        lastCommitMs: 1, lastActivityMs: 1, sizeBytes: 8192, nodeModulesBytes: 4096 }
      const mocks = [
        spyOn(fleetWeb, 'readFleet').mockResolvedValue({ rows: [] } as never),
        spyOn(cliClean, 'cleanRepos').mockResolvedValue([fixture]),
        spyOn(cliClean, 'collectCleanFacts').mockResolvedValue([facts]),
        spyOn(cleanIo, 'applyClean').mockImplementation(async items => items.length ? [`${facts.path}: ${problem}`] : []),
      ]
      try {
        const job = await applyCleanSelection([`${fixture}:${facts.path}:node-modules`])
        for (let i = 0; i < 100 && job.state !== 'done'; i++) await Bun.sleep(10)
        expect(job.state).toBe('done')
        expect(job.result?.errors).toEqual([`${facts.path}: ${problem}`])
        expect(job.result?.removed).toEqual([])
        expect(job.result?.freedBytes).toBe(0)
        expect(job.result?.nodeModules).toBe(0)
      } finally { for (const mock of mocks) mock.mockRestore() }
    })
  }
  test('protects the cwd of an idle fleet session', async () => {
    const readFleet = spyOn(fleetWeb, 'readFleet').mockResolvedValue({ rows: [{ id: 'idle', state: 'idle', cwd: '/idle-hermes-cwd' }] } as never)
    try { expect((await protectedPaths()).get('/idle-hermes-cwd')).toBe('an active session') } finally { readFleet.mockRestore() }
  })
  test('skips a worktree while a child process has its cwd inside it', async () => {
    const fixture = mkdtempSync(join(tmpdir(), 'clean-process-'))
    fixtures.push(fixture)
    mkdirSync(join(fixture, 'worktree'))
    const child = Bun.spawn(['sleep', '5'], { cwd: join(fixture, 'worktree') })
    try {
      expect(await processIn(join(fixture, 'worktree'))).toBe(true)
    } finally {
      child.kill()
      await child.exited
    }
  })
})

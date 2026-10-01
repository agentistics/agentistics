import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readSpawnWindowConversation } from './process-conversation'

const CONV = '02eefe27-dee3-44e4-87bc-b23ae2aa933f'
const spawnedMs = new Date(2026, 9, 1, 15, 31, 59, 963).getTime()

const logText = (cwd: string, conv?: string) => [
  `I1001 15:32:00.428716       1 server.go:323] Creating CLI server backend: product=antigravity workspaceDirs=[${cwd}] appDataDir=/x cascadeManager=true`,
  ...(conv ? [`I1001 15:32:02.541591     250 server.go:1248] Created conversation ${conv}`] : []),
].join('\n')

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'agy-logs-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('readSpawnWindowConversation', () => {
  it('recovers the conversation from the log a finished process left behind', async () => {
    await writeFile(join(dir, 'cli-20261001_153200.log'), logText('/home/padawan/ads-next', CONV))
    expect(await readSpawnWindowConversation(
      { harness: 'antigravity', cwd: '/home/padawan/ads-next', spawnedMs }, dir,
    )).toBe(CONV)
  })

  it('ignores logs outside the spawn window without reading them, and crash logs by name', async () => {
    await writeFile(join(dir, 'cli-20261001_100000.log'), logText('/home/padawan/ads-next', CONV))
    await writeFile(join(dir, 'crash_157041_0a37ae18-ba7a-4e37-91fc-b96311b6bc9e.log'), logText('/home/padawan/ads-next', CONV))
    expect(await readSpawnWindowConversation(
      { harness: 'antigravity', cwd: '/home/padawan/ads-next', spawnedMs }, dir,
    )).toBeNull()
  })

  it('answers null for a harness with no process log, and for a directory that is not there', async () => {
    expect(await readSpawnWindowConversation({ harness: 'claude', cwd: '/x', spawnedMs }, dir)).toBeNull()
    expect(await readSpawnWindowConversation(
      { harness: 'antigravity', cwd: '/x', spawnedMs }, join(dir, 'does-not-exist'),
    )).toBeNull()
  })

  it('refuses a conversation another row already holds', async () => {
    await writeFile(join(dir, 'cli-20261001_153200.log'), logText('/home/padawan/ads-next', CONV))
    expect(await readSpawnWindowConversation(
      { harness: 'antigravity', cwd: '/home/padawan/ads-next', spawnedMs, taken: new Set([CONV]) }, dir,
    )).toBeNull()
  })
})

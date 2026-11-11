import { describe, expect, test } from 'bun:test'
import { join } from 'path'
import { tmpdir } from 'os'
import { mkdtemp } from 'fs/promises'

/**
 * `AGENTISTICS_DIR` must relocate EVERY persisted path, not only `preferences.json`.
 *
 * These constants are computed once at module load from the environment, so they cannot be
 * re-derived by mutating `process.env` inside this process — `config.ts` has almost always been
 * imported (and evaluated) by an earlier test file in the same `bun test` run. The only faithful
 * way to observe them under a different environment is a child process, which is what this does.
 *
 * The regression it pins: the consolidate store, the archive and the workflow store were built
 * from `HOME_DIR` directly, so an instance given its own data dir kept reading and PUSHING the
 * sessions of whatever profile it ran under. A unit test asserting the string would not have
 * caught it — the value was correct for the default case, and only wrong once relocated.
 */
async function resolveConfigUnder(dataDir: string): Promise<Record<string, string>> {
  const script = `
    const c = await import(${JSON.stringify(join(import.meta.dir, 'config.ts'))})
    console.log(JSON.stringify({
      data: c.AGENTISTICS_DATA_DIR,
      sessions: c.CONSOLIDATED_DIR,
      archive: c.ARCHIVE_DIR,
      workflows: c.WORKFLOWS_STORE_DIR,
    }))
  `
  const proc = Bun.spawn(['bun', '-e', script], {
    env: { ...process.env, AGENTISTICS_DIR: dataDir },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const out = await new Response(proc.stdout).text()
  await proc.exited
  const line = out.trim().split('\n').filter(Boolean).at(-1) ?? '{}'
  return JSON.parse(line) as Record<string, string>
}

describe('AGENTISTICS_DIR relocates every persisted path', () => {
  test('no persisted path escapes the configured data dir', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentistics-datadir-'))
    const cfg = await resolveConfigUnder(dir)

    // Guard against a silently empty result making every assertion below vacuous.
    expect(Object.keys(cfg).length).toBe(4)
    expect(cfg.data).toBe(dir)

    for (const [name, value] of Object.entries(cfg)) {
      expect(typeof value).toBe('string')
      expect(value.length).toBeGreaterThan(0)
      // The whole point: every one of them sits UNDER the configured dir.
      expect({ name, under: value.startsWith(dir + '/') || value === dir })
        .toEqual({ name, under: true })
    }
  }, 30_000)

  test('the consolidate store in particular moves — the path that leaked another profile\'s sessions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentistics-datadir-'))
    const cfg = await resolveConfigUnder(dir)
    expect(cfg.sessions).toBe(join(dir, 'sessions'))
    expect(cfg.archive).toBe(join(dir, 'archive'))
    expect(cfg.workflows).toBe(join(dir, 'workflows'))
  }, 30_000)
})

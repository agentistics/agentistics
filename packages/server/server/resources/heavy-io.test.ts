import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readHeavyState } from './heavy-io'

const MB = 1024 * 1024

describe('heavy job resident memory', () => {
  test.skipIf(process.platform !== 'linux')('does not treat an open but unlocked file as a running job', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'heavy-unlocked-'))
    const handle = await open(join(dir, 'agentistics-heavy.lock'), 'w')
    try {
      const state = await readHeavyState(join(dir, 'state'), dir)
      expect(state.running).toHaveLength(0)
    } finally {
      await handle.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  for (const mode of ['fork', 'exec', 'fd'] as const) {
    test.skipIf(process.platform !== 'linux' || !Bun.which('flock'))(
      mode === 'exec' ? 'measures a lock holder that execs the job (flock -F)' : mode === 'fd' ? 'measures an inherited FD lock after the flock helper exits' : 'refreshes stale recorded RSS including flock descendants',
      async () => {
        const dir = await mkdtemp(join(tmpdir(), 'heavy-memory-'))
        const ready = join(dir, 'ready')
        const stateDir = join(dir, 'state')
        const script = 'const a = new Uint8Array(64 * 1024 * 1024); a.fill(1); await Bun.write(process.argv[1], "ready"); setInterval(() => { a[0]++ }, 1000)'
        const lock = join(dir, 'agentistics-heavy.lock')
        const command = mode === 'fd'
          ? ['bash', '-c', 'exec 9>"$1"; flock 9; exec "$2" -e "$3" "$4"', 'fixture', lock, process.execPath, script, ready]
          : ['flock', ...(mode === 'exec' ? ['-F'] : []), lock, process.execPath, '-e', script, ready]
        const child = Bun.spawn(command, { stdout: 'ignore', stderr: 'ignore' })
        try {
          const deadline = Date.now() + 5000
          while (await readFile(ready, 'utf8').catch(() => '') !== 'ready') {
            if (Date.now() > deadline) throw new Error('heavy fixture did not acquire its lock')
            await Bun.sleep(10)
          }
          if (mode === 'fork') {
            await mkdir(join(stateDir, 'running'), { recursive: true })
            await writeFile(join(stateDir, 'running', `${child.pid}.json`), JSON.stringify({
              pid: child.pid, slot: 0, sinceMs: Date.now(), command: 'fixture', usedBytes: 1,
            }))
          }
          const state = await readHeavyState(stateDir, dir)
          expect(state.running).toHaveLength(1)
          expect(state.running[0]!.pid).toBe(child.pid)
          expect(state.running[0]!.usedBytes!).toBeGreaterThan(64 * MB)
          expect(state.waiting).toHaveLength(0)
        } finally {
          // flock's child inherits the lock; terminate its measured tree before removing the fixture.
          const { readProcTable } = await import('./proc-read')
          const { heavyTreePids } = await import('./heavy')
          const pids = heavyTreePids([child.pid], readProcTable(Date.now(), true) ?? []).reverse()
          for (const pid of pids) { try { process.kill(pid, 'SIGTERM') } catch { /* exited */ } }
          await child.exited
          await rm(dir, { recursive: true, force: true })
        }
      },
    )
  }
})

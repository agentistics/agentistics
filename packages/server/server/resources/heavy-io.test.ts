import { describe, expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readHeavyState } from './heavy-io'

const MB = 1024 * 1024

describe('heavy job resident memory', () => {
  test.skipIf(process.platform !== 'linux' || !Bun.which('flock'))('shows a manual holder and waiter, without counting an agentop flock child twice', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'heavy-waiters-'))
    const lock = join(dir, 'agentistics-heavy.lock')
    const ready = join(dir, 'ready')
    const release = join(dir, 'release')
    const acquired = join(dir, 'acquired')
    const stateDir = join(dir, 'state')
    const holder = Bun.spawn(['flock', lock, process.execPath, '-e', 'await Bun.write(process.argv[1], "ready"); while (!await Bun.file(process.argv[2]).exists()) await Bun.sleep(10)', ready, release], { stdout: 'ignore', stderr: 'ignore' })
    let waiter: ReturnType<typeof Bun.spawn> | undefined
    try {
      const deadline = Date.now() + 4000
      while (await readFile(ready, 'utf8').catch(() => '') !== 'ready') {
        if (Date.now() > deadline) throw new Error('holder did not acquire fixture lock')
        await Bun.sleep(10)
      }
      waiter = Bun.spawn(['flock', lock, process.execPath, '-e', 'await Bun.write(process.argv[1], "ready"); await Bun.sleep(60000)', acquired], { stdout: 'ignore', stderr: 'ignore' })
      await Bun.sleep(30)
      const manual = await readHeavyState(stateDir, dir)
      expect(manual.running.some(r => r.pid === holder.pid && r.manual)).toBe(true)
      expect(manual.waiting.filter(w => w.pid === waiter!.pid && w.manual)).toHaveLength(1)
      await mkdir(join(stateDir, 'waiting'), { recursive: true })
      await writeFile(join(stateDir, 'waiting', `${process.pid}.json`), JSON.stringify({
        pid: process.pid, sinceMs: Date.now(), command: 'agentop fixture', flockPid: waiter.pid,
      }))
      const owned = await readHeavyState(stateDir, dir)
      expect(owned.waiting.filter(w => w.pid === waiter!.pid)).toHaveLength(0)
      expect(owned.waiting.filter(w => w.pid === process.pid)).toHaveLength(1)
      await writeFile(release, 'release')
      await holder.exited
      while (await readFile(acquired, 'utf8').catch(() => '') !== 'ready') {
        if (Date.now() > deadline) throw new Error('queued flock did not acquire fixture lock')
        await Bun.sleep(10)
      }
      const running = await readHeavyState(stateDir, dir)
      expect(running.running.filter(r => r.pid === waiter!.pid)).toHaveLength(1)
      expect(running.running.find(r => r.pid === waiter!.pid)?.manual).toBe(false)
      expect(running.running.find(r => r.pid === waiter!.pid)?.command).toBe('agentop fixture')
      expect(running.waiting).toHaveLength(0)
    } finally {
      const { readProcTable } = await import('./proc-read')
      const { heavyTreePids } = await import('./heavy')
      for (const pid of heavyTreePids([holder.pid, ...(waiter ? [waiter.pid] : [])], readProcTable(Date.now(), true) ?? []).reverse()) {
        try { process.kill(pid, 'SIGTERM') } catch { /* exited */ }
      }
      if (waiter) await waiter.exited
      await holder.exited
      await rm(dir, { recursive: true, force: true })
    }
  })

  test.skipIf(process.platform !== 'linux' || !Bun.which('flock'))('does not scan descriptors for an open but unlocked file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'heavy-unlocked-'))
    const handle = await open(join(dir, 'agentistics-heavy.lock'), 'w')
    const readDirs = spyOn(fs, 'readdir')
    try {
      const state = await readHeavyState(join(dir, 'state'), dir)
      expect(state.running).toHaveLength(0)
      expect(readDirs.mock.calls.length).toBeGreaterThan(0)
      expect(readDirs.mock.calls.filter(([path]) => /^\/proc\/\d+\/fd$/.test(String(path)))).toHaveLength(0)
    } finally {
      readDirs.mockRestore()
      await handle.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  for (const failure of ['throws', 'exits nonzero'] as const) {
    test.skipIf(process.platform !== 'linux')(`falls back to descriptor scanning when the lock probe ${failure}`, async () => {
      const dir = await mkdtemp(join(tmpdir(), 'heavy-probe-error-'))
      const handle = await open(join(dir, 'agentistics-heavy.lock'), 'w')
      const readDirs = spyOn(fs, 'readdir')
      const realSpawn = Bun.spawn
      const spawn = spyOn(Bun, 'spawn').mockImplementation(() => {
        if (failure === 'throws') throw new Error('probe unavailable')
        return realSpawn(['/bin/false'], { stdout: 'ignore', stderr: 'ignore' })
      })
      try {
        const state = await readHeavyState(join(dir, 'state'), dir)
        expect(spawn).toHaveBeenCalledTimes(1)
        expect(readDirs.mock.calls.some(([path]) => /^\/proc\/\d+\/fd$/.test(String(path)))).toBe(true)
        expect(state.running).toHaveLength(0)
      } finally {
        spawn.mockRestore()
        readDirs.mockRestore()
        await handle.close()
        await rm(dir, { recursive: true, force: true })
      }
    })
  }

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
          if (mode !== 'fork') expect(state.running[0]!.manual).toBe(true)
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

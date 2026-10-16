import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RELAY_FILES } from './structured-relay'

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function until(condition: () => boolean, timeout = 3000): Promise<void> {
  const deadline = Date.now() + timeout
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await sleep(20)
  }
}

/** A killed process whose parent is gone can linger as a zombie until something reaps it (CI
 *  runners whose PID 1 does not reap): kill(pid, 0) still succeeds there, so a zombie counts as dead. */
function alive(pid: number): boolean {
  try { process.kill(pid, 0) } catch { return false }
  try { return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, 'utf8')) } catch { return true }
}

/** Starts a REAL relay (its own process, like the server does) around a shell script child. */
function startRelay(script: string) {
  const dir = mkdtempSync(join(tmpdir(), 'structured-relay-'))
  const sh = join(dir, 'child.sh')
  writeFileSync(sh, script)
  writeFileSync(join(dir, RELAY_FILES.launch), JSON.stringify({ bin: '/bin/sh', args: [sh], cwd: dir }))
  const proc = spawn(process.execPath, ['run', join(import.meta.dir, 'structured-relay.ts'), dir], { stdio: 'ignore', detached: true })
  const pids = new Set<number>([proc.pid!])
  const read = (f: string): number => Number(readFileSync(join(dir, f), 'utf8').trim())
  return {
    dir, proc, read,
    track: (pid: number) => { pids.add(pid) },
    cleanup: () => { for (const pid of pids) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } } },
  }
}

const waitFile = (r: { dir: string }, f: string) => until(() => existsSync(join(r.dir, f)) && readFileSync(join(r.dir, f), 'utf8').trim() !== '')

describe('structured relay termination', () => {
  test('SIGTERM exits the relay when the child already exited', async () => {
    const r = startRelay('exit 0\n')
    try {
      await waitFile(r, RELAY_FILES.exit)
      try { process.kill(r.proc.pid!, 'SIGTERM') } catch { /* already done */ }
      await until(() => !alive(r.proc.pid!), 1000)
    } finally { r.cleanup() }
  })

  test('a child that obeys TERM and leaves nothing in its group: the relay exits without the grace', async () => {
    const r = startRelay('exec sleep 300\n')
    try {
      await waitFile(r, RELAY_FILES.pid)
      const child = (JSON.parse(readFileSync(join(r.dir, RELAY_FILES.pid), 'utf8')) as { child: number }).child; r.track(child)
      const t0 = Date.now()
      process.kill(r.proc.pid!, 'SIGTERM')
      await until(() => !alive(r.proc.pid!), 6000)
      expect(alive(child)).toBe(false)
      // Well inside the 3 s grace, which is only for descendants that ignore TERM.
      expect(Date.now() - t0).toBeLessThan(1500)
    } finally { r.cleanup() }
  })

  test('a child whose whole group obeys TERM: the relay leaves at once, not after the grace', async () => {
    const r = startRelay('exec sleep 300\n')
    try {
      await waitFile(r, RELAY_FILES.pid)
      const t = Date.now()
      process.kill(r.proc.pid!, 'SIGTERM')
      await until(() => !alive(r.proc.pid!), 4000)
      expect(Date.now() - t).toBeLessThan(2000) // KILL_GRACE_MS is 3000
    } finally { r.cleanup() }
  }, 10000)

  test('a parent that obeys TERM while its grandchild ignores it: the grandchild dies too', async () => {
    const r = startRelay('(trap "" TERM; exec sleep 300) &\necho $! > "$(dirname "$0")/gc.pid"\nwait\n')
    try {
      await waitFile(r, 'gc.pid'); await waitFile(r, RELAY_FILES.pid)
      const gc = r.read('gc.pid'); r.track(gc)
      expect(alive(gc)).toBe(true)
      process.kill(r.proc.pid!, 'SIGTERM')
      await until(() => !alive(gc), 6000)
      await until(() => !alive(r.proc.pid!), 2000)
    } finally { r.cleanup() }
  }, 15000)

  test('parent and grandchild both ignoring TERM are gone after the grace (SIGKILL to the group)', async () => {
    const r = startRelay('trap "" TERM\n(trap "" TERM; exec sleep 300) &\necho $! > "$(dirname "$0")/gc.pid"\nwhile :; do sleep 1; done\n')
    try {
      await waitFile(r, 'gc.pid'); await waitFile(r, RELAY_FILES.pid)
      const gc = r.read('gc.pid'); r.track(gc)
      const child = (JSON.parse(readFileSync(join(r.dir, RELAY_FILES.pid), 'utf8')) as { child: number }).child; r.track(child)
      process.kill(r.proc.pid!, 'SIGTERM')
      await sleep(1000)
      expect(alive(gc) && alive(child)).toBe(true) // the grace has not elapsed: nothing is killed early
      await until(() => !alive(gc) && !alive(child), 10000)
      await until(() => !alive(r.proc.pid!), 4000)
    } finally { r.cleanup() }
  }, 25000)

  test('a relay with a live child and no TERM keeps running (survives its launcher)', async () => {
    const r = startRelay('exec sleep 300\n')
    try {
      await waitFile(r, RELAY_FILES.pid)
      await sleep(600)
      const child = (JSON.parse(readFileSync(join(r.dir, RELAY_FILES.pid), 'utf8')) as { child: number }).child; r.track(child)
      expect(alive(r.proc.pid!) && alive(child)).toBe(true)
    } finally { r.cleanup() }
  })
})

describe('structured relay stdout drain', () => {
  test('TERM preserves the last lines and an unterminated tail before exit', async () => {
    const r = startRelay(`trap 'i=0; while [ "$i" -lt 2000 ]; do echo "last-$i"; i=$((i + 1)); done; printf final-tail; exit 0' TERM
printf ready > ready
while :; do :; done
`)
    try {
      await waitFile(r, 'ready')
      // The child can print `ready` before the relay has written its pid file.
      await waitFile(r, RELAY_FILES.pid)
      const child = (JSON.parse(readFileSync(join(r.dir, RELAY_FILES.pid), 'utf8')) as { child: number }).child
      r.track(child)
      process.kill(r.proc.pid!, 'SIGTERM')
      await until(() => !alive(r.proc.pid!), 4000)
      const lines = readFileSync(join(r.dir, RELAY_FILES.out), 'utf8').trim().split('\n')
        .map(line => (JSON.parse(line) as { l: string }).l)
      expect(lines).toHaveLength(2001)
      expect(lines[0]).toBe('last-0')
      expect(lines[1999]).toBe('last-1999')
      expect(lines[2000]).toBe('final-tail')
      expect(existsSync(join(r.dir, RELAY_FILES.exit))).toBe(true)
    } finally { r.cleanup() }
  }, 10000)
})

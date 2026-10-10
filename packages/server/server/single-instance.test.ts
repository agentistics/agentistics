/** The guard that stops a second server from spending a laptop's memory on work the first one is
 *  already doing. Four were once found running side by side, two of them started in the same
 *  second — so "two processes racing" is the case that actually matters here, not the tidy one. */
import { test, expect } from 'bun:test'
import { mkdtemp, writeFile, readFile, utimes } from 'fs/promises'
import { tmpdir } from 'os'
import { basename, join } from 'path'
import { claimInstanceLock } from './single-instance'

async function lockPath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'lock-')), 'server.lock')
}

test('the first caller claims it and the second is refused', async () => {
  const file = await lockPath()

  // This process's own pid, because the holder has to be ALIVE for the claim to mean anything —
  // a made-up pid is a dead pid, and a dead holder is correctly treated as debris.
  const first = await claimInstanceLock(file, process.pid)
  expect(first.ok).toBe(true)

  const second = await claimInstanceLock(file, 2222)
  expect(second.ok).toBe(false)
  // It reports WHO holds it, so the loser can say something useful instead of dying silently.
  if (!second.ok) expect(second.holder).toBe(process.pid)
})

test('exactly one of many simultaneous starts wins', async () => {
  const file = await lockPath()

  // The real failure: a supervisor launching copies in the same second, where a "is the port
  // free?" probe lets every one of them through.
  const results = await Promise.all(
    Array.from({ length: 8 }, () => claimInstanceLock(file, process.pid))
  )

  expect(results.filter(r => r.ok)).toHaveLength(1)
})

test('releasing lets the next one in', async () => {
  const file = await lockPath()

  const first = await claimInstanceLock(file, process.pid)
  expect(first.ok).toBe(true)
  if (first.ok) await first.release()

  const second = await claimInstanceLock(file, 2222)
  expect(second.ok).toBe(true)
})

test('a lock left by a dead process is reclaimed, not obeyed forever', async () => {
  const file = await lockPath()
  // What a crash or `kill -9` leaves behind. Refusing to ever start again would be a worse
  // failure than the duplicate this guards against.
  // A pid that PROVABLY is dead: a child we ran and reaped (a fixed number may be alive).
  const gone = Bun.spawn(['true'])
  await gone.exited
  await writeFile(file, String(gone.pid))

  const claim = await claimInstanceLock(file, 4444)
  expect(claim.ok).toBe(true)
  expect((await readFile(file, 'utf-8')).trim().split(' ')[0]).toBe('4444')
})

test('a live holder is obeyed — this process is the liveness proof', async () => {
  const file = await lockPath()
  await writeFile(file, String(process.pid))

  const claim = await claimInstanceLock(file, 5555)
  expect(claim.ok).toBe(false)
})

test('an unreadable lock that is FRESH is obeyed — a winner may be mid-write', async () => {
  const file = await lockPath()
  // Creating the lock and writing the pid into it are two operations. Deleting a claim caught in
  // between them would make this guard cause the race it prevents.
  await writeFile(file, '')

  const claim = await claimInstanceLock(file, 6666)
  expect(claim.ok).toBe(false)
})

test('an unreadable lock that is OLD is debris, and is reclaimed', async () => {
  const file = await lockPath()
  await writeFile(file, 'not-a-pid')
  const longAgo = new Date(Date.now() - 60_000)
  await utimes(file, longAgo, longAgo)

  const claim = await claimInstanceLock(file, 6666)
  expect(claim.ok).toBe(true)
})

test('release does not free a lock another process has already taken over', async () => {
  const file = await lockPath()

  const first = await claimInstanceLock(file, process.pid)
  expect(first.ok).toBe(true)
  // A slow shutdown: by the time the old server releases, the next one already owns the file.
  await writeFile(file, '2222')
  if (first.ok) await first.release()

  // Still held by 2222 — the late release must not have opened the door to a third.
  expect((await readFile(file, 'utf-8')).trim()).toBe('2222')
})

// THE CLAIM IS ON THE DATA DIRECTORY, NOT THE PORT — see `serverLockFile`'s header.
//
// It used to be `server-${port}.lock`, and measured on a real machine WITH that guard installed:
// `agentop server` on 47291 and a second one on 48801, both with no `AGENTISTICS_DIR`, both
// writing `~/.agentistics` and both spawning `git log --numstat` across every worktree. Two lock
// names, so both passed the guard that exists to stop exactly that. The port already has a claim
// — the bind. What two servers contend over is the directory.
test('the lock names the data directory and carries no port', async () => {
  const { serverLockFile, AGENTISTICS_DATA_DIR } = await import('./config')
  const file = serverLockFile()
  expect(file).toBe(join(AGENTISTICS_DATA_DIR, 'server.lock'))
  // A port in the name is what let two servers past it.
  expect(/\d{4,5}/.test(basename(file))).toBe(false)
})

// A PID IS NOT AN IDENTITY. `kill(pid, 0)` answers "is SOME process using this number", and after a
// reboot, a `wsl --shutdown` or a container restart the answer is routinely yes — for a process
// that never touched this lock. Measured on a real machine: the systemd unit refused to start for
// seven hours after a boot because the lock named pid 2826, which by then belonged to something
// else, and the unit restarted every 5s into the same refusal (9 116 times over the journal). In a
// container it is worse: the server is PID 1 in its own namespace every time, the lock lives on a
// persistent volume, and a central refused ITSELF after its first restart — forever.
//
// The rule: whoever wrote the lock was alive at the moment it wrote it, so a process holding that
// pid which STARTED AFTER the lock was written cannot be the writer.
test('a lock naming a pid that was REUSED after it was written is debris', async () => {
  const file = await lockPath()
  await writeFile(file, String(process.pid))
  // The lock is older than this (live) process — a previous holder of the number wrote it.
  const beforeWeStarted = new Date(Date.now() - 24 * 60 * 60_000)
  await utimes(file, beforeWeStarted, beforeWeStarted)

  const claim = await claimInstanceLock(file, 7777)
  expect(claim.ok).toBe(true)
  expect((await readFile(file, 'utf-8')).trim()).toBe('7777')
})

test('a container restart does not refuse ITSELF — same pid, lock from the previous run', async () => {
  const file = await lockPath()
  // PID 1 then, PID 1 now: the old run wrote its own number and was stopped without releasing.
  await writeFile(file, String(process.pid))
  const previousRun = new Date(Date.now() - 60 * 60_000)
  await utimes(file, previousRun, previousRun)

  const claim = await claimInstanceLock(file, process.pid)
  expect(claim.ok).toBe(true)
})

test('a genuine live holder is still obeyed when the start time cannot be read', async () => {
  const file = await lockPath()
  await writeFile(file, String(process.pid))
  const old = new Date(Date.now() - 60 * 60_000)
  await utimes(file, old, old)

  // Off Linux there is no /proc: "cannot tell" must keep the old, conservative answer.
  const claim = await claimInstanceLock(file, 8888, { processStartMs: () => undefined })
  expect(claim.ok).toBe(false)
})

test('the release completes before the process exits', async () => {
  const file = await lockPath()
  const first = await claimInstanceLock(file, process.pid)
  expect(first.ok).toBe(true)
  // The SIGTERM handler calls this and then `process.exit` on the next line. An async release
  // never got past its first `await`, so every clean stop left the lock behind.
  if (first.ok) first.releaseSync()
  const next = await claimInstanceLock(file, 2222)
  expect(next.ok).toBe(true)
})

// ---------------------------------------------------------------------------
// 2026-10-03: a duplicate start used to learn it was a duplicate only AFTER the vault, the watcher
// daemon and every import of index.ts had run — seconds of CPU each time, and a systemd unit
// restarting it every five seconds spent that 190 times. `probeInstanceLock` answers the same
// question WITHOUT claiming anything, so `agentop server` can ask it first.
// ---------------------------------------------------------------------------
import { probeInstanceLock } from './single-instance'

test('probe: a live holder is reported, and the probe claims nothing', async () => {
  const file = await lockPath()
  const first = await claimInstanceLock(file, process.pid)
  expect(first.ok).toBe(true)
  expect(await probeInstanceLock(file)).toBe(process.pid)
  // Still the first claimant's file: a probe must never take or remove it.
  expect((await readFile(file, 'utf-8')).trim().split(/\s+/)[0]).toBe(String(process.pid))
})

test('probe: no lock, or a lock left by a dead process, is "free" — and is left in place', async () => {
  const file = await lockPath()
  expect(await probeInstanceLock(file)).toBeNull()
  // A pid that PROVABLY is dead: a child we ran and reaped (a fixed number may be alive).
  const gone = Bun.spawn(['true'])
  await gone.exited
  await writeFile(file, String(gone.pid))
  expect(await probeInstanceLock(file)).toBeNull()
  // Stale-lock cleanup belongs to the claim, under O_EXCL; a probe deleting it would race it.
  expect((await readFile(file, 'utf-8')).trim()).toBe(String(gone.pid))
})

// ---------------------------------------------------------------------------
// 2026-10-03, measured on WSL: `ps` reported the live service's server as started at 01:02:44 while
// systemd had started it at 01:00:10 and its lock was written at 01:00:11. WSL STEPS the wall clock,
// so "started after the lock's mtime" read the LIVE holder as a recycled pid: the probe said
// "free", and the claim would have deleted a live server's lock. The writer now records its own
// start in BOOT-CLOCK ticks (/proc/<pid>/stat field 22), and identity is ticks == ticks — a
// comparison no wall-clock step can touch.
// ---------------------------------------------------------------------------
test('the claim records the writer\'s start ticks beside its pid', async () => {
  const file = await lockPath()
  const claim = await claimInstanceLock(file, process.pid, { processStartMs: () => undefined, processStartTicks: () => 4377050 })
  expect(claim.ok).toBe(true)
  expect((await readFile(file, 'utf-8')).trim()).toBe(`${process.pid} 4377050`)
})

test('a WALL-CLOCK STEP does not make a live holder look stale when its ticks match', async () => {
  const file = await lockPath()
  await writeFile(file, `${process.pid} 4377050`)
  // The wall clock now places this process's start 153 s AFTER the lock was written.
  const stepped = { processStartMs: () => Date.now() + 153_000, processStartTicks: () => 4377050 }
  expect(await probeInstanceLock(file, stepped)).toBe(process.pid)
  const second = await claimInstanceLock(file, 5555, stepped)
  expect(second.ok).toBe(false)
})

test('ticks that DIFFER mean the pid was reused — debris, whatever the wall clock says', async () => {
  const file = await lockPath()
  await writeFile(file, `${process.pid} 111`)
  const probe = { processStartMs: () => 0, processStartTicks: () => 999 }
  expect(await probeInstanceLock(file, probe)).toBeNull()
  const claim = await claimInstanceLock(file, 7777, probe)
  expect(claim.ok).toBe(true)
})

import { waitForInstanceLock } from './single-instance'

test('waitForInstanceLock: a service start WAITS for the holder to let go, then claims (no outage after a refusal)', async () => {
  const file = await lockPath()
  const first = await claimInstanceLock(file)
  if (!first.ok) throw new Error('first claim failed')
  const waits: number[] = []
  setTimeout(() => { void first.release() }, 30)
  const second = await waitForInstanceLock(file, { timeoutMs: 5_000, pollMs: 10, pid: 999_999_1, onWait: holder => { waits.push(holder ?? -1) } })
  expect(second.ok).toBe(true)
  expect(waits.length).toBe(1) // said once that it is waiting, not on every poll
  if (second.ok) await second.release()
})

test('waitForInstanceLock: bounded — a holder that never lets go is still refused at the deadline', async () => {
  const file = await lockPath()
  const first = await claimInstanceLock(file)
  if (!first.ok) throw new Error('first claim failed')
  const t0 = Date.now()
  const second = await waitForInstanceLock(file, { timeoutMs: 60, pollMs: 10, pid: 999_999_2 })
  expect(second.ok).toBe(false)
  expect(Date.now() - t0).toBeGreaterThanOrEqual(55)
  await first.release()
})

// The CLI's early check (`agentop server`, before anything loads) under the service manager: the
// same bounded wait as index.ts's claim, so a unit start is not refused before that wait runs.
import { waitForInstanceFree } from './single-instance'

test('waitForInstanceFree: waits for the holder to let go, claims nothing, then answers free', async () => {
  const file = await lockPath()
  const first = await claimInstanceLock(file)
  if (!first.ok) throw new Error('first claim failed')
  const waits: number[] = []
  setTimeout(() => { void first.release() }, 30)
  expect(await waitForInstanceFree(file, { timeoutMs: 5_000, pollMs: 10, onWait: h => { waits.push(h) } })).toBeNull()
  expect(waits).toEqual([process.pid])
  // A probe claims nothing: the data dir is still free for index.ts's claim.
  const claim = await claimInstanceLock(file, 4242)
  expect(claim.ok).toBe(true)
  if (claim.ok) await claim.release()
})

test('waitForInstanceFree: bounded — a holder that never lets go is still reported at the deadline', async () => {
  const file = await lockPath()
  const first = await claimInstanceLock(file)
  if (!first.ok) throw new Error('first claim failed')
  const t0 = Date.now()
  expect(await waitForInstanceFree(file, { timeoutMs: 60, pollMs: 10 })).toBe(process.pid)
  expect(Date.now() - t0).toBeGreaterThanOrEqual(55)
  await first.release()
})

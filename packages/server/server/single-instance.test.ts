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
  await writeFile(file, '999999')

  const claim = await claimInstanceLock(file, 4444)
  expect(claim.ok).toBe(true)
  expect((await readFile(file, 'utf-8')).trim()).toBe('4444')
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

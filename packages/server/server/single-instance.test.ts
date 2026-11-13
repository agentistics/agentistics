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

  const claim = await claimInstanceLock(file, 5555, { processStartMs: () => undefined, holderCommand: () => 'agentop server' })
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
// persistent volume, and the server refused ITSELF after its first restart — forever.
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
  expect((await readFile(file, 'utf-8')).trim().split(' ')[0]).toBe('7777') // the start ticks may follow when pid 7777 happens to be live on the runner
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
import { describeHolder } from './single-instance'

// ---------------------------------------------------------------------------
// 2026-11-12 (BOOT.LOCK-REBOOT): after a WSL reboot the unit found pid 740 — a process of the NEW
// boot — "holding" a lock written in the previous one, waited 10 min, and exited 75 (which the unit
// refuses to restart on). Boot-clock ticks are only comparable WITHIN a boot, so the lock now records
// the kernel boot id and a lock from another boot is stale whatever pid and ticks say.
// ---------------------------------------------------------------------------
const BOOT_A = 'aaaaaaaa-0000-0000-0000-000000000001'
const BOOT_B = 'bbbbbbbb-0000-0000-0000-000000000002'

test('boot: the claim records the boot id after pid and ticks', async () => {
  const file = await lockPath()
  const claim = await claimInstanceLock(file, process.pid, { processStartMs: () => undefined, processStartTicks: () => 55, bootId: () => BOOT_A })
  expect(claim.ok).toBe(true)
  expect((await readFile(file, 'utf-8')).trim()).toBe(`${process.pid} 55 ${BOOT_A}`)
})

test('boot: a lock from ANOTHER boot is reclaimed even when a live recycled pid has the SAME ticks', async () => {
  const file = await lockPath()
  await writeFile(file, `${process.pid} 740 ${BOOT_A}`)
  const probe = { processStartMs: () => undefined, processStartTicks: () => 740, bootId: () => BOOT_B }
  expect(await probeInstanceLock(file, probe)).toBeNull()
  const claim = await claimInstanceLock(file, 7777, probe)
  expect(claim.ok).toBe(true)
  expect((await readFile(file, 'utf-8')).trim().split(/\s+/)[0]).toBe('7777')
})

test('boot: the same boot with a live holder whose ticks match is still refused', async () => {
  const file = await lockPath()
  await writeFile(file, `${process.pid} 740 ${BOOT_A}`)
  const probe = { processStartMs: () => undefined, processStartTicks: () => 740, bootId: () => BOOT_A }
  expect(await probeInstanceLock(file, probe)).toBe(process.pid)
  const claim = await claimInstanceLock(file, 7777, probe)
  expect(claim.ok).toBe(false)
})

test('boot: an old-format lock (pid only) older than the current boot is reclaimed', async () => {
  const file = await lockPath()
  await writeFile(file, String(process.pid))
  const beforeBoot = new Date(Date.now() - 2 * 60 * 60_000)
  await utimes(file, beforeBoot, beforeBoot)
  // Booted ten minutes ago; the lock is two hours old, so it was written in a previous boot.
  const probe = { processStartMs: () => undefined, bootStartMs: () => Date.now() - 10 * 60_000 }
  expect(await probeInstanceLock(file, probe)).toBeNull()
  expect((await claimInstanceLock(file, 7777, probe)).ok).toBe(true)
})

test('boot: an old-format pid+ticks lock older than the boot is reclaimed even when ticks match', async () => {
  const file = await lockPath()
  await writeFile(file, `${process.pid} 740`)
  const beforeBoot = new Date(Date.now() - 2 * 60 * 60_000)
  await utimes(file, beforeBoot, beforeBoot)
  const probe = { processStartMs: () => undefined, processStartTicks: () => 740, bootStartMs: () => Date.now() - 10 * 60_000 }
  expect(await probeInstanceLock(file, probe)).toBeNull()
})

test('boot: an old-format lock written AFTER the boot is still obeyed', async () => {
  const file = await lockPath()
  await writeFile(file, String(process.pid))
  const probe = { processStartMs: () => undefined, bootStartMs: () => Date.now() - 60 * 60_000 }
  expect(await probeInstanceLock(file, probe)).toBe(process.pid)
})

test('boot: waitForInstanceLock reclaims a lock that becomes recognisable as stale mid-wait', async () => {
  const file = await lockPath()
  await writeFile(file, `${process.pid} 740 ${BOOT_A}`)
  let calls = 0
  // First polls: the boot id cannot be read (unknown keeps the conservative answer); later it can.
  const probe = {
    processStartMs: () => undefined,
    processStartTicks: () => 740,
    bootId: () => (++calls < 4 ? undefined : BOOT_B),
  }
  const r = await waitForInstanceLock(file, { timeoutMs: 5_000, pollMs: 5, pid: 424242, probe })
  expect(r.ok).toBe(true)
  expect(calls).toBeGreaterThanOrEqual(4)
})

test('boot: waitForInstanceFree sees a recycled pid as free once the boot id says so', async () => {
  const file = await lockPath()
  await writeFile(file, `${process.pid} 740 ${BOOT_A}`)
  let calls = 0
  const probe = { processStartMs: () => undefined, processStartTicks: () => 740, bootId: () => (++calls < 3 ? undefined : BOOT_B) }
  expect(await waitForInstanceFree(file, { timeoutMs: 5_000, pollMs: 5, probe })).toBeNull()
})

test('describeHolder names what the holder pid is, truncated, and degrades to nothing', () => {
  const own = describeHolder(process.pid)
  expect(own).toBeTruthy()
  expect(own!.length).toBeLessThanOrEqual(120)
  expect(describeHolder(0x7ffffff0)).toBeUndefined()
  const long = describeHolder(1, () => 'x'.repeat(500).split('').join('\0'))
  expect(long!.length).toBeLessThanOrEqual(120)
  expect(describeHolder(1, () => 'a\0b\0c')).toBe('a b c')
})

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

// ---------------------------------------------------------------------------
// 2026-11-13 (BOOT.LOCK-ANTIGO): an OLD-format lock (only `<pid>`) whose pid is alive but is NOT an
// agentop server is stale — nothing proves who wrote it, and a stranger holding the number is the
// reboot failure again. A holder that cannot be described is still believed (never steal).
// ---------------------------------------------------------------------------
import { isAgentopServerCommand } from './single-instance'

const base = { processStartMs: () => undefined }

test('old-format lock + live NON-agentop pid is reclaimed at once', async () => {
  const file = await lockPath()
  await writeFile(file, String(process.pid))
  const probe = { ...base, holderCommand: () => 'sleep 1000' }
  expect(await probeInstanceLock(file, probe)).toBeNull()
  expect((await claimInstanceLock(file, 7777, probe)).ok).toBe(true)
})

test('old-format lock + live agentop server pid still refuses', async () => {
  const file = await lockPath()
  await writeFile(file, String(process.pid))
  const probe = { ...base, holderCommand: () => '/home/u/.local/bin/agentop server' }
  expect(await probeInstanceLock(file, probe)).toBe(process.pid)
  expect((await claimInstanceLock(file, 7777, probe)).ok).toBe(false)
})

test('old-format lock + holder that cannot be described still refuses (never steal)', async () => {
  const file = await lockPath()
  await writeFile(file, String(process.pid))
  const probe = { ...base, holderCommand: () => undefined }
  expect(await probeInstanceLock(file, probe)).toBe(process.pid)
  expect((await claimInstanceLock(file, 7777, probe)).ok).toBe(false)
})

test('new-format lock is not judged by its command line', async () => {
  const file = await lockPath()
  await writeFile(file, `${process.pid} 740 ${BOOT_A}`)
  const probe = { ...base, processStartTicks: () => 740, bootId: () => BOOT_A, holderCommand: () => 'sleep 1000' }
  expect(await probeInstanceLock(file, probe)).toBe(process.pid)
})

test('isAgentopServerCommand: any agentop executable, nothing else', () => {
  expect(isAgentopServerCommand('/home/u/.local/bin/agentop server')).toBe(true)
  expect(isAgentopServerCommand('agentop server --port 1')).toBe(true)
  expect(isAgentopServerCommand('bun /r/packages/server/bin/cli.ts server')).toBe(true)
  expect(isAgentopServerCommand('bun run /r/packages/server/server/index.ts')).toBe(true)
  expect(isAgentopServerCommand('sleep 1000')).toBe(false)
  expect(isAgentopServerCommand('agentop session ls')).toBe(true)
  expect(isAgentopServerCommand('/home/u/.local/bin/agentop start')).toBe(true)
  expect(isAgentopServerCommand('vim agentop server.txt')).toBe(false)
  expect(isAgentopServerCommand('bun test packages/server/server/single-instance.test.ts')).toBe(false)
})

// ---------------------------------------------------------------------------
// BOOT.LOCK R1 (macOS): an executable path with spaces must not be cut at the first space.
// ---------------------------------------------------------------------------
import { readHolderCommand } from './single-instance'
import { spawn } from 'child_process'

test('R1: Linux argv form keeps argv[0] whole (spaces inside)', () => {
  expect(isAgentopServerCommand({ exe: '/Applications/Agent Tools/agentop', args: ['server'] })).toBe(true)
  expect(isAgentopServerCommand({ exe: '/usr/bin/sleep', args: ['999'] })).toBe(false)
  expect(isAgentopServerCommand({ exe: '/usr/bin/vim', args: ['agentop.txt'] })).toBe(false)
  expect(isAgentopServerCommand({ exe: '/opt/My Tools/bun', args: ['/r/packages/server/bin/cli.ts', 'server'] })).toBe(true)
  expect(isAgentopServerCommand({ exe: 'bun', args: ['test', 'x'] })).toBe(false)
})

test('R1: macOS form (comm= with spaces, command= unsplit) via the seam', () => {
  expect(isAgentopServerCommand({ exe: '/Applications/Agent Tools/agentop', args: '/Applications/Agent Tools/agentop server' })).toBe(true)
  expect(isAgentopServerCommand({ exe: '/usr/bin/vim', args: 'vim agentop.txt' })).toBe(false)
  expect(isAgentopServerCommand({ exe: '/opt/My Tools/node', args: 'node /r/packages/server/bin/cli.ts server' })).toBe(true)
})

test('R1: joined-string fallback is conservative', () => {
  expect(isAgentopServerCommand('/Applications/Agent Tools/agentop server')).toBe(true)
  expect(isAgentopServerCommand('sleep 999')).toBe(false)
  expect(isAgentopServerCommand('vim agentop.txt')).toBe(false)
  expect(isAgentopServerCommand('bun test x')).toBe(false)
})

test('R1/R4: the REAL readHolderCommand on this process and on a spawned sleep', async () => {
  if (process.platform !== 'linux') return
  const me = readHolderCommand(process.pid)
  expect(typeof me).toBe('object')
  expect(typeof (me as { exe: string }).exe).toBe('string')
  expect(Array.isArray((me as { args: unknown }).args)).toBe(true)
  expect(isAgentopServerCommand(me!)).toBe(false) // bun test …
  const child = spawn('sleep', ['999'], { stdio: 'ignore' })
  try {
    // Right after spawn the child may not have exec'd `sleep` yet (its /proc entry still shows the
    // parent image or is empty): wait up to 2 s for the exec before reading it back.
    let c = readHolderCommand(child.pid!) as { exe: string; args: string[] } | null
    for (let i = 0; i < 100 && !(c && c.exe.endsWith('sleep')); i++) {
      await Bun.sleep(20)
      c = readHolderCommand(child.pid!) as { exe: string; args: string[] } | null
    }
    if (!c) throw new Error('readHolderCommand returned nothing for the spawned sleep')
    expect(c.exe.endsWith('sleep')).toBe(true)
    expect(c.args).toEqual(['999'])
    expect(isAgentopServerCommand(c)).toBe(false)
  } finally {
    child.kill()
  }
})

test('R1: a REAL process whose executable path contains a space reads back whole and is agentop', async () => {
  if (process.platform !== 'linux') return
  const { mkdtempSync, symlinkSync } = await import('fs')
  const dir = join(mkdtempSync(join(tmpdir(), 'r1 ')), 'Agent Tools')
  require('fs').mkdirSync(dir)
  const exe = join(dir, 'agentop')
  // A SYMLINK, not a copy: /proc/<pid>/cmdline carries argv[0] as invoked (all readHolderCommand reads), and a symlink
  // has no write handle that could leave the target "text file busy" (ETXTBSY) at exec time.
  symlinkSync(require('fs').realpathSync('/bin/sleep'), exe)
  // Belt and braces: should exec still see a busy file (a handle another fork inherited)
  // (another test's fork inherited the fd) → ETXTBSY from spawn. Wait for the child's own 'spawn' /
  // 'error' event, retry on ETXTBSY, and name the cause instead of timing out on a null read.
  let child: ReturnType<typeof spawn> | undefined
  let lastError = ''
  for (let attempt = 0; attempt < 8 && !child; attempt++) {
    const candidate = spawn(exe, ['999'], { stdio: 'ignore' })
    const outcome = await new Promise<string>(resolve => {
      candidate.once('spawn', () => resolve(''))
      candidate.once('error', e => resolve(`${(e as NodeJS.ErrnoException).code ?? 'error'}: ${e.message}`))
    })
    if (outcome === '') child = candidate
    else {
      lastError = outcome
      if (!/ETXTBSY|EBUSY|EAGAIN/.test(outcome)) break
      await Bun.sleep(50 * (attempt + 1))
    }
  }
  if (!child) throw new Error(`could not spawn the copied executable ${exe}: ${lastError}`)
  let exited = ''
  child.once('exit', (code, signal) => { exited = `exited early (code ${code}, signal ${signal})` })
  try {
    // spawn() returns before exec: until then /proc/<pid>/cmdline still shows the parent's argv.
    const deadline = Date.now() + 5000
    let c = readHolderCommand(child.pid!) as { exe: string; args: string[] } | null
    while (c?.exe !== exe && !exited && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 10))
      c = readHolderCommand(child.pid!) as { exe: string; args: string[] } | null
    }
    if (!c) throw new Error(`readHolderCommand returned nothing for pid ${child.pid}${exited ? `: the child ${exited}` : ' within 5 s'}`)
    expect(c.exe).toBe(exe)
    expect(isAgentopServerCommand(c)).toBe(true)
  } finally {
    child.kill()
  }
})

test('R1b: a symlinked agentop (comm resolves to another basename) is still agentop via the invoked name', async () => {
  expect(isAgentopServerCommand({ exe: '/opt/x/agentop-bin', args: '/usr/local/bin/agentop server' })).toBe(true)
  expect(isAgentopServerCommand({ exe: '/opt/x/agentop-bin', args: '/opt/x/agentop-bin server' })).toBe(false)
  expect(isAgentopServerCommand({ exe: '/usr/bin/vim', args: 'vim agentop server.txt' })).toBe(false)
  const file = await lockPath()
  await writeFile(file, String(process.pid))
  const hourAgo = new Date(Date.now() - 3_600_000)
  await utimes(file, hourAgo, hourAgo)
  const probe = {
    processStartMs: () => Date.now(),
    holderCommand: () => ({ exe: '/opt/x/agentop-bin', args: '/usr/local/bin/agentop server' }),
  }
  expect((await claimInstanceLock(file, 7777, probe)).ok).toBe(false)
})

test('leader decision: old-format lock + LIVE agentop holder is held even when the mtime says "started after the write"', async () => {
  const file = await lockPath()
  await writeFile(file, String(process.pid))
  const hourAgo = new Date(Date.now() - 3_600_000)
  await utimes(file, hourAgo, hourAgo)
  // The wall-clock fallback would read the holder as younger than the file and steal it.
  const probe = {
    processStartMs: () => Date.now(),
    holderCommand: () => ({ exe: '/Applications/Agent Tools/agentop', args: ['server'] }),
  }
  expect(await probeInstanceLock(file, probe)).toBe(process.pid)
  expect((await claimInstanceLock(file, 7777, probe)).ok).toBe(false)
})

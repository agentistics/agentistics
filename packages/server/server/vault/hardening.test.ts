/**
 * SECRETS.4 §5.3 / §12.5 — process hardening.
 *  - pure: every step applied AND verified, any failure fails the whole; Windows is `limited`;
 *  - the gate: a failed hardening keeps BOTH scopes closed, with the `hardening-failed` sentence;
 *  - Linux, real: a hardened child is non-dumpable — a sibling process of the same user cannot open
 *    its /proc/<pid>/mem nor ptrace-attach to it (the un-hardened control CAN), it has a 0 core limit
 *    and SIGSEGV leaves no core; and the /proc/self reads the service relies on still work.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, openSync, closeSync, readFileSync, readdirSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { refusalSentence, memoryProtector } from '@agentistics/vault'
import { applyHardening, hardeningLines, yamaScope, type Libc } from './hardening'
import { __resetVaultForTests, __setHardeningForTests, ensureVaultOpen, initRunnerVault, notOpenRefusal, openRunnerVault, sealToFile, unlockVault, vaultStatus } from './service'

const okLibc = (): Libc & { calls: string[] } => {
  const calls: string[] = []
  let dumpable = 1
  let core: [bigint, bigint] = [1n << 62n, 1n << 62n]
  return {
    calls,
    setNotDumpable() { calls.push('prctl-set'); dumpable = 0; return 0 },
    getDumpable() { calls.push('prctl-get'); return dumpable },
    setNoCore() { calls.push('setrlimit'); core = [0n, 0n]; return 0 },
    getCoreLimit() { calls.push('getrlimit'); return core },
    denyAttach() { calls.push('deny'); return 0 },
  }
}

describe('applyHardening (pure)', () => {
  test('linux: core limit then non-dumpable, each verified', () => {
    const l = okLibc()
    const r = applyHardening('linux', l, () => null)
    expect(r).toEqual({ state: 'ok', private: true, coreDumps: 'off', yama: 'absent', reason: null })
    expect(l.calls).toEqual(['setrlimit', 'getrlimit', 'prctl-set', 'prctl-get'])
  })
  test('every failure fails the whole, in words', () => {
    const cases: [string, Partial<Libc>][] = [
      ['setrlimit', { setNoCore: () => -1 }],
      ['did not read back', { getCoreLimit: () => [0n, 5n] }],
      ['PR_SET_DUMPABLE', { setNotDumpable: () => -1 }],
      ['still reads as dumpable', { getDumpable: () => 1 }],
      ['setrlimit', { setNoCore: () => { throw new Error('boom') } }],
    ]
    for (const [why, patch] of cases) {
      const r = applyHardening('linux', { ...okLibc(), ...patch }, () => '1')
      expect(r.state).toBe('failed')
      expect(r.reason).toContain(why)
    }
    expect(applyHardening('linux', { error: 'no libc' }, () => null).state).toBe('failed')
  })
  test('darwin uses PT_DENY_ATTACH; windows is limited, said in words', () => {
    expect(applyHardening('darwin', okLibc(), () => null)).toMatchObject({ state: 'ok', private: true })
    expect(applyHardening('darwin', { ...okLibc(), denyAttach: () => -1 }, () => null).state).toBe('failed')
    const w = applyHardening('win32', { error: 'n/a' }, () => null)
    expect(w).toMatchObject({ state: 'limited', reason: 'windows-same-user' })
    expect(hardeningLines(w, 'en')[0]).toContain('another program running as you can read')
  })
  test('ptrace_scope: absent on a Yama-less kernel, reported not required', () => {
    expect(yamaScope(() => null)).toBe('absent')
    expect(yamaScope(() => '1\n')).toBe('1')
    expect(yamaScope(() => { throw new Error('EACCES') })).toBe('unreadable')
    expect(hardeningLines(applyHardening('linux', okLibc(), () => null), 'en')).toEqual(['Yama ptrace protection is absent on this kernel; Agentistics relies on being non-dumpable (private memory, no core dumps).'])
    expect(hardeningLines(applyHardening('linux', okLibc(), () => '1'), 'en')).toEqual([])
  })
})

describe('the hardening-failed gate', () => {
  afterAll(() => __setHardeningForTests(null))
  test('a failed hardening opens neither scope, and says why', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentistics-hard-'))
    __resetVaultForTests({ dir: join(dir, 'vault'), lang: 'en' })
    await sealToFile(join(dir, 'x.sealed'), 'central-token', 'n', new Uint8Array([1]))
    expect((await initRunnerVault(memoryProtector(), 'm1')).ok).toBe(true)
    // A new process (same disk) whose hardening failed:
    __resetVaultForTests({ dir: join(dir, 'vault'), lang: 'en' })
    __setHardeningForTests({ state: 'failed', private: false, coreDumps: 'on', yama: 'absent', reason: 'prctl(PR_SET_DUMPABLE, 0) was refused' })
    expect(await ensureVaultOpen()).toBeNull()
    const e = await notOpenRefusal()
    expect(e.code).toBe('hardening-failed')
    expect(e.message).toBe(refusalSentence('hardening-failed', 'en', { reason: 'prctl(PR_SET_DUMPABLE, 0) was refused' }))
    expect((await unlockVault('irrelevant passphrase')).ok).toBe(false)
    expect((await openRunnerVault()).ok).toBe(false)
    expect((await vaultStatus()).hardening?.state).toBe('failed')
  })
})

const linux = process.platform === 'linux'

async function child(mode: 'harden' | 'plain') {
  const cwd = await mkdtemp(join(tmpdir(), 'agentistics-core-'))
  const p = Bun.spawn([process.execPath, join(import.meta.dir, '__fixtures__', 'hardening-probe.ts'), mode], {
    cwd, stdout: 'pipe', stderr: 'pipe', env: { PATH: process.env.PATH ?? '', HOME: tmpdir() },
  })
  const reader = p.stdout.getReader()
  let buf = ''
  while (!buf.includes('\n')) { const { value, done } = await reader.read(); if (done) break; buf += new TextDecoder().decode(value) }
  return { p, cwd, info: JSON.parse(buf.trim()) as { pid: number; report: { state: string; private: boolean; yama: string } | null; selfReads: Record<string, boolean> } }
}

function canOpenMem(pid: number): boolean {
  try { closeSync(openSync(`/proc/${pid}/mem`, 'r')); return true } catch { return false }
}

async function tryAttach(pid: number): Promise<number> {
  const { dlopen, FFIType } = await import('bun:ffi')
  const lib = dlopen('libc.so.6', { ptrace: { args: [FFIType.i64, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i64 } })
  const rc = Number(lib.symbols.ptrace(16n, pid, null, null)) // PTRACE_ATTACH
  if (rc === 0) lib.symbols.ptrace(17n, pid, null, null) // PTRACE_DETACH — never leave it stopped
  lib.close()
  return rc
}

describe.skipIf(!linux)('Linux: the real thing', () => {
  test('a hardened process: private /proc/<pid>/mem, no ptrace, 0 core limit — the control is readable', async () => {
    const h = await child('harden')
    const c = await child('plain')
    try {
      expect(h.info.report).toMatchObject({ state: 'ok', private: true })
      expect(h.info.selfReads).toEqual({ stat: true, mountinfo: true, limits: true, readdir: true })
      // The control proves the probe itself is valid on this kernel (no Yama => same-user allowed).
      const yamaOff = !existsSync('/proc/sys/kernel/yama/ptrace_scope') || readFileSync('/proc/sys/kernel/yama/ptrace_scope', 'utf8').trim() === '0'
      if (yamaOff) expect(canOpenMem(c.info.pid)).toBe(true)
      expect(canOpenMem(h.info.pid)).toBe(false)
      expect(await tryAttach(h.info.pid)).toBe(-1)
      expect(readFileSync(`/proc/${h.info.pid}/limits`, 'utf8')).toMatch(/Max core file size\s+0\s+0/)
    } finally {
      c.p.kill()
    }
    // SIGSEGV leaves no core: the limit is 0 and the process is non-dumpable.
    const cwdFiles = () => readdirSync(`/proc/${h.info.pid}/cwd`) // denied for a non-dumpable process
    expect(cwdFiles).toThrow()
    h.p.kill('SIGSEGV')
    await h.p.exited
    // Bun's crash handler may re-raise as SIGILL/SIGABRT; either way it died of a crash signal…
    expect(['SIGSEGV', 'SIGILL', 'SIGABRT', 'SIGBUS']).toContain(h.p.signalCode ?? 'none')
    // …and left no core behind (on WSL a core would be piped to Windows; with limit 0 none is made).
    expect(readdirSync(h.cwd).filter(f => /^core/.test(f))).toEqual([])
  }, 30_000)
})

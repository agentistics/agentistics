/**
 * The holder walk against the REAL `/proc`, with processes this test starts and stops itself — never
 * a mock of the walk under test. Linux only, like the walk: elsewhere there is no `/proc` and the
 * walk answers `null`, which the last test pins.
 *
 * The shape mirrors a codex pane: a parent that is NOT the harness (here `sh`, there the node shim)
 * with the holder as a child (here `sleep` holding fd 3, there the native `codex` holding its
 * rollout). `sleep` stands in for the holder because it holds an inherited descriptor and does
 * nothing else.
 */
import { afterAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readFile, readlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { kimiTranscriptFromFds } from './process-transcript'
import { resolveHolderFile } from './process-conversation'

const linux = process.platform === 'linux'
const root = mkdtempSync(join(tmpdir(), 'proc-holder-'))
const U1 = '11111111-2222-4333-8444-555555555555'
const U2 = '66666666-7777-4888-9999-aaaaaaaaaaaa'
function sessionFile(id: string): string {
  const dir = join(root, 'sessions', 'wd_t_0', `session_${id}`, 'agents', 'main')
  mkdirSync(dir, { recursive: true })
  const f = join(dir, 'wire.jsonl')
  writeFileSync(f, '')
  return f
}
const F1 = sessionFile(U1)
const F2 = sessionFile(U2)
const started: ChildProcess[] = []

afterAll(() => {
  // Stop ONLY what this file started, by its own pid.
  for (const c of started) { try { process.kill(-c.pid!, 'SIGKILL') } catch { try { c.kill('SIGKILL') } catch {} } }
  rmSync(root, { recursive: true, force: true })
})

/**
 * A child that holds `file` on fd 3 and nothing else of note. Inside a subshell, so the descriptor is
 * opened by the CHILD: `sleep 30 3>>F` lets dash open the redirect in the parent (measured), which
 * would put the file on the pane process instead.
 */
const HOLD = (file: string) => `(exec 3>>"${file}"; exec sleep 30)`

/** `sh` as the pane; the script decides which children hold what. Returns once the children exist. */
async function pane(script: string, env: Record<string, string>): Promise<number> {
  const c = spawn('/bin/sh', ['-c', script], { env: { ...process.env, ...env }, stdio: 'ignore', detached: true })
  started.push(c)
  // Wait for the children to be there (the walk reads `/proc/<pid>/task/*/children`).
  for (let i = 0; i < 100; i++) {
    try {
      const kids = (await readFile(`/proc/${c.pid}/task/${c.pid}/children`, 'utf-8')).trim()
      if (kids) return c.pid!
    } catch {}
    await new Promise(r => setTimeout(r, 20))
  }
  return c.pid!
}

describe.skipIf(!linux)('resolveHolderFile on the real /proc', () => {
  it('finds the file THIS process holds when it is itself the holder', async () => {
    const self = basename(await readlink('/proc/self/exe'))
    const fh = await import('node:fs/promises').then(m => m.open(F1, 'a'))
    try {
      expect(await resolveHolderFile(process.pid, [self], kimiTranscriptFromFds))
        .toEqual({ file: F1, holder: process.pid })
    } finally { await fh.close() }
  })

  it('descends from a non-holder parent to the holder child, and reports the CHILD as holder', async () => {
    const pid = await pane(HOLD('$F') + '; true', { F: F1 })
    const got = await resolveHolderFile(pid, ['sleep'], kimiTranscriptFromFds)
    expect(got?.file).toBe(F1)
    expect(got?.holder).not.toBe(pid)
  })

  it('stops AT a holder: the holder’s own descriptors are read, never its children’s', async () => {
    // The pane itself is the "holder" here and holds nothing; its child holds the session file —
    // exactly a harness running `cat` on some other session's transcript. That must not link.
    const pid = await pane(HOLD('$F') + '; true', { F: F1 })
    const sh = basename(await readlink(`/proc/${pid}/exe`))
    expect(await resolveHolderFile(pid, [sh], kimiTranscriptFromFds)).toBeNull()
  })

  it('refuses when two holders under one pane each name a session', async () => {
    const pid = await pane(HOLD('$F1') + ' & ' + HOLD('$F2') + '; wait', { F1, F2 })
    expect(await resolveHolderFile(pid, ['sleep'], kimiTranscriptFromFds)).toBeNull()
  })

  it('answers null for a pid that does not exist', async () => {
    expect(await resolveHolderFile(2 ** 30, ['sleep'], kimiTranscriptFromFds)).toBeNull()
  })
})

describe.skipIf(linux)('resolveHolderFile off Linux', () => {
  it('answers null — there is no /proc to walk', async () => {
    expect(await resolveHolderFile(process.pid, ['bun'], kimiTranscriptFromFds)).toBeNull()
  })
})

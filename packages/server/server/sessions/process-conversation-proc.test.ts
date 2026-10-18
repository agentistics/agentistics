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
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { readdir, readFile, readlink } from 'node:fs/promises'
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

/** Every descendant of `pid` with its exe basename and the files its descriptors name. */
async function descendants(pid: number): Promise<{ pid: number; exe: string; files: Set<string> }[]> {
  const out: { pid: number; exe: string; files: Set<string> }[] = []
  const queue = [pid]
  while (queue.length > 0) {
    const p = queue.shift()!
    let kids: number[] = []
    try { kids = (await readFile(`/proc/${p}/task/${p}/children`, 'utf-8')).trim().split(/\s+/).filter(Boolean).map(Number) } catch {}
    for (const k of kids) {
      queue.push(k)
      try {
        const exe = basename(await readlink(`/proc/${k}/exe`))
        const files = new Set<string>()
        for (const fd of await readdir(`/proc/${k}/fd`)) {
          try { files.add(await readlink(`/proc/${k}/fd/${fd}`)) } catch {}
        }
        out.push({ pid: k, exe, files })
      } catch {}
    }
  }
  return out
}

/**
 * `sh` as the pane; the script decides which children hold what. Returns once the tree has reached
 * its final shape: every file in `env` held by a descendant running `holderExe`.
 *
 * "A child exists" is not that shape. The holder is a SUBSHELL that first opens the file and then
 * execs `sleep`, so for a moment the child is an `sh` holding nothing, then an `sh` holding the file,
 * and only then the `sleep` the test asks about — a walk landing in that window answered `undefined`
 * on a loaded machine.
 */
async function pane(script: string, env: Record<string, string>, holderExe = 'sleep'): Promise<number> {
  const c = spawn('/bin/sh', ['-c', script], { env: { ...process.env, ...env }, stdio: 'ignore', detached: true })
  started.push(c)
  const wanted = Object.values(env)
  for (let i = 0; i < 250; i++) {
    const tree = await descendants(c.pid!)
    if (wanted.every(f => tree.some(d => d.exe === holderExe && d.files.has(f)))) return c.pid!
    await new Promise(r => setTimeout(r, 20))
  }
  throw new Error(`the pane never reached its shape: ${JSON.stringify(env)} held by ${holderExe}`)
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

  it('follows a holder into a child that is a holder too — a self-updated CLI relaunching itself', async () => {
    // Measured on kimi: after an in-place update the old process stays as a wrapper holding nothing
    // and a new child on the new binary holds the session files. Here the wrapper is `sh` and the
    // child an inner `sh` holding fd 3; the grandchild `sleep` (not a holder) inherits it and must
    // NOT be the answer.
    const sh = basename(realpathSync('/bin/sh'))
    const pid = await pane(`(exec 3>>"$F"; exec /bin/sh -c 'sleep 30; true'); true`, { F: F1 }, sh)
    const got = await resolveHolderFile(pid, [sh], kimiTranscriptFromFds)
    expect(got?.file).toBe(F1)
    expect(got?.holder).not.toBe(pid)
    expect(basename(await readlink(`/proc/${got!.holder}/exe`))).toBe(sh)
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

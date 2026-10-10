import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HOME_DIR } from './config'
import { scanLinuxProcesses } from './live-sessions'

const root = mkdtempSync(join(tmpdir(), 'proc-memo-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

function proc(pid: string, o: { comm: string; statComm?: string; argv: string[]; start?: number }) {
  const d = join(root, pid)
  mkdirSync(join(d, 'fd'), { recursive: true })
  writeFileSync(join(d, 'comm'), `${o.comm}\n`)
  writeFileSync(join(d, 'cmdline'), o.argv.join('\0') + '\0')
  writeFileSync(join(d, 'environ'), `HOME=${HOME_DIR}\0`)
  // 52 fields; field 22 (index 19 after the comm) is the start time.
  const after = Array.from({ length: 50 }, (_, i) => (i === 19 ? String(o.start ?? 5) : '0'))
  writeFileSync(join(d, 'stat'), `${pid} (${o.statComm ?? o.comm}) S ${after.slice(1).join(' ')}`)
  for (const [name, target] of [['exe', o.comm === 'claude' ? '/home/u/.local/share/claude/versions/2.1.0' : `/usr/bin/${o.comm}`], ['cwd', '/tmp/work'], ['fd/0', '/dev/pts/1']] as const) {
    rmSync(join(d, name), { force: true }); symlinkSync(target, join(d, name))
  }
}

describe('scanLinuxProcesses — the not-a-harness memo (PERF.SLOW)', () => {
  writeFileSync(join(root, 'stat'), 'btime 1000\n')
  proc('100', { comm: 'bash', argv: ['bash'] })
  proc('200', { comm: 'claude', argv: ['claude'] })

  it('finds the harness and skips the rest', async () => {
    expect((await scanLinuxProcesses(root)).procs.map(p => p.pid)).toEqual([200])
  })
  it('a process known not to be a harness is not re-read while its identity holds', async () => {
    // argv/comm files change but /proc/<pid>/stat still says the same process: memo hit.
    writeFileSync(join(root, '100', 'comm'), 'claude\n')
    writeFileSync(join(root, '100', 'cmdline'), 'claude\0')
    expect((await scanLinuxProcesses(root)).procs.map(p => p.pid)).toEqual([200])
  })
  it('an exec (new comm in stat) or a new process on the pid is read again', async () => {
    proc('100', { comm: 'claude', statComm: 'claude', argv: ['claude'] })
    expect((await scanLinuxProcesses(root)).procs.map(p => p.pid).sort()).toEqual([100, 200])
  })
})

import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { kill as killProcess } from 'node:process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RELAY_FILES } from './structured-relay'

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function until(condition: () => boolean, timeout = 2000): Promise<void> {
  const deadline = Date.now() + timeout
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for relay')
    await sleep(20)
  }
}

function alive(pid: number): boolean {
  try { killProcess(pid, 0); return true } catch { return false }
}

async function waitExit(proc: ReturnType<typeof spawn>, timeout: number): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null || !alive(proc.pid!)) return
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('relay did not exit')), timeout)
    proc.once('exit', () => { clearTimeout(timer); resolve() })
  })
}

function relay(dir: string) {
  return spawn(process.execPath, ['run', join(import.meta.dir, 'structured-relay.ts'), dir], {
    stdio: 'ignore',
    detached: true,
  })
}

describe('structured relay termination', () => {
  test('SIGTERM exits the relay when the child already exited', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'structured-relay-'))
    writeFileSync(join(dir, RELAY_FILES.launch), JSON.stringify({ bin: '/bin/sh', args: ['-c', 'exit 0'], cwd: dir }))
    const proc = relay(dir)
    try {
      await until(() => existsSync(join(dir, RELAY_FILES.exit)))
      try { killProcess(proc.pid!, 'SIGTERM') } catch { /* the relay already completed its shutdown */ }
      await waitExit(proc, 1000)
      expect(JSON.parse(readFileSync(join(dir, RELAY_FILES.exit), 'utf8')).code).toBe(0)
    } finally {
      try { killProcess(proc.pid!, 'SIGKILL') } catch { /* already gone */ }
    }
  })

  test('the relay uses a detached ACP process group and kills that group on escalation', () => {
    const source = readFileSync(join(import.meta.dir, 'structured-relay.ts'), 'utf8')
    expect(source).toContain('detached: true')
    expect(source).toContain('process.kill(-pid, signal)')
    expect(source).toContain("killChild('SIGKILL')")
  })
})

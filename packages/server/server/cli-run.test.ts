import { describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { isRealAgentopPort, runRun } from './cli-run'

const canBindLocalhost = await new Promise<boolean>(resolve => {
  const server = createServer()
  server.once('error', () => resolve(false))
  server.listen(0, '127.0.0.1', () => server.close(() => resolve(true)))
})
const integration = canBindLocalhost ? test : test.skip

function runCli(home: string, args: string[]) {
  return new Promise<{ code: number | null; out: string }>(resolve => {
    const child = spawn(process.execPath, ['packages/server/bin/cli.ts', 'run', ...args], {
      cwd: join(import.meta.dir, '../../..'),
      env: { ...process.env, HOME: home, USERPROFILE: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', data => { out += data })
    child.stderr.on('data', data => { out += data })
    child.once('exit', code => resolve({ code, out }))
  })
}

describe('agentop run --rm', () => {
  test('never selects the real API or web ports', () => {
    expect(isRealAgentopPort(47291)).toBe(true)
    expect(isRealAgentopPort(47292)).toBe(true)
    expect(isRealAgentopPort(47290)).toBe(false)
    expect(isRealAgentopPort(47293)).toBe(false)
  })

  integration('does not mutate a fake real home and removes the throwaway home', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agentop-run-real-'))
    const realFile = join(home, '.claude.json')
    await Bun.write(realFile, '{"real":true}')
    const before = statSync(realFile).mtimeMs
    const result = await runCli(home, ['--rm', '--name', 'test-cleanup', '--ttl', '30s', '--', 'sh', '-c', 'test -d "$HOME/.agentistics" && test -d "$HOME/.claude"'])
    expect(result.code).toBe(0)
    expect(statSync(realFile).mtimeMs).toBe(before)
    expect(result.out).toContain('removed')
    expect(result.out).toContain('api:')
    expect(result.out).toContain('web:')
  }, 15_000)

  integration('TTL kills a command and still removes its home', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agentop-run-ttl-'))
    const result = await runCli(home, ['--rm', '--name', 'test-ttl', '--ttl', '1s', '--', 'sleep', '30'])
    expect(result.code).not.toBe(0)
    const lines = result.out.split('\n')
    const removed = lines.find(line => line.startsWith('removed '))
    expect(removed).toBeTruthy()
    const removedHome = removed!.slice('removed '.length)
    expect(() => readFileSync(join(removedHome, '.agentistics', 'missing'))).toThrow()
  }, 10_000)

  integration('refuses a --port-offset that lands on the real ports', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agentop-run-offset-'))
    for (const offset of ['0', '1']) {
      const result = await runCli(home, ['--rm', '--name', `test-offset-${offset}`, '--port-offset', offset, '--', 'true'])
      expect(result.code).toBe(2)
      expect(result.out).toContain('refused')
    }
  }, 15_000)

  integration('SIGTERM stops the command and removes the throwaway home before exiting', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agentop-run-sig-'))
    const child = spawn(process.execPath, ['packages/server/bin/cli.ts', 'run', '--rm', '--name', 'test-sig', '--', 'sleep', '30'], {
      cwd: join(import.meta.dir, '../../..'),
      env: { ...process.env, HOME: home, USERPROFILE: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', data => { out += data })
    child.stderr.on('data', data => { out += data })
    const exited = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)))
    for (let i = 0; i < 100 && !out.includes('stop:'); i++) await Bun.sleep(100)
    await Bun.sleep(500)
    child.kill('SIGTERM')
    expect(await exited).toBe(143)
    expect(out).toContain('removed ')
  }, 15_000)
})

describe('agentop run --help', () => {
  for (const flag of ['--help', '-h']) {
    test(`${flag} prints usage and exits 0`, async () => {
      const lines: string[] = []
      const orig = console.log
      console.log = (...a: unknown[]) => { lines.push(a.join(' ')) }
      try { expect(await runRun([flag])).toBe(0) } finally { console.log = orig }
      expect(lines.join('\n')).toContain('Usage: agentop run')
    })
  }
})

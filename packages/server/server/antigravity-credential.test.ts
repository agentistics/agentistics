import { describe, expect, test } from 'bun:test'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readAntigravityCredential, type AntigravityCredentialIo } from './antigravity-credential'

const ROOT = '/fake/agy'
const RAW = JSON.stringify({ auth_method: 'consumer', token: { access_token: 'ya29.FAKE-TOKEN-for-tests-only', expiry: '2099-01-01T00:00:00Z' } })
const entry = (secret?: string, id = '1') => `[/${id}]\nlabel = Fixture\n${secret === undefined ? '' : `secret = ${secret}\n`}created = 2026-10-29 12:00:00\nmodified = 2026-10-29 12:00:00\n`
const missing = async (): Promise<string> => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }) }
function rig(over: Partial<AntigravityCredentialIo> = {}) {
  const calls: unknown[][] = []
  const io: AntigravityCredentialIo = {
    platform: 'linux', defaultRoot: ROOT, readFile: missing,
    resolveExecutable: async candidates => { calls.push([candidates]); return '/fake/secret-tool' },
    run: async (...args) => { calls.push(args); return { code: 0, stdout: entry(RAW) } }, ...over,
  }
  return { io, calls }
}

describe('readAntigravityCredential', () => {
  test('file wins, including on another platform/root; no executable or child needed', async () => {
    const r = rig({ platform: 'darwin', readFile: async path => { expect(path).toBe(join('/other', 'antigravity-oauth-token')); return RAW } })
    expect(await readAntigravityCredential('/other', r.io)).toBe(RAW)
    expect(r.calls).toEqual([])
  })
  test('only missing file at the configured default Linux root searches without unlocking', async () => {
    const r = rig()
    expect(await readAntigravityCredential(ROOT, r.io)).toBe(RAW)
    expect(r.calls).toEqual([
      [['/usr/bin/secret-tool', '/bin/secret-tool', 'secret-tool']],
      ['/fake/secret-tool', ['search', '--all', 'service', 'gemini', 'username', 'antigravity'], { timeoutMs: 2000, maxBytes: 1048576 }],
    ])
  })
  test('another account root never touches the global keyring', async () => {
    const r = rig(); expect(await readAntigravityCredential('/other', r.io)).toBeNull(); expect(r.calls).toEqual([])
  })
  test('non-Linux never searches the keyring', async () => {
    for (const platform of ['darwin', 'win32'] as const) {
      const r = rig({ platform }); expect(await readAntigravityCredential(ROOT, r.io)).toBeNull(); expect(r.calls).toEqual([])
    }
  })
  test('present empty, malformed, expired or unreadable file never falls back', async () => {
    for (const raw of ['', 'invalid', RAW.replace('2099-', '2000-')]) {
      const r = rig({ readFile: async () => raw }); expect(await readAntigravityCredential(ROOT, r.io)).toBe(raw); expect(r.calls).toEqual([])
    }
    for (const code of ['EACCES', 'EISDIR', 'EIO']) {
      const r = rig({ readFile: async () => { throw Object.assign(new Error('unreadable'), { code }) } })
      expect(await readAntigravityCredential(ROOT, r.io)).toBeNull(); expect(r.calls).toEqual([])
    }
  })
  test('compact and pretty secrets work; locked entries are ignored', async () => {
    for (const raw of [RAW, JSON.stringify(JSON.parse(RAW), null, 2)]) {
      const r = rig({ run: async () => ({ code: 0, stdout: entry(undefined, 'locked') + entry(raw) }) })
      expect(await readAntigravityCredential(ROOT, r.io)).toBe(raw)
    }
  })
  test('locked, malformed, empty or ambiguous readable results yield no credential', async () => {
    for (const stdout of ['', entry(), 'garbage', entry('invalid'), entry(RAW) + entry(RAW, '2'), entry('{}') + entry(RAW, '2')]) {
      const r = rig({ run: async () => ({ code: 0, stdout }) }); expect(await readAntigravityCredential(ROOT, r.io)).toBeNull()
    }
  })
  test('many invalid lines are rejected within a bounded parsing budget', async () => {
    const r = rig({ run: async () => ({ code: 0, stdout: entry('{\n' + 'x\n'.repeat(20000)) }) })
    const start = performance.now()
    expect(await readAntigravityCredential(ROOT, r.io)).toBeNull()
    expect(performance.now() - start).toBeLessThan(250)
  })
  test('missing tool, child failure, timeout and excess output never throw', async () => {
    const absent = rig({ resolveExecutable: async () => null })
    expect(await readAntigravityCredential(ROOT, absent.io)).toBeNull()
    for (const over of [
      { run: async () => ({ code: 1, stdout: entry(RAW) }) },
      { run: async () => { throw new Error('timeout') } },
      { run: async () => ({ code: 0, stdout: entry(RAW) + 'x'.repeat(1048576) }) },
      { resolveExecutable: async () => { throw new Error('unavailable') } },
    ]) expect(await readAntigravityCredential(ROOT, rig(over).io)).toBeNull()
  })
  // These fixtures execute a POSIX shebang; platform-independent cases above still run on Windows.
  const subprocessTest = process.platform === 'win32' ? test.skip : test
  for (const mode of ['timeout', 'overflow', 'success'] as const) subprocessTest(`production runner: ${mode}, private output and reaped child`, async () => {
    const dir = await mkdtemp(join(process.env.HOME ?? tmpdir(), 'credential-fixture-'))
    const executable = join(dir, 'secret-tool')
    const pidFile = join(dir, 'pid')
    const output = mode === 'success' ? `process.stdout.write(${JSON.stringify(entry(RAW))});` : mode === 'overflow' ? "process.stdout.write('x'.repeat(1048577)); setInterval(() => {}, 1000);" : 'setInterval(() => {}, 1000);'
    await writeFile(executable, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); ${output}`, { mode: 0o700 })
    try {
      const start = Date.now()
      expect(await readAntigravityCredential(ROOT, { defaultRoot: ROOT, readFile: missing, resolveExecutable: async () => executable })).toBe(mode === 'success' ? RAW : null)
      expect(Date.now() - start).toBeLessThan(3000)
      const pid = Number(await readFile(pidFile, 'utf8'))
      expect(() => process.kill(pid, 0)).toThrow()
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
})

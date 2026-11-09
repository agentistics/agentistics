import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseEnviron, withBunEnv, withChildEnv, withoutKeys } from './spawn-env'

const decide = (env?: Record<string, string | undefined>) => env ? withoutKeys(env, ['X']) : { BASE: '1' }

describe('spawn-env — pure parts', () => {
  it('drops the keys and undefined values', () => {
    expect(withoutKeys({ X: '1', A: '2', U: undefined }, ['X'])).toEqual({ A: '2' })
    expect(parseEnviron('A=1\0B=x=y\0\0')).toEqual({ A: '1', B: 'x=y' })
  })
  it('puts env where each child_process API takes its options', () => {
    expect(withChildEnv('spawn', ['ls'], decide)).toEqual(['ls', { env: { BASE: '1' } }])
    expect(withChildEnv('spawn', ['ls', ['-l']], decide)).toEqual(['ls', ['-l'], { env: { BASE: '1' } }])
    expect(withChildEnv('spawn', ['ls', ['-l'], { cwd: '/', env: { X: '1', Y: '2' } }], decide)).toEqual(['ls', ['-l'], { cwd: '/', env: { Y: '2' } }])
    const cb = () => {}
    expect(withChildEnv('exec', ['ls', cb], decide)).toEqual(['ls', { env: { BASE: '1' } }, cb])
    expect(withChildEnv('execFile', ['ls', ['-l'], cb], decide)).toEqual(['ls', ['-l'], { env: { BASE: '1' } }, cb])
    expect(withChildEnv('execSync', ['ls', { encoding: 'utf8' }], decide)).toEqual(['ls', { encoding: 'utf8', env: { BASE: '1' } }])
    expect(withChildEnv('spawnSync', ['ls', [], undefined], decide)).toEqual(['ls', [], { env: { BASE: '1' } }])
  })
  it('and for Bun.spawn in both of its shapes', () => {
    expect(withBunEnv([['ls']], decide)).toEqual([['ls'], { env: { BASE: '1' } }])
    expect(withBunEnv([['ls'], { cwd: '/', env: { X: '1', Z: '3' } }], decide)).toEqual([['ls'], { cwd: '/', env: { Z: '3' } }])
    expect(withBunEnv([{ cmd: ['ls'] }], decide)).toEqual([{ cmd: ['ls'], env: { BASE: '1' } }])
  })
})

describe('installSpawnEnvGuard — a child does NOT inherit the dropped keys (QA perf-idle-1 r2)', () => {
  it('every spawn API, with and without an explicit env, in a real process', () => {
    const script = `
      const { installSpawnEnvGuard } = await import(${JSON.stringify(join(import.meta.dir, 'spawn-env.ts'))})
      delete process.env.XDROP_A
      process.env.XLATER = 'set-after-start'
      installSpawnEnvGuard(['XDROP_A', 'XDROP_B'])
      const cp = await import('node:child_process')
      const pick = s => s.split('\\n').filter(l => l.startsWith('XDROP') || l.startsWith('XKEEP') || l.startsWith('XLATER')).sort().join(',')
      const out = {
        bunSync: pick(Bun.spawnSync(['env']).stdout.toString()),
        bunAsync: pick(await new Response(Bun.spawn(['env'], { stdout: 'pipe' }).stdout).text()),
        bunExplicit: pick(Bun.spawnSync(['env'], { env: { ...process.env, XDROP_B: 'x', XKEEP: 'k' } }).stdout.toString()),
        execSync: pick(cp.execSync('env').toString()),
        spawnSync: pick(cp.spawnSync('env').stdout.toString()),
        execFileSync: pick(cp.execFileSync('env').toString()),
        spawn: await new Promise(r => { const c = cp.spawn('env'); let o = ''; c.stdout.on('data', d => o += d); c.on('close', () => r(pick(o))) }),
      }
      console.log(JSON.stringify(out))`
    const r = Bun.spawnSync([process.execPath, '-e', script], { env: { ...process.env, XDROP_A: '2', XDROP_B: '1', XKEEP: 'kept' } })
    const out = JSON.parse(r.stdout.toString().trim().split('\n').pop()!)
    for (const k of ['bunSync', 'bunAsync', 'execSync', 'spawnSync', 'execFileSync', 'spawn']) expect(out[k]).toBe('XKEEP=kept')
    // An explicit env is the caller's, minus the dropped keys — process.env's later edits included.
    expect(out.bunExplicit).toBe('XKEEP=k,XLATER=set-after-start')
  })

  it('promisify(execFile) / promisify(exec) still resolve to { stdout, stderr }, and the child still loses the dropped key', () => {
    const script = `
      const { installSpawnEnvGuard } = await import(${JSON.stringify(join(import.meta.dir, 'spawn-env.ts'))})
      installSpawnEnvGuard(['XDROP_A'])
      const { execFile, exec } = await import('node:child_process')
      const { promisify } = await import('node:util')
      const pick = s => s.split('\\n').filter(l => l.startsWith('XDROP') || l.startsWith('XKEEP')).sort().join(',')
      const a = await promisify(execFile)('env', [], {})
      const b = await promisify(exec)('env')
      const c = await promisify(execFile)('env', [], { env: { ...process.env, XDROP_A: 'x' } })
      console.log(JSON.stringify({ aType: typeof a, a: pick(a.stdout), b: pick(b.stdout), c: pick(c.stdout) }))`
    const r = Bun.spawnSync([process.execPath, '-e', script], { env: { ...process.env, XDROP_A: '2', XKEEP: 'kept' } })
    const out = JSON.parse(r.stdout.toString().trim().split('\n').pop()!)
    expect(out).toEqual({ aType: 'object', a: 'XKEEP=kept', b: 'XKEEP=kept', c: 'XKEEP=kept' })
  })

  it('the delivery gates read gh through the guarded execFile (QA c4: findMergedPr saw "gh did not describe it")', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ghfake-'))
    writeFileSync(join(dir, 'gh'), '#!/bin/sh\necho "FAKE_GH:${XDROP_A:-dropped}"\n', { mode: 0o755 })
    const script = `
      const { installSpawnEnvGuard } = await import(${JSON.stringify(join(import.meta.dir, 'spawn-env.ts'))})
      const { defaultGateFacts } = await import(${JSON.stringify(join(import.meta.dir, 'delivery', 'gates.ts'))})
      installSpawnEnvGuard(['XDROP_A'])
      console.log(JSON.stringify({ out: await defaultGateFacts().gh(${JSON.stringify(dir)}, ['pr', 'view']) }))`
    const r = Bun.spawnSync([process.execPath, '-e', script], { env: { ...process.env, XDROP_A: '1', PATH: `${dir}:${process.env.PATH}` } })
    const out = JSON.parse(r.stdout.toString().trim().split('\n').pop()!)
    expect(typeof out.out).toBe('string')
    expect(out.out.trim()).toBe('FAKE_GH:dropped')
    rmSync(dir, { recursive: true, force: true })
  })
})

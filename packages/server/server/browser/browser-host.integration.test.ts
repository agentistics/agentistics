/**
 * NAVEGADOR S1 — the host against a REAL headless Chromium. Opt-in (`BROWSER_INTEGRATION=1`): it starts
 * a real browser, so it never runs in the ordinary suite. Run it inside a throwaway:
 *
 *   BROWSER_INTEGRATION=1 agentop run --rm -- bun test packages/server/server/browser/browser-host.integration.test.ts
 *
 * One Chromium at a time (the owner's PC is memory-tight), each stopped before the next starts.
 * Proves: spawn over the pipe → navigate a local page → stop by saved PID, leaving NO process whose
 * cmdline names our profile root, NO profile folder and NO record. Then the orphan sweep against a
 * real browser left by a "dead host".
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readMemory } from '../sessions/memory-probe'
import { findBrowserBin } from './browser-bin'
import { createBrowserHost, linuxProc, probeScope, spawnWithPipe } from './browser-host'
import { browserArgv, cmdlineMatches, descendants } from './browser-spec'

const RUN = process.env.BROWSER_INTEGRATION === '1'
const d = RUN ? describe : describe.skip
const log = (...a: unknown[]) => console.log('[browser-it]', ...a)

const dataDir = mkdtempSync(join(tmpdir(), 'browser-it-'))
const root = join(dataDir, 'browser')

/** Every live process whose argv mentions our profile root — must be empty after each stop. */
function processesUnder(prefix: string): number[] {
  const out: number[] = []
  for (const n of readdirSync('/proc')) {
    if (!/^\d+$/.test(n)) continue
    try {
      const cmd = readFileSync(`/proc/${n}/cmdline`, 'utf8')
      if (cmd.includes(prefix)) out.push(Number(n))
    } catch { /* gone */ }
  }
  return out
}

const page = `<!doctype html><html><head><title>Loja de teste</title></head>
<body><form><input id="u" name="u"><button id="go" type="button">Entrar</button></form></body></html>`
const server = RUN ? Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response(page, { headers: { 'content-type': 'text/html' } }) }) : null

afterAll(() => {
  server?.stop(true)
  rmSync(dataDir, { recursive: true, force: true })
})

d('browser host with a real headless shell', () => {
  test('executable is found and status says which', async () => {
    const bin = findBrowserBin()
    log('executable', JSON.stringify(bin))
    expect(bin.found).toBe(true)
    const host = createBrowserHost({ dataDir, agentisticsPorts: [47291, 47292], memAvailable: async () => (await readMemory())?.available ?? null, log })
    const st = await host.status()
    log('status', JSON.stringify({ executable: st.executable.sentence, memory: st.memory, scope: st.scope }))
    expect(st.executable.found).toBe(true)
    expect(st.live).toEqual([])
  })

  test('spawn → navigate a local page → stop by saved PID; nothing left behind', async () => {
    const host = createBrowserHost({ dataDir, agentisticsPorts: [47291, 47292], memAvailable: async () => (await readMemory())?.available ?? null, log })
    const t0 = performance.now()
    const r = await host.start({ kind: 'session', managedId: 'it-1' })
    log('start', JSON.stringify(r), `${Math.round(performance.now() - t0)} ms`)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    try {
    const raw = readFileSync(`/proc/${r.pid}/cmdline`, 'utf8')
    log('saved pid cmdline', raw.replace(/\0/g, ' ').slice(0, 120))
    expect(cmdlineMatches(raw, join(root, 'sessions', 'it-1'))).toBe(true)
    expect(raw).toContain('--remote-debugging-pipe')
    expect(raw).not.toContain('--remote-debugging-port')
    const st = await host.status()
    if (st.live[0]!.scope) {
      const cg = readFileSync(`/proc/${r.pid}/cgroup`, 'utf8')
      log('cgroup', cg.trim())
      expect(cg).toContain('agentop-browser-')
    }
    log('scope', st.live[0]!.scope, 'sandbox', st.live[0]!.sandbox)

    const tree = descendants(r.pid, linuxProc.ppids())
    log('process tree', tree.length, 'processes')
    expect(tree.length).toBeGreaterThan(1)

    const url = `http://127.0.0.1:${server!.port}/login`
    const nav = await host.navigate(r.key, url)
    log('navigate', JSON.stringify(nav))
    expect(nav).toMatchObject({ ok: true, url, title: 'Loja de teste' })

    // A blocked URL is refused by the host, on the real browser too.
    expect(await host.navigate(r.key, 'http://localhost:47291/api/data')).toEqual({ ok: false, reason: 'blocked:agentistics-port' })

    await host.tick()
    const mem = (await host.status()).live[0]!.memory
    log('memory after one tick', JSON.stringify(mem))
    expect(mem?.basis).toBe('pss')

    await host.stop(r.key, 'requested')
    await Bun.sleep(300)
    const left = processesUnder(root)
    log('after stop: processes naming the profile root =', left.length, '; tree alive =', tree.filter(p => existsSync(`/proc/${p}`)).length)
    expect(left).toEqual([])
    expect(tree.filter(p => { try { return !readFileSync(`/proc/${p}/stat`, 'utf8').includes(') Z ') } catch { return false } })).toEqual([])
    expect(existsSync(join(root, 'sessions', 'it-1'))).toBe(false)
    expect(JSON.parse(readFileSync(join(root, 'pids.json'), 'utf8'))).toEqual([])
    } finally {
      await host.stopAll('requested')
    }
  }, 60_000)

  test('orphan sweep: a real browser left by a dead host is killed by its saved PID and its folder deleted', async () => {
    const bin = findBrowserBin()
    if (!bin.found) throw new Error('no browser')
    const dir = join(root, 'sessions', 'orphan')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const orphan = spawnWithPipe(bin.path, browserArgv({ kind: bin.kind, profileDir: dir, noSandbox: true }))
    // Keep its pipe open, as a crashed host's would not be — simulating a browser that outlived its host.
    await Bun.sleep(1500)
    expect(existsSync(`/proc/${orphan.pid}`)).toBe(true)
    writeFileSync(join(root, 'pids.json'), JSON.stringify([{ key: 's-orphan', pid: orphan.pid, profileDir: dir, hostPid: 999_999_9, startedAt: 0 }]))

    const host = createBrowserHost({ dataDir, agentisticsPorts: [47291, 47292], memAvailable: async () => (await readMemory())?.available ?? null, log })
    const plan = await host.sweep()
    log('sweep plan', JSON.stringify(plan))
    if (!plan.kill.length) { try { process.kill(orphan.pid, 'SIGKILL') } catch { /* gone */ } } // never leak, even failing
    expect(plan.kill).toEqual([{ pid: orphan.pid, key: 's-orphan' }])
    await Promise.race([orphan.exited, Bun.sleep(5000)])
    await Bun.sleep(300)
    expect(orphan.hasExited()).toBe(true)
    expect(processesUnder(root)).toEqual([])
    expect(existsSync(dir)).toBe(false)
  }, 30_000)

  test('systemd scope probe is reported (informational)', () => {
    log('probeScope()', probeScope())
  })
})

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { hostAddresses, probeNetns } from './run-netns'

// Integration: a REAL `agentop run --rm` from this checkout. Skipped (with the reason) where the host cannot isolate.
const decision = probeNetns(false)
const skipReason = decision.mode === 'netns' ? null : decision.reason
const CLI = join(import.meta.dir, '..', 'bin', 'cli.ts')

const lanIp = Object.values(networkInterfaces()).flat().find(i => i && i.family === 'IPv4' && !i.internal)?.address
// A listener standing in for the real agentistics: it answers on every address of this machine. The run blocks ITS port
// through the test seam, because a test must never bind (or depend on) the real 47291/47292.
const listener = Bun.listen({ hostname: '0.0.0.0', port: 0, socket: {
  open(s) { s.write('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok'); s.end() },
  data() {}, close() {}, error() {},
} })
afterAll(() => listener.stop(true))

// A killed process whose parent never waits stays a zombie (kill -0 still succeeds); it is dead for this purpose.
const running = (pid: number): boolean => { try { return !/^\d+ \(.*\) [ZX]/.test(readFileSync(`/proc/${pid}/stat`, 'utf8')) } catch { return false } }
const allHostAddrs = hostAddresses().filter(a => !a.startsWith('fe80') && a !== lanIp)
async function inRun(script: string, extra: string[] = [], envExtra: Record<string, string> = {}): Promise<string> {
  const proc = Bun.spawn([process.execPath, CLI, 'run', '--rm', ...extra, '--', 'sh', '-c', script], {
    stdout: 'pipe', stderr: 'pipe',
    env: { ...process.env, AGENTISTICS_RUN_NETNS_EXTRA_PORTS: String(listener.port), AGENTISTICS_RUN_NO_WAIT: '1', AGENTISTICS_FLOWS: '', AGENTISTICS_HEAVY_JOB: '1', ...envExtra },
  })
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  await proc.exited
  return out + '\n' + err
}

const probe = (host: string, port: number) => `printf '%s %s\\n' '${host}:${port}' "$(curl -g -sS -m 3 -o /dev/null -w '%{http_code}' 'http://${host}:${port}/' 2>/dev/null)"`
const codeOf = (out: string, target: string) => new RegExp(`^${target.replace(/[.[\]]/g, '\\$&')} (\\d+)$`, 'm').exec(out)?.[1]

describe.skipIf(skipReason !== null)(`RUN.ISOLAMENTO-REDE: a real network block${skipReason ? ` (skipped: ${skipReason})` : ''}`, () => {
  const P = listener.port
  const targets = ['127.0.0.1', '[::1]', '10.0.2.2', ...(lanIp ? [lanIp] : [])]
  const script = targets.map(t => probe(t, P)).join('; ')

  test('control: WITHOUT the namespace (--no-netns) the stand-in is reachable on loopback — the probes have teeth', async () => {
    const out = await inRun(script, ['--no-netns'])
    expect(codeOf(out, `127.0.0.1:${P}`)).toBe('200')
    expect(out).toMatch(/network NOT isolated/)
  }, 60_000)

  test('inside the namespace curl cannot reach it on 127.0.0.1, [::1], the slirp gateway 10.0.2.2 or the machine\'s own address', async () => {
    const out = await inRun(script)
    for (const t of targets) expect(codeOf(out, `${t}:${P}`)).toBe('000')
    expect(out).not.toMatch(/NOT isolated/)
  }, 60_000)

  test('Bun.connect and node:http are blocked too, not only curl', async () => {
    const js = `
      const net = require('node:net'), http = require('node:http');
      const tryTcp = (host) => new Promise(r => { const s = net.connect({ host, port: ${P} }); s.setTimeout(3000); s.on('connect', () => { s.destroy(); r('open') }); s.on('error', e => r(e.code)); s.on('timeout', () => { s.destroy(); r('timeout') }) });
      const tryHttp = (host) => new Promise(r => { const q = http.get({ host, port: ${P}, timeout: 3000 }, res => { res.resume(); r('200') }); q.on('error', e => r(e.code)); q.on('timeout', () => { q.destroy(); r('timeout') }) });
      (async () => {
        for (const h of ${JSON.stringify(targets.map(t => t.replace(/[[\]]/g, '')))}) console.log('net', h, await tryTcp(h), await tryHttp(h));
        try { const c = await Bun.connect({ hostname: '127.0.0.1', port: ${P}, socket: { data() {}, open() {} } }); console.log('bun open'); c.end() } catch (e) { console.log('bun', e.code ?? 'error') }
      })()`
    const proc = Bun.spawn([process.execPath, CLI, 'run', '--rm', '--', process.execPath, '-e', js], {
      stdout: 'pipe', stderr: 'pipe', env: { ...process.env, AGENTISTICS_RUN_NETNS_EXTRA_PORTS: String(P), AGENTISTICS_RUN_NO_WAIT: '1', AGENTISTICS_FLOWS: '', AGENTISTICS_HEAVY_JOB: '1' },
    })
    const out = await new Response(proc.stdout).text()
    await proc.exited
    expect(out).not.toMatch(/\bopen\b/)
    expect(out).not.toMatch(/\b200\b/)
    expect(out).toMatch(/^bun /m)
    for (const h of targets) expect(out).toContain(`net ${h.replace(/[[\]]/g, '')} `)
  }, 60_000)

  test('files written inside are owned by the real user and `id` says so', async () => {
    const out = await inRun(`id -u; touch "$TMPDIR/owned" && stat -c %u "$TMPDIR/owned"`)
    const uid = String(process.getuid!())
    expect(out.split('\n').filter(l => /^\d+$/.test(l))).toEqual([uid, uid])
  }, 60_000)

  test('the nested user namespace cannot drop the firewall (no capability over the run\'s network namespace)', async () => {
    const out = await inRun(`nft flush ruleset 2>&1 | head -1; ${probe('127.0.0.1', P)}; ${lanIp ? probe(lanIp, P) : ''}`)
    expect(out).toMatch(/Operation not permitted|command not found|Permission denied|must be root/i)
    if (lanIp) expect(codeOf(out, `${lanIp}:${P}`)).toBe('000')
  }, 60_000)

  test('the outside world still works through slirp: DNS + HTTPS (when this machine is online)', async () => {
    const online = Bun.spawnSync(['curl', '-sS', '-m', '5', '-o', '/dev/null', '-w', '%{http_code}', 'https://registry.npmjs.org/']).stdout.toString() === '200'
    if (!online) return
    const out = await inRun(`curl -sS -m 10 -o /dev/null -w 'https %{http_code}\\n' https://registry.npmjs.org/`)
    expect(out).toMatch(/^https 200$/m)
  }, 60_000)

  // B1 (QA r1): `tailscale serve :8443 -> 127.0.0.1:47292` reached the real server through the NAT because the rule was by PORT.
  // A stand-in PROXY on another port of 0.0.0.0 that forwards to the blocked port must be unreachable BY ITS ADDRESS too.
  test('a local PROXY on another port that forwards to the blocked port is unreachable too (destination, not port)', async () => {
    const proxy = Bun.listen({ hostname: '0.0.0.0', port: 0, socket: {
      async open(s) {
        const up = await Bun.connect({ hostname: '127.0.0.1', port: listener.port, socket: { data(_u, d) { s.write(d); s.end() }, close() {}, error() {} } })
        up.write('GET / HTTP/1.0\r\n\r\n')
      }, data() {}, close() {}, error() {},
    } })
    try {
      const Q = proxy.port
      const hosts = ['127.0.0.1', ...(lanIp ? [lanIp] : []), ...allHostAddrs]
      const probes = hosts.map(h => probe(h.includes(':') ? `[${h}]` : h, Q)).join('; ')
      const outside = await inRun(probes, ['--no-netns'])
      expect(outside).toContain(`127.0.0.1:${Q} 200`) // control: the proxy works when nothing blocks it
      const out = await inRun(probes)
      for (const h of hosts) { const k = `${h.includes(':') ? `[${h}]` : h}:${Q}`; expect(codeOf(out, k)).toBe('000') }
    } finally { proxy.stop(true) }
  }, 120_000)

  // R1
  test('the real server\'s unix sockets (data dir run/ + structured/) and its pid are not visible from inside', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agdir-'))
    mkdirSync(join(dir, 'run')); mkdirSync(join(dir, 'structured'))
    const sock = join(dir, 'run', 'runtime.sock')
    const srv = Bun.listen({ unix: sock, socket: { open(s) { s.end() }, data() {}, close() {}, error() {} } })
    try {
      const script = `[ -e '${sock}' ] && echo SOCK-VISIBLE || echo SOCK-HIDDEN; kill -0 ${process.pid} 2>/dev/null && echo PID-SIGNALABLE || echo PID-GONE; [ -d /proc/${process.pid} ] && echo PID-LISTED || echo PID-UNLISTED`
      const env = { AGENTISTICS_DIR: dir }
      const open = await inRun(script, ['--no-netns'], env)
      expect(open).toContain('SOCK-VISIBLE'); expect(open).toContain('PID-SIGNALABLE') // control
      const out = await inRun(script, [], env)
      expect(out).toContain('SOCK-HIDDEN'); expect(out).toContain('PID-GONE'); expect(out).toContain('PID-UNLISTED')
    } finally { srv.stop(true); rmSync(dir, { recursive: true, force: true }) }
  }, 120_000)

  // R2.2
  test('slirp4netns dies with its launcher even when the launcher is SIGKILLed (--exit-fd)', async () => {
    const name = `exitfd-${process.pid}`
    const proc = Bun.spawn([process.execPath, CLI, 'run', '--rm', '--name', name, '--', 'sleep', '30'], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, AGENTISTICS_RUN_NO_WAIT: '1', AGENTISTICS_FLOWS: '', AGENTISTICS_HEAVY_JOB: '1' } })
    const stateFile = join(process.env.HOME!, '.cache', 'agentistics-throwaway', `${name}.json`)
    let slirpPid = 0, runPid = 0
    for (let i = 0; i < 200 && !slirpPid; i++) { try { const s = JSON.parse(readFileSync(stateFile, 'utf8')); slirpPid = s.slirpPid ?? 0; runPid = s.pid ?? 0 } catch {} ; await Bun.sleep(100) }
    try {
      expect(slirpPid).toBeGreaterThan(0)
      proc.kill('SIGKILL')
      let gone = false
      for (let i = 0; i < 50 && !gone; i++) { gone = !running(slirpPid); if (!gone) await Bun.sleep(100) }
      expect(gone).toBe(true)
    } finally {
      if (slirpPid > 1) try { process.kill(slirpPid, 'SIGKILL') } catch {}
      const stop = Bun.spawnSync([process.execPath, CLI, 'run', 'stop', name], { env: { ...process.env, AGENTISTICS_FLOWS: '', AGENTISTICS_HEAVY_JOB: '1' } }); void stop
      if (runPid > 1) try { process.kill(runPid, 'SIGKILL') } catch {}
    }
  }, 60_000)
})

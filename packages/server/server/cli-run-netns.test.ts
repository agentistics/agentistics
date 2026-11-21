import { afterAll, describe, expect, test } from 'bun:test'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { probeNetns } from './run-netns'

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

async function inRun(script: string, extra: string[] = []): Promise<string> {
  const proc = Bun.spawn([process.execPath, CLI, 'run', '--rm', ...extra, '--', 'sh', '-c', script], {
    stdout: 'pipe', stderr: 'pipe',
    env: { ...process.env, AGENTISTICS_RUN_NETNS_EXTRA_PORTS: String(listener.port), AGENTISTICS_RUN_NO_WAIT: '1', AGENTISTICS_FLOWS: '' },
  })
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  await proc.exited
  return out + '\n' + err
}

const probe = (host: string, port: number) => `printf '%s ' '${host}:${port}'; curl -g -sS -m 3 -o /dev/null -w '%{http_code}\\n' 'http://${host}:${port}/' 2>/dev/null || true`
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
      stdout: 'pipe', stderr: 'pipe', env: { ...process.env, AGENTISTICS_RUN_NETNS_EXTRA_PORTS: String(P), AGENTISTICS_RUN_NO_WAIT: '1', AGENTISTICS_FLOWS: '' },
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
})

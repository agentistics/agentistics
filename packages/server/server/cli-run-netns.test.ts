import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

  // r3 R1: refused at once (exit 7) means the REJECT rule matched; a timeout (28) means nothing stopped the packet. 203.0.113.1 (TEST-NET-3, public range) is the control.
  test('R1: connections to an address in a private range that does not exist on the host (a bridge created later) are rejected on the spot', async () => {
    const out = await inRun(`for a in 172.31.250.77 192.168.250.77 10.250.250.77 100.100.250.77 169.254.250.77; do printf '%s %s\\n' $a "$(curl -sS -m 4 -o /dev/null http://$a:48555/ >/dev/null 2>&1; echo $?)"; done; printf 'control %s\\n' "$(curl -sS -m 2 -o /dev/null http://203.0.113.1:48555/ >/dev/null 2>&1; echo $?)"`)
    for (const a of ['172.31.250.77', '192.168.250.77', '10.250.250.77', '100.100.250.77', '169.254.250.77']) expect(out).toMatch(new RegExp(`^${a.replace(/\./g, '\\.')} 7$`, 'm'))
    expect(out).toMatch(/^control (28|7)$/m) // a public address is not rejected by the firewall: it times out (or is unroutable), never matches by accident
  }, 60_000)

  // r3 B1
  const userManager = Bun.spawnSync(['systemd-run', '--user', '--quiet', '--pipe', '--wait', 'true'], { stdout: 'ignore', stderr: 'ignore' }).exitCode === 0
  test.skipIf(!userManager)('B1: the user systemd manager / D-Bus is unreachable (systemd-run --user and systemctl --user fail; the control without the namespace works)', async () => {
    const script = `systemd-run --user --quiet --pipe --wait true >/dev/null 2>&1; echo run=$?; systemctl --user is-system-running >/dev/null 2>&1; echo ctl=$?; echo bus=[$DBUS_SESSION_BUS_ADDRESS]; ls -A "\${XDG_RUNTIME_DIR:-/run/user/$(id -u)}" | wc -l | sed 's/^/entries=/'`
    const control = await inRun(script, ['--no-netns'])
    expect(control).toContain('run=0')
    const out = await inRun(script)
    expect(out).toMatch(/^run=[1-9]\d*$/m)
    expect(out).toMatch(/^ctl=[1-9]\d*$/m)
    expect(out).toContain('bus=[]')
    expect(out).toContain('entries=0')
  }, 120_000)

  const connectJs = (path: string) => `bun -e "require('node:net').connect('${path}').on('connect',()=>{console.log('CONNECTED');process.exit(0)}).on('error',e=>{console.log('REFUSED '+e.code);process.exit(0)})"`
  test('B1 (stand-in, works even when this test itself runs inside a run): sockets in the user runtime dir (bus, cc-socks) vanish and the bus variable is unset', async () => {
    const rt = mkdtempSync(join(tmpdir(), 'xdg-rt-'))
    mkdirSync(join(rt, 'cc-socks'))
    const socks = [join(rt, 'bus'), join(rt, 'cc-socks', '1.sock')].map(p => Bun.listen({ unix: p, socket: { open() {}, data() {}, close() {}, error() {} } }))
    try {
      const script = `echo bus=[$DBUS_SESSION_BUS_ADDRESS]; ${connectJs(join(rt, 'bus'))}; ${connectJs(join(rt, 'cc-socks', '1.sock'))}`
      const env = { XDG_RUNTIME_DIR: rt, DBUS_SESSION_BUS_ADDRESS: `unix:path=${rt}/bus` }
      const control = await inRun(script, ['--no-netns'], env)
      expect(control.match(/CONNECTED/g)).toHaveLength(2)
      const out = await inRun(script, [], env)
      expect(out).not.toContain('CONNECTED'); expect(out.match(/REFUSED/g)).toHaveLength(2); expect(out).toContain('bus=[]')
    } finally { for (const s of socks) s.stop(true); rmSync(rt, { recursive: true, force: true }) }
  }, 120_000)

  // r3 B2 / R2: a unix socket standing in for an engine / agent. Container engines are probed for real where they exist.
  test('B2/R2: an ssh-agent style socket in /tmp and SSH_AUTH_SOCK are unreachable inside, reachable outside', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ssh-XXXXXXqa'))
    const sock = join(dir, `agent.${process.pid}`)
    const srv = Bun.listen({ unix: sock, socket: { open() {}, data() {}, close() {}, error() {} } })
    try {
      const script = `echo agent=[$SSH_AUTH_SOCK]; ${connectJs(sock)}`
      const control = await inRun(script, ['--no-netns'], { SSH_AUTH_SOCK: sock })
      expect(control).toContain('CONNECTED')
      const out = await inRun(script, [], { SSH_AUTH_SOCK: sock })
      expect(out).toContain('REFUSED'); expect(out).not.toContain('CONNECTED'); expect(out).toContain('agent=[]')
    } finally { srv.stop(true); rmSync(dir, { recursive: true, force: true }) }
  }, 120_000)
  test.skipIf(!existsSync('/var/run/docker.sock') && !existsSync('/run/docker.sock'))('B2: the Docker engine socket is unreachable inside (docker group members would otherwise own the host)', async () => {
    const script = `${connectJs('/var/run/docker.sock')}; ${connectJs('/run/docker.sock')}; docker ps >/dev/null 2>&1; echo docker=$?`
    const out = await inRun(script)
    expect(out).not.toContain('CONNECTED')
    expect(out).toMatch(/^docker=[1-9]\d*$/m)
  }, 120_000)

  // r3 R2: the real store dir is not writable from inside (a bind of it, read-only), and the control outside is writable
  test('R2: the real data dir is read-only inside the run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agdir-'))
    mkdirSync(join(dir, 'run'))
    try {
      const script = `( : > '${dir}/zz-probe' ) 2>/dev/null && echo WRITABLE || echo READONLY`
      const control = await inRun(script, ['--no-netns'], { AGENTISTICS_DIR: dir })
      expect(control).toContain('WRITABLE')
      rmSync(join(dir, 'zz-probe'), { force: true })
      const out = await inRun(script, [], { AGENTISTICS_DIR: dir })
      expect(out).toContain('READONLY')
      expect(existsSync(join(dir, 'zz-probe'))).toBe(false)
    } finally { rmSync(dir, { recursive: true, force: true }) }
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

  // r4 N2: the socket is RECREATED at the same path after the launch (an agent restart). The old file-level cover is undone by the unlink; a hidden DIRECTORY is not.
  const recreated = async (extra: string[]): Promise<string> => {
    const dir = mkdtempSync('/tmp/ssh-XXXXXXr4')
    const sock = join(dir, `agent.${process.pid}`)
    const flag = join(tmpdir(), `r4flag-${process.pid}-${extra.length}`)
    const listen = () => Bun.listen({ unix: sock, socket: { open() {}, data() {}, close() {}, error() {} } })
    let srv = listen()
    const script = `echo before; ${connectJs(sock)}; i=0; while [ ! -e '${flag}' ] && [ $i -lt 100 ]; do i=$((i+1)); sleep 0.1; done; echo after; ${connectJs(sock)}`
    const run = inRun(script, extra)
    try {
      await Bun.sleep(3500)
      srv.stop(true); rmSync(sock, { force: true }); srv = listen()
      writeFileSync(flag, '1')
      return await run
    } finally { srv.stop(true); rmSync(dir, { recursive: true, force: true }); rmSync(flag, { force: true }) }
  }
  test('N2: an ssh-agent socket recreated AFTER the launch stays unreachable (the directory is hidden, not the file); control: without the namespace it connects', async () => {
    expect(await recreated(['--no-netns'])).toMatch(/after\nCONNECTED/)
    const out = await recreated([])
    expect(out).toMatch(/before\nREFUSED/); expect(out).toMatch(/after\nREFUSED/); expect(out).not.toContain('CONNECTED')
  }, 120_000)
  test('N2 (mutant guard): an ssh-agent under /tmp/ssh-* is hidden even though SSH_AUTH_SOCK points elsewhere', async () => {
    const dir = mkdtempSync('/tmp/ssh-XXXXXXr4b')
    const sock = join(dir, `agent.${process.pid}`)
    const srv = Bun.listen({ unix: sock, socket: { open() {}, data() {}, close() {}, error() {} } })
    try {
      expect(await inRun(connectJs(sock), ['--no-netns'], { SSH_AUTH_SOCK: '' })).toContain('CONNECTED')
      const out = await inRun(connectJs(sock), [], { SSH_AUTH_SOCK: '' })
      expect(out).toContain('REFUSED'); expect(out).not.toContain('CONNECTED')
    } finally { srv.stop(true); rmSync(dir, { recursive: true, force: true }) }
  }, 120_000)

  // r4 N1: the WSL interop channel runs a Windows executable OUTSIDE every namespace (curl.exe reached the real server, wsl.exe reached the host's Linux root)
  const interop = existsSync('/proc/sys/fs/binfmt_misc/WSLInterop') || existsSync('/proc/sys/fs/binfmt_misc/WSLInterop-late')
  test.skipIf(!interop)('N1: cmd.exe, curl.exe and wsl.exe cannot be run from inside; control: they run without the namespace', async () => {
    const wsl = Bun.spawnSync(['sh', '-c', 'command -v wsl.exe'], { stdout: 'pipe' }).stdout.toString().trim()
    const script = `echo WSL_INTEROP=[$WSL_INTEROP]; for e in /mnt/c/Windows/System32/cmd.exe /mnt/c/Windows/System32/curl.exe ${wsl || '/mnt/c/Windows/System32/wsl.exe'}; do case $e in *wsl.exe) a="-e echo ESCAPED";; *cmd.exe) a="/c echo ESCAPED";; *) a="--version";; esac; out=$(timeout 8 $e $a 2>/dev/null); echo "$(basename $e) rc=$? out=[$(echo $out | head -c 40)]"; done`
    const control = await inRun(script, ['--no-netns'])
    expect(control).toMatch(/cmd\.exe rc=0 out=\[ESCAPED/)
    const out = await inRun(script)
    expect(out).toContain('WSL_INTEROP=[]')
    expect(out).not.toContain('ESCAPED')
    expect(out).not.toMatch(/(cmd|curl|wsl)\.exe rc=0/)
  }, 120_000)

  // r4 N4: the slirp API socket (add_hostfwd 0.0.0.0 would publish a port on the LAN) is not visible from inside
  test('N4: no slirp control socket is visible inside the run, from /tmp or the runtime dir', async () => {
    const out = await inRun(`n=0; for d in /tmp "\${XDG_RUNTIME_DIR:-/nonexistent}" /run/user/*; do n=$((n + $(find "$d" -maxdepth 3 -path '*agr-ctl-*' -name 'slirp.sock' 2>/dev/null | wc -l))); done; echo slirp-sockets=$n; ls -d /run/user/*/agr-ctl-* "\${XDG_RUNTIME_DIR:-/nonexistent}"/agr-ctl-* 2>/dev/null | wc -l`)
    expect(out).toMatch(/^slirp-sockets=0$/m)
    expect(out).toMatch(/^0$/m)
  }, 60_000)

  // r4 N3 (live): benchmark / reserved ranges are rejected on the spot, whatever exists on the host now
  test('N3: 198.18/15 (a docker bridge in a non-private pool) and 240/4 are rejected at once', async () => {
    const out = await inRun(`for a in 198.18.250.77 198.19.250.77 240.1.2.3; do printf '%s %s\\n' $a "$(curl -sS -m 4 -o /dev/null http://$a:48555/ >/dev/null 2>&1; echo $?)"; done`)
    for (const a of ['198.18.250.77', '198.19.250.77', '240.1.2.3']) expect(out).toMatch(new RegExp(`^${a.replace(/\./g, '\\.')} 7$`, 'm'))
  }, 60_000)
})

/**
 * DOCKER.AMBIENTES S2 — P7 LIVE (SPEC-r3 §3.6): the network proof with the REAL app as bait (not part of `bun test`).
 *
 *   bun packages/server/server/docker-env/s2-p7.testing.ts > <log>
 *
 * Bait: `agentop run --rm --serve` (the installed app, profile local) on a 481xx port, plus a COUNTING forwarder on
 * 0.0.0.0/:: that relays to it — so any connection that reaches the app from any host address is counted.
 * From a command container (`--network none`): direct TCP to every host address, the bridge gateways and
 * host.docker.internal. From a download container (the only one with the egress proxy): the same direct TCP, plus
 * every proxy request of §3.6. Expected: everything refused with a reason, ZERO connections at the bait, and the
 * positive control `CONNECT registry.npmjs.org:443` passes. 47291/47292 are only ever DECIDED (proxy), never dialled.
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { connect, createServer } from 'node:net'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { ENV_IMAGES } from '@agentistics/core'
import { ensureVolumes, identify, makeCtx, ensureImage, runCommand, workspaceSlots, GIB, type DockerRunInput } from './docker-run'
import { startEgressProxy } from './egress-proxy'
import { readLedger, installId } from './ledger'

const PREFIX = 'agentistics-s2-test'
const BUN = ENV_IMAGES.find(i => i.key === 'bun-1.3')!
const dk = (...a: string[]) => spawnSync('docker', a, { encoding: 'utf8', timeout: 120_000 })
const results: { name: string; ok: boolean; detail: string }[] = []
const check = (name: string, ok: boolean, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`) }

const base = mkdtempSync('/tmp/agentistics-s2-test-p7-')
const data = join(base, 'data'); const repo = join(base, 'repo')
mkdirSync(data); mkdirSync(repo)
spawnSync('git', ['init', '-q', repo])
writeFileSync(join(repo, 'package.json'), '{"name":"p7"}')
const SID = 'p7sess'
writeFileSync(join(data, 'managed-sessions.json'), JSON.stringify([{ id: SID, cwd: repo }]))
const hadImage = dk('image', 'inspect', BUN.ref).status === 0
const env = { ...process.env, AGENTISTICS_DOCKER_PREFIX: PREFIX, AGENTOP_MANAGED_ID: SID } as Record<string, string | undefined>
const input = (over: Partial<DockerRunInput> = {}): DockerRunInput => ({ command: [], cwd: repo, ttlSec: 120, dataDir: data, env, memAvailable: () => 10 * GIB, memTotal: () => 12 * GIB, tmuxPanes: () => `agentop-${SID}\t${process.pid}\n`, ...over })

// ---- the bait: the real app, served by the installed agentop in a throwaway ----
const baitName = `${PREFIX}-bait-${process.pid}`
const bait = spawn('agentop', ['run', '--rm', '--serve', '--name', baitName, '--ttl', '20m'], { stdio: ['ignore', 'pipe', 'pipe'], env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'AGENTISTICS_FLOWS')) as any })
let baitOut = ''
bait.stdout!.on('data', d => { baitOut += d }); bait.stderr!.on('data', d => { baitOut += d })
let apiPort = 0
for (let i = 0; i < 120 && !apiPort; i++) { await Bun.sleep(1000); const m = /api:\s+http:\/\/localhost:(\d+)/.exec(baitOut); if (m) apiPort = Number(m[1]) }
let healthy = false
for (let i = 0; i < 90 && apiPort && !healthy; i++) { await Bun.sleep(1000); try { healthy = (await fetch(`http://127.0.0.1:${apiPort}/api/health`, { signal: AbortSignal.timeout(2000) })).ok } catch {} }
check('bait: the real app answers /api/health on the host (positive control)', healthy, `api port ${apiPort}`)

// counting relay on every address (0.0.0.0 and ::) → the bait
let hits = 0
const relayPort = 48190 + (process.pid % 7)
const relay = (host: string) => createServer(c => { hits++; const up = connect({ host: '127.0.0.1', port: apiPort }); c.pipe(up); up.pipe(c); c.on('error', () => up.destroy()); up.on('error', () => c.destroy()) }).listen(relayPort, host)
const relays = [relay('0.0.0.0'), relay('::')]
await Bun.sleep(300)
const hostV4 = Object.values(networkInterfaces()).flat().filter(a => a && a.family === 'IPv4').map(a => a!.address)
const hostV6 = Object.values(networkInterfaces()).flat().filter(a => a && a.family === 'IPv6').map(a => a!.address.split('%')[0]!)
const r0 = await new Promise<boolean>(res => { const s = connect({ host: hostV4.find(a => a !== '127.0.0.1')!, port: relayPort }); s.on('connect', () => { s.destroy(); res(true) }); s.on('error', () => res(false)) })
check('bait relay reachable from the host on a LAN address (so a miss below is the container, not the bait)', r0)
const hitsBaseline = hits

// ---- the probe the containers run (node API under bun) ----
const targets = [...hostV4.map(h => ({ host: h, port: relayPort })), ...hostV4.map(h => ({ host: h, port: apiPort })), ...hostV6.map(h => ({ host: h, port: relayPort })), { host: 'host.docker.internal', port: relayPort }, { host: 'localhost', port: apiPort }]
const proxyReqs = [
  'CONNECT 127.0.0.1:443', `CONNECT 127.0.0.1:${apiPort}`, 'CONNECT localhost:443', 'CONNECT 0.0.0.0:443', 'CONNECT [::1]:443', 'CONNECT [::ffff:127.0.0.1]:443',
  'CONNECT 2130706433:443', `CONNECT ${hostV4.find(a => a.startsWith('172.2')) ?? hostV4[1]}:443`, 'CONNECT 172.17.0.1:443', 'CONNECT host.docker.internal:443',
  'CONNECT registry.npmjs.org:47291', 'CONNECT registry.npmjs.org:47292', 'CONNECT registry.yarnpkg.com:443',
  `GET http://127.0.0.1:${apiPort}/api/health`, `GET http://registry.npmjs.org/ HOSTFORGE`, `GET http://127.0.0.1:${apiPort}/api/fleet/input WS`,
  'CONNECT registry.npmjs.org:443',
]
writeFileSync(join(repo, 'p7-probe.mjs'), `import net from 'node:net'
const [targets, reqs] = [JSON.parse(process.argv[2]), JSON.parse(process.argv[3] ?? '[]')]
const tcp = t => new Promise(r => { const s = net.connect({ host: t.host, port: t.port }); const done = v => { s.destroy(); r(v) }; s.on('connect', () => done('CONNECTED')); s.on('error', e => done('refused:' + (e.code || e.message))); setTimeout(() => done('timeout'), 3000) })
for (const t of targets) console.log('TCP', t.host + ':' + t.port, await tcp(t))
const viaProxy = line => new Promise(r => {
  const s = net.connect({ host: '127.0.0.1', port: 3128 }); let out = ''
  const [l, extra] = [line.replace(/ (HOSTFORGE|WS)$/, ''), line.match(/ (HOSTFORGE|WS)$/)?.[1]]
  const headers = extra === 'HOSTFORGE' ? 'Host: 127.0.0.1:47291\\r\\n' : extra === 'WS' ? 'Host: 127.0.0.1\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\n' : ''
  s.on('connect', () => s.write(l + ' HTTP/1.1\\r\\n' + headers + '\\r\\n'))
  s.on('data', d => { out += d; if (out.includes('\\r\\n')) { s.destroy() } })
  s.on('close', () => r(out.split('\\r\\n')[0] + ' | ' + (out.split('\\r\\n\\r\\n')[1] || '').trim().slice(0, 120)))
  s.on('error', e => r('error:' + e.code)); setTimeout(() => { s.destroy() }, 8000)
})
for (const q of reqs) console.log('PROXY', q, '=>', await viaProxy(q))
`)
const outOf = (name: string) => { try { return readFileSync(join(data, 'docker', 'saida', SID, name), 'utf8') } catch { return '' } }

try {
  const c = makeCtx(data, env, BUN, s => console.log(s))
  check('catalogue image ready', ensureImage(c) === null)
  const who = identify(input())
  const slots = workspaceSlots(repo)
  const vols = ensureVolumes(c, who.sid, who.perRun, slots)
  if (!vols.ok) throw new Error(vols.reason)
  // A. command container: no network at all
  const a = await runCommand(c, input({ command: ['sh', '-c', `bun p7-probe.mjs '${JSON.stringify(targets)}' '[]' > /saida/a.txt 2>&1`] }), who, repo, true, slots, vols.volumes, 512 * 1024 * 1024, {})
  const aText = outOf('a.txt')
  const aLines = aText.split('\n').filter(l => l.startsWith('TCP'))
  check('command container ran the probe', a.ran === true && aLines.length === targets.length, `${aLines.length}/${targets.length}`)
  check('command container: every direct TCP to a host address, gateway, host.docker.internal fails', aLines.length > 0 && aLines.every(l => !/CONNECTED/.test(l)), aLines.slice(0, 4).join(' ; '))
  // B. download container: the egress proxy is its only way out
  const sockDir = join(data, 'docker', 'run', SID, 'egress-p7'); mkdirSync(sockDir, { recursive: true, mode: 0o700 })
  const journal = join(base, 'egress.jsonl')
  const realLookup = async (h: string) => (await (await import('node:dns/promises')).lookup(h, { all: true })).map(x => x.address)
  const proxy = await startEgressProxy({ socketPath: join(sockDir, 'egress.sock'), allow: ['registry.npmjs.org', 'registry.yarnpkg.com'], journal, resolve: async h => h === 'registry.yarnpkg.com' ? ['127.0.0.1'] : realLookup(h) })
  try {
    await runCommand(c, input({ command: ['sh', '-c', `bun /opt/agentistics/fwd.mjs out 3128 /run/agentistics/egress.sock & sleep 0.5; bun p7-probe.mjs '${JSON.stringify(targets)}' '${JSON.stringify(proxyReqs)}'`], kind: 'install-download', sockDir }), who, repo, true, slots, vols.volumes, 512 * 1024 * 1024, {})
    // install-download has no /saida and a read-only worktree: its probe prints to this log (start -a); the journal is the record.
  } finally { proxy.close() }
  const j = (() => { try { return readFileSync(journal, 'utf8').trim().split('\n').map(l => JSON.parse(l)) } catch { return [] } })()
  const refusedJ = j.filter(e => e.decision === 'refuse')
  const allowedJ = j.filter(e => e.decision === 'allow')
  check('download container: every hostile proxy request refused with a reason (journal)', refusedJ.length === proxyReqs.length - 1 && refusedJ.every(e => e.reason), `${refusedJ.length} refused: ${refusedJ.map(e => `${e.host}:${e.port} ${e.reason}`).join(' | ').slice(0, 900)}`)
  check('positive control: CONNECT registry.npmjs.org:443 allowed to a public address', allowedJ.length === 1 && allowedJ[0].host === 'registry.npmjs.org', JSON.stringify(allowedJ))
  check('47291/47292: decided (refused by port) without dialling', refusedJ.filter(e => e.port === 47291 || e.port === 47292).length === 2)
  check('an allowed host whose (injected) DNS answers 127.0.0.1 is refused', refusedJ.some(e => e.host === 'registry.yarnpkg.com' && /private or host address/.test(e.reason)))
  check('ZERO connections reached the bait from any container', hits === hitsBaseline, `relay hits during the containers: ${hits - hitsBaseline}`)
} catch (e) {
  check('p7 threw', false, e instanceof Error ? e.stack ?? e.message : String(e))
} finally {
  for (const r of relays) r.close()
  spawnSync('agentop', ['run', 'stop', baitName], { encoding: 'utf8', timeout: 60_000 })
  try { if (bait.exitCode === null) bait.kill('SIGTERM') } catch {}
  const inst = installId(data)
  for (const id of dk('ps', '-aq', '--filter', `label=agentistics.install=${inst}`).stdout.trim().split('\n').filter(Boolean)) dk('rm', '-f', id)
  for (const s of Object.values(readLedger(data).sessions)) for (const v of s.volumes) if (v.name.startsWith(`${PREFIX}-`)) dk('volume', 'rm', v.name)
  if (!hadImage) { const imgId = dk('image', 'inspect', '--format', '{{.Id}}', BUN.ref).stdout.trim(); if (imgId) spawnSync('docker', ['image', 'rm', imgId]) }
  const leftC = dk('ps', '-aq', '--filter', `label=agentistics.install=${inst}`).stdout.trim()
  const leftV = dk('volume', 'ls', '-q', '--filter', `label=agentistics.install=${inst}`).stdout.trim()
  check('cleanup: no container, no volume of this run; bait stopped', leftC === '' && leftV === '', `c=${leftC || 0} v=${leftV || 0}`)
  rmSync(base, { recursive: true, force: true })
  const fail = results.filter(r => !r.ok).length
  console.log(`\nRESULT ${results.length - fail} pass, ${fail} fail`)
  process.exit(fail ? 1 : 0)
}

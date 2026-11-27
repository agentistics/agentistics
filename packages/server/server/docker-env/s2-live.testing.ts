/**
 * DOCKER.AMBIENTES S2 — LIVE proofs against the real Docker Engine (not part of `bun test`).
 *
 *   bun packages/server/server/docker-env/s2-live.testing.ts > <log>
 *
 * Everything it creates is named `agentistics-s2-test-*` (AGENTISTICS_DOCKER_PREFIX), lives under a throwaway
 * data dir in /tmp, and is removed at the end BY ID / by the names its own ledger recorded. It pulls only the
 * catalogue `bun-1.3` digest, and removes that image at the end only if it was not present before.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ENV_IMAGES } from '@agentistics/core'
import { runInDocker, GIB, type DockerRunInput } from './docker-run'
import { readLedger, installId } from './ledger'

const PREFIX = 'agentistics-s2-test'
const BUN = ENV_IMAGES.find(i => i.key === 'bun-1.3')!
const sh = (cmd: string, args: string[]) => spawnSync(cmd, args, { encoding: 'utf8', timeout: 120_000 })
const dk = (...a: string[]) => sh('docker', a)

// ---- launcher mode (a separate process the main script can kill -9) ----
if (process.argv[2] === 'launcher') {
  const o = JSON.parse(process.argv[3]!) as { input: Partial<DockerRunInput>; rootPid?: number }
  const r = await runInDocker({
    ...(o.input as DockerRunInput), env: { ...process.env, ...(o.input.env ?? {}) } as any,
    memAvailable: () => 10 * GIB, memTotal: () => 12 * GIB,
    ...(o.rootPid ? { tmuxPanes: () => `agentop-${o.input.env?.AGENTOP_MANAGED_ID}\t${o.rootPid}\n` } : {}),
  })
  console.log(`LAUNCHER-RESULT ${JSON.stringify(r)}`)
  process.exit(r.ran ? r.code : 99)
}

const results: { name: string; ok: boolean; detail: string }[] = []
const check = (name: string, ok: boolean, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`) }

const base = mkdtempSync('/tmp/agentistics-s2-test-')
const data = join(base, 'data'); const repo = join(base, 'repo')
mkdirSync(data); mkdirSync(join(repo, 'packages', 'core'), { recursive: true })
sh('git', ['init', '-q', repo])
writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'fixture', workspaces: ['packages/*'] }))
writeFileSync(join(repo, 'packages', 'core', 'package.json'), '{"name":"core"}')
writeFileSync(join(repo, '.env'), 'API=SENTINELA-ENV-1\n')
writeFileSync(join(repo, '.npmrc'), '//registry.npmjs.org/:_authToken=SENTINELA-NPMRC\n')
writeFileSync(join(repo, '.git', 'FETCH_HEAD'), 'abc\t\tbranch x of https://u:SENTINELA-FETCH@github.com/o/r\n')
mkdirSync(join(repo, '.git', 'modules', 'x'), { recursive: true }); writeFileSync(join(repo, '.git', 'modules', 'x', 'config'), 'url = https://u:SENTINELA-MOD@x\n')
sh('git', ['-C', repo, 'config', 'remote.origin.url', 'https://u:SENTINELA-CFG@github.com/o/r'])
writeFileSync(join(repo, 'index.ts'), 'console.log(1)\n')
const SID = 'livesessA'
writeFileSync(join(data, 'managed-sessions.json'), JSON.stringify([{ id: SID, cwd: repo }, { id: 'livesessB', cwd: repo }]))
const hadImage = dk('image', 'inspect', BUN.ref).status === 0
const SENT = { GITHUB_TOKEN: 'SENTINELA-1', GH_TOKEN: 'SENTINELA-2', NPM_TOKEN: 'SENTINELA-3', AWS_SECRET_ACCESS_KEY: 'SENTINELA-4', ANTHROPIC_API_KEY: 'SENTINELA-5', OPENAI_API_KEY: 'SENTINELA-6' }
const env = { ...process.env, AGENTISTICS_DOCKER_PREFIX: PREFIX, ...SENT, AGENTOP_MANAGED_ID: SID } as Record<string, string | undefined>
const input = (command: string[], over: Partial<DockerRunInput> = {}): DockerRunInput => ({
  command, cwd: repo, ttlSec: 120, dataDir: data, env, memAvailable: () => 10 * GIB, memTotal: () => 12 * GIB,
  memoryBytes: 512 * 1024 * 1024, tmuxPanes: () => `agentop-${SID}\t${process.pid}\n`, ...over,
})
const capture = async (command: string[], over: Partial<DockerRunInput> = {}) => {
  const out = join(base, `out-${Math.random().toString(16).slice(2)}`)
  const r = await runInDocker(input(['sh', '-c', `{ ${command.join(' ')} ; } > /saida/${out.split('/').pop()} 2>&1`], over))
  const text = (() => { try { return readFileSync(join(data, 'docker', 'saida', (r as any).sessionId ?? SID, out.split('/').pop()!), 'utf8') } catch { return '' } })()
  return { r, text }
}

try {
  // 1. the real daemon: create → inspect (checked against the plan, incl. Path with --init) → start
  const id1 = await capture(['id -u; grep -E "^Cap(Eff|Bnd)" /proc/self/status; ls /var/run/ /run/ 2>/dev/null | grep -c sock; wc -l < /proc/net/route; grep -E "^[^ ]+ / " /proc/mounts | cut -d" " -f4 | sed "s/^/rootfs /"; touch node_modules/x 2>&1; echo ok'])
  check('real daemon: container created, inspected against the plan and run', id1.r.ran === true && (id1.r as any).code === 0, JSON.stringify(id1.r))
  check('runs as the host uid', id1.text.split('\n')[0] === String(process.getuid!()), id1.text.split('\n')[0])
  check('no capabilities (CapEff 0)', /CapEff:\s+0000000000000000/.test(id1.text))
  check('no docker socket inside', id1.text.split('\n')[3] === '0', id1.text.split('\n')[3])
  check('no network: /proc/net/route has only the header', id1.text.split('\n')[4] === '1', id1.text.split('\n')[4])
  check('rootfs read-only (mount option ro)', /^rootfs ro[,\n]/m.test(id1.text + '\n'), id1.text.split('\n').find(l => l.startsWith('rootfs')))
  check('node_modules read-only outside install', /node_modules\/x.*Read-only file system/.test(id1.text), id1.text.split('\n').find(l => l.includes('node_modules')))

  // 2. sentinels §5.1 (env) and §5.2 (files, git) — from inside, nothing
  const s1 = await capture(['cat /proc/1/environ /proc/self/environ | tr "\\0" "\\n" | grep -c SENTINELA; grep -rl SENTINELA', repo, '2>/dev/null | grep -v node_modules; cat', join(repo, '.env'), join(repo, '.npmrc'), '; ls', join(repo, '.git'), '; echo end'])
  check('§5.1: no launcher secret in any process environ inside', /^0$/m.test(s1.text), s1.text.split('\n')[0])
  check('§5.2: .env/.npmrc masked, .git (FETCH_HEAD, modules, config) not visible, grep -r finds nothing', !/SENTINELA/.test(s1.text) && /end/.test(s1.text) && /^0$/m.test(s1.text), s1.text.replace(/\n/g, ' | ').slice(0, 200))
  writeFileSync(join(repo, '.env.local'), 'NEW=SENTINELA-BETWEEN\n')
  const s2 = await capture(['cat', join(repo, '.env.local'), '; echo end'])
  check('§5.2: a .env created between two commands is masked in the next one', !/SENTINELA/.test(s2.text) && /end/.test(s2.text))

  // 3. /tmp, HOME and node_modules/.cache survive --rm (proven session: same volumes)
  await runInDocker(input(['sh', '-c', 'echo T1 > /tmp/t1; echo H1 > $HOME/h1; echo C1 > node_modules/.cache/c1']))
  const t2 = await capture(['cat /tmp/t1 $HOME/h1 node_modules/.cache/c1'])
  check('/tmp, HOME, node_modules/.cache survive --rm between commands', t2.text.trim() === 'T1\nH1\nC1', t2.text.trim())

  // 4. OOM: file in /tmp survives, words name the memory
  const oomLog: string[] = []
  const oom = await runInDocker(input(['sh', '-c', 'echo OOM > /tmp/oom; bun -e "const a=[];for(;;)a.push(Buffer.alloc(1e7,1))"'], { memoryBytes: 256 * 1024 * 1024, log: s => oomLog.push(s) }))
  check('OOM: exit 137 and the words say memory', (oom as any).code === 137 && oomLog.some(l => /out of memory/.test(l)), `${(oom as any).code} ${oomLog.at(-1)}`)
  const oomRead = await capture(['cat /tmp/oom'])
  check('OOM: the /tmp file survives', oomRead.text.trim() === 'OOM')

  // 5. kill -9 of the launcher: the container keeps running only until the INSIDE TTL; the /tmp file survives
  const child = spawn(process.execPath, [import.meta.path, 'launcher', JSON.stringify({ input: { ...input(['sh', '-c', 'echo K9 > /tmp/k9; sleep 300'], { ttlSec: 6 }), tmuxPanes: undefined, memAvailable: undefined, memTotal: undefined }, rootPid: process.pid })], { stdio: 'ignore', env: env as any })
  await Bun.sleep(4000)
  const running = dk('ps', '-q', '--filter', `label=agentistics.session=${SID}`, '--filter', 'label=agentistics.kind=cmd').stdout.trim()
  child.kill('SIGKILL')
  await Bun.sleep(9000)
  const after = dk('ps', '-aq', '--filter', `label=agentistics.session=${SID}`, '--filter', 'label=agentistics.kind=cmd').stdout.trim()
  check('TTL with the launcher dead (kill -9): the container ends by itself and is removed (--rm)', running !== '' && after === '', `running=${running} after=${after}`)
  const k9 = await capture(['cat /tmp/k9'])
  check('kill -9 of the launcher: the /tmp file survives', k9.text.trim() === 'K9')
  // a dead launcher leaves its exec record; S3's sweep reaps it (spec §6.5). Clean the record here by hand? No: report it.
  const stale = Object.values(readLedger(data).sessions[SID]?.execs ?? {})
  check('the dead launcher left its exec record for the sweep (§6.5) — named, not hidden', stale.length >= 1, `${stale.length} record(s)`)

  // 6. docker kill: TERM to the launcher kills the WHOLE command (setsid child included), never another command
  const other = spawn(process.execPath, [import.meta.path, 'launcher', JSON.stringify({ input: { ...input(['sh', '-c', 'sleep 40; echo other-done']), tmuxPanes: undefined, memAvailable: undefined, memTotal: undefined }, rootPid: process.pid })], { stdio: 'ignore', env: env as any })
  const victim = spawn(process.execPath, [import.meta.path, 'launcher', JSON.stringify({ input: { ...input(['sh', '-c', 'setsid sh -c "sleep 300" & sleep 300']), tmuxPanes: undefined, memAvailable: undefined, memTotal: undefined }, rootPid: process.pid })], { stdio: 'ignore', env: env as any })
  const otherExit = new Promise<number>(r => other.once('exit', c => r(c ?? -1)))
  const victimExit = new Promise<number>(r => victim.once('exit', c => r(c ?? -1)))
  await Bun.sleep(6000)
  const ids = () => dk('ps', '-q', '--filter', `label=agentistics.session=${SID}`, '--filter', 'label=agentistics.kind=cmd').stdout.trim().split('\n').filter(Boolean)
  const before = ids()
  victim.kill('SIGTERM')
  const vCode = await Promise.race([victimExit, Bun.sleep(25_000).then(() => -2)])
  const left = ids()
  check('SIGTERM to a launcher: its container (setsid child included) is gone; the other command still runs', before.length === 2 && left.length === 1 && vCode !== -2, `before=${before.length} left=${left.length} code=${vCode}`)
  await Promise.race([otherExit, Bun.sleep(60_000)])

  // 7. identity: forged id + cwd ⇒ per-run (never sessB's or sessA's volumes)
  const volsBefore = dk('volume', 'ls', '-q', '--filter', `label=agentistics.install=${installId(data)}`).stdout.trim().split('\n').filter(Boolean).sort()
  const forged = await runInDocker(input(['true'], { env: { ...env, AGENTOP_MANAGED_ID: 'livesessB' }, tmuxPanes: () => 'agentop-livesessB\t2\n' }))
  const volsAfter = dk('volume', 'ls', '-q', '--filter', `label=agentistics.install=${installId(data)}`).stdout.trim().split('\n').filter(Boolean).sort()
  check('forged id + cwd ⇒ per-run volumes, removed after; the session volumes untouched', (forged as any).perRun === true && JSON.stringify(volsBefore) === JSON.stringify(volsAfter), `${JSON.stringify(forged)}`)

  // 8. a volume name that already exists ⇒ volume_preexistente (nothing adopted)
  const inst8 = installId(data).slice(0, 8)
  const squat = `${PREFIX}-${inst8}-scratch-livesessC`
  dk('volume', 'create', '--label', 'owner=someone', squat)
  writeFileSync(join(data, 'managed-sessions.json'), JSON.stringify([{ id: SID, cwd: repo }, { id: 'livesessB', cwd: repo }, { id: 'livesessC', cwd: repo }]))
  const pre = await runInDocker(input(['true'], { env: { ...env, AGENTOP_MANAGED_ID: 'livesessC' }, tmuxPanes: () => `agentop-livesessC\t${process.pid}\n` }))
  const squatLabels = JSON.parse(dk('volume', 'inspect', squat).stdout)[0]?.Labels
  check('pre-existing volume name ⇒ volume_preexistente, its labels untouched', /volume_preexistente/.test((pre as any).reason ?? '') && squatLabels?.owner === 'someone' && !squatLabels['agentistics.attempt'], (pre as any).reason)
  dk('volume', 'rm', squat)

  // 9. disk watchdog
  const dlog: string[] = []
  const disk = await runInDocker(input(['sh', '-c', 'i=0; while true; do head -c 4000000 /dev/zero > /saida/fill$i; i=$((i+1)); sleep 0.2; done'], { diskEveryMs: 2000, diskLimits: { sessionMax: 40 * 1024 * 1024, freeFloor: 0 }, log: s => dlog.push(s) }))
  check('disk: a command writing without stop is killed by the watchdog, the message gives the overshoot', disk.ran === true && dlog.some(l => /ceiling; the command was stopped.*overshoot by up to 2 s/.test(l)), dlog.at(-1))
  spawnSync('sh', ['-c', `rm -f ${join(data, 'docker', 'saida', SID)}/fill*`])

  // 10. image refusal live: env.yml with a digest ⇒ fallback, nothing created
  mkdirSync(join(repo, '.agentistics'))
  writeFileSync(join(repo, '.agentistics', 'env.yml'), `image: ${BUN.ref}\n`)
  const n0 = dk('ps', '-aq', '--filter', `label=agentistics.install=${installId(data)}`).stdout
  const img = await runInDocker(input(['true']))
  check('env.yml with a digest ⇒ refused with the sentence, namespace fallback, no container', img.ran === false && (img as any).fallback === true && /catalogue key/.test((img as any).reason) && n0 === dk('ps', '-aq', '--filter', `label=agentistics.install=${installId(data)}`).stdout, (img as any).reason)
  rmSync(join(repo, '.agentistics'), { recursive: true })
} catch (e) {
  check('live run threw', false, e instanceof Error ? e.stack ?? e.message : String(e))
} finally {
  // cleanup: only what THIS run created — containers by our install label, volumes the ledger recorded
  const inst = installId(data)
  const cids = dk('ps', '-aq', '--filter', `label=agentistics.install=${inst}`).stdout.trim().split('\n').filter(Boolean)
  for (const id of cids) dk('rm', '-f', id)
  const vols = new Set<string>()
  for (const s of Object.values(readLedger(data).sessions)) for (const v of s.volumes) vols.add(v.name)
  for (const v of vols) if (v.startsWith(`${PREFIX}-`)) dk('volume', 'rm', v)
  if (!hadImage) { const imgId = dk('image', 'inspect', '--format', '{{.Id}}', BUN.ref).stdout.trim(); if (imgId) sh('docker', ['image', 'rm', imgId]) }
  const leftC = dk('ps', '-aq', '--filter', `label=agentistics.install=${inst}`).stdout.trim()
  const leftV = dk('volume', 'ls', '-q', '--filter', `label=agentistics.install=${inst}`).stdout.trim()
  check('cleanup: no container and no volume of this run remain', leftC === '' && leftV === '', `containers=${leftC || 0} volumes=${leftV || 0}`)
  rmSync(base, { recursive: true, force: true })
  const fail = results.filter(r => !r.ok).length
  console.log(`\nRESULT ${results.length - fail} pass, ${fail} fail`)
  process.exit(fail ? 1 : 0)
}

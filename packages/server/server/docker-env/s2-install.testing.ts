/**
 * DOCKER.AMBIENTES S2 — LIVE proof of `agentop env install` (not part of `bun test`): a fixture with a real
 * registry dependency and a root `postinstall`. Phase 1 downloads through the egress proxy with scripts OFF and the
 * worktree read-only; phase 2 runs the postinstall with no network; a command then sees the dependency, cannot write
 * `node_modules`, and finds the postinstall's file in its /tmp. Everything created is removed at the end.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ENV_IMAGES } from '@agentistics/core'
import { envInstall } from './env-install'
import { runInDocker, GIB, type DockerRunInput } from './docker-run'
import { installId, readLedger } from './ledger'

const PREFIX = 'agentistics-s2-test'
const BUN = ENV_IMAGES.find(i => i.key === 'bun-1.3')!
const dk = (...a: string[]) => spawnSync('docker', a, { encoding: 'utf8', timeout: 120_000 })
const results: { name: string; ok: boolean; detail: string }[] = []
const check = (name: string, ok: boolean, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`) }

const base = mkdtempSync('/tmp/agentistics-s2-test-inst-')
const data = join(base, 'data'); const repo = join(base, 'repo')
mkdirSync(data); mkdirSync(repo)
spawnSync('git', ['init', '-q', repo])
writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'inst', dependencies: { 'is-number': '7.0.0' }, scripts: { postinstall: 'echo POST > /tmp/postinstall-ran; echo POSTWT > postinstall-in-worktree' } }))
// the lockfile is made on the host in this throwaway fixture, then its host node_modules removed
spawnSync('bun', ['install', '--ignore-scripts'], { cwd: repo, encoding: 'utf8', timeout: 120_000 })
rmSync(join(repo, 'node_modules'), { recursive: true, force: true })
check('fixture lockfile', existsSync(join(repo, 'bun.lock')) || existsSync(join(repo, 'bun.lockb')))
const SID = 'instsess'
writeFileSync(join(data, 'managed-sessions.json'), JSON.stringify([{ id: SID, cwd: repo }]))
const hadImage = dk('image', 'inspect', BUN.ref).status === 0
const env = { ...process.env, AGENTISTICS_DOCKER_PREFIX: PREFIX, AGENTOP_MANAGED_ID: SID, NPM_TOKEN: 'SENTINELA-NPM' } as Record<string, string | undefined>
const common = { cwd: repo, dataDir: data, env, memAvailable: () => 10 * GIB, memTotal: () => 12 * GIB, tmuxPanes: () => `agentop-${SID}\t${process.pid}\n` }
const run = (command: string[]) => runInDocker({ ...common, command: ['sh', '-c', `{ ${command.join(' ')} ; } > /saida/o.txt 2>&1`], ttlSec: 120, memoryBytes: 512 * 1024 * 1024 } as DockerRunInput)
const out = () => { try { return readFileSync(join(data, 'docker', 'saida', SID, 'o.txt'), 'utf8') } catch { return '' } }

try {
  const r = await envInstall({ ...common, memoryBytes: 1024 * 1024 * 1024 } as any)
  check('agentop env install: download (proxy) + scripts (offline) succeed', r.code === 0, r.message)
  const j = (() => { try { return readFileSync(join(data, 'docker', 'egress.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)) } catch { return [] } })()
  check('the download went out only to the registry through the proxy', j.length > 0 && j.every(e => e.host === 'registry.npmjs.org' && e.decision === 'allow'), JSON.stringify(j.map(e => `${e.host} ${e.decision}`)))
  check('the worktree got no node_modules content on the host (mount points only)', !existsSync(join(repo, 'node_modules', 'is-number', 'package.json')))
  check('the postinstall wrote into the worktree in phase 2 (worktree writable there)', existsSync(join(repo, 'postinstall-in-worktree')))
  const s = readLedger(data).sessions[SID]!
  check('the ledger moved to nm generation g1 and dropped g0', s.nmGen === 1 && !s.volumes.some(v => v.kind === 'nm' && v.gen === 0) && dk('volume', 'inspect', `${PREFIX}-${installId(data).slice(0, 8)}-nm-${SID}-g0`).status !== 0)
  check('only install kinds ever mounted nm writable', s.containers.filter(c => c.nmWritable).every(c => ['init', 'install-download', 'install-scripts'].includes(c.kind)))
  await run(['bun -e "console.log(require(\'is-number\')(5))"; touch node_modules/x; cat /tmp/postinstall-ran'])
  const o = out()
  check('a command sees the installed dependency', /^true$/m.test(o), o.replace(/\n/g, ' | '))
  check('a command cannot write node_modules', /Read-only file system/.test(o))
  check('the postinstall output in /tmp survives into the next command', /^POST$/m.test(o))
  check('the launcher NPM_TOKEN sentinel is nowhere in the ledger or journal', !/SENTINELA/.test(readFileSync(join(data, 'docker', 'ledger.json'), 'utf8') + readFileSync(join(data, 'docker', 'egress.jsonl'), 'utf8')))
} catch (e) {
  check('install proof threw', false, e instanceof Error ? e.stack ?? e.message : String(e))
} finally {
  const inst = installId(data)
  for (const id of dk('ps', '-aq', '--filter', `label=agentistics.install=${inst}`).stdout.trim().split('\n').filter(Boolean)) dk('rm', '-f', id)
  for (const s of Object.values(readLedger(data).sessions)) for (const v of s.volumes) if (v.name.startsWith(`${PREFIX}-`)) dk('volume', 'rm', v.name)
  if (!hadImage) { const imgId = dk('image', 'inspect', '--format', '{{.Id}}', BUN.ref).stdout.trim(); if (imgId) spawnSync('docker', ['image', 'rm', imgId]) }
  const leftC = dk('ps', '-aq', '--filter', `label=agentistics.install=${inst}`).stdout.trim()
  const leftV = dk('volume', 'ls', '-q', '--filter', `label=agentistics.install=${inst}`).stdout.trim()
  check('cleanup: no container and no volume of this run remain', leftC === '' && leftV === '', `c=${leftC || 0} v=${leftV || 0}`)
  rmSync(base, { recursive: true, force: true })
  const fail = results.filter(r => !r.ok).length
  console.log(`\nRESULT ${results.length - fail} pass, ${fail} fail`)
  process.exit(fail ? 1 : 0)
}

/**
 * DOCKER.AMBIENTES S2 — the pure rules (argv, inspect, image, env, masks, identity, egress, disk, memory).
 * The orchestration against a fake `docker` binary is `docker-run.test.ts`; the live proofs are `s2-live.testing.ts`.
 */
import { describe, expect, test } from 'bun:test'
import { ENV_IMAGES } from '@agentistics/core'
import { argvRefusal, buildCreateArgv, EXEC_WRAP, type ContainerPlan } from './docker-argv'
import { containerProblems, imageProblems, nmWritableRefusal } from './inspect-check'
import { imageForProfile, parseEnvProfile } from './env-profile'
import { containerEnv, envFileText } from './container-env'
import { maskMounts, maskReason } from './masks'
import { afterCreate, beforeCreate, markerMatches } from './volume-identity'
import { parseStat, proveAncestry, proposedSessionId, tmuxRoots, type ProcLink } from './session-proof'
import { egressDecision, isForbiddenAddress } from './egress-policy'
import { diskVerdict, volumeSizes } from './disk-watch'
import { memoryAdmission, GIB } from './docker-run'
import { containerPlan, nmSlots } from './plans'
import { exitWords } from './scripts'

const BUN = ENV_IMAGES.find(i => i.key === 'bun-1.3')!

const plan = (over: Partial<Parameters<typeof containerPlan>[0]> = {}): ContainerPlan => containerPlan({
  kind: 'cmd', name: 'agentistics-ab12cd34-s1-cmd-0a', image: BUN.ref, uid: 1000, gid: 1000, memoryBytes: 2 * GIB,
  root: '/w', cwd: '/w', envFile: '/x/env', labels: { 'agentistics.session': 's1' },
  volumes: { scratch: 'agentistics-ab12cd34-scratch-s1', nm: 'agentistics-ab12cd34-nm-s1-g0' },
  nm: nmSlots(['packages/core']), masks: [], optDir: '/o', saidaDir: '/s', ttlSec: 600, argv: ['bun', 'test'], ...over,
})

/** What a well-behaved daemon reports for a plan (the fake binary builds the same). */
function inspectOf(p: ContainerPlan): any {
  return {
    Path: EXEC_WRAP,
    Config: { User: `${p.user.uid}:${p.user.gid}` },
    HostConfig: { NetworkMode: 'none', ReadonlyRootfs: true, CapDrop: ['ALL'], CapAdd: p.capAdd ? [p.capAdd] : null, Memory: p.memoryBytes, MemorySwap: p.memoryBytes, SecurityOpt: ['no-new-privileges'], PortBindings: {},
      Mounts: p.mounts.map(m => ({ Type: m.type, Source: m.source, Target: m.target, ReadOnly: m.readonly })) },
    Mounts: p.mounts.map(m => ({ Type: m.type, Source: m.source ?? '', Name: m.type === 'volume' ? m.source : undefined, Destination: m.target, RW: !m.readonly })),
  }
}

describe('argv (SPEC §3.3, §13 S2)', () => {
  test('the command container argv: --network none, exec-wrap entrypoint, cap-drop ALL, user, read-only, no -p, no socket', () => {
    const a = buildCreateArgv(plan())
    expect(a.slice(0, 15)).toEqual(['create', '--rm', '--name', 'agentistics-ab12cd34-s1-cmd-0a', '--network', 'none', '--entrypoint', EXEC_WRAP, '--user', '1000:1000', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges'])
    for (const f of ['--pids-limit', '--init', '--memory', '--memory-swap', '--oom-score-adj', '--env-file']) expect(a).toContain(f)
    expect(a).not.toContain('-p')
    expect(a.join(' ')).not.toMatch(/docker\.sock|--publish|--privileged|--cap-add/)
    expect(a.slice(-4)).toEqual([BUN.ref, '600', 'bun', 'test'])
    expect(argvRefusal(a)).toBeNull()
  })
  test('nm is read-only outside install, writable in install, and a writable nm in a command is refused', () => {
    const cmd = plan().mounts.filter(m => m.source?.includes('-nm-'))
    expect(cmd.length).toBe(2)
    expect(cmd.every(m => m.readonly)).toBe(true)
    const inst = plan({ kind: 'install-scripts' }).mounts.filter(m => m.source?.includes('-nm-'))
    expect(inst.every(m => !m.readonly)).toBe(true)
    const forged = plan(); forged.mounts = forged.mounts.map(m => m.source?.includes('-nm-') ? { ...m, readonly: false } : m)
    expect(nmWritableRefusal(forged, 'agentistics-ab12cd34-nm-')).toMatch(/writable only during/)
  })
  test('/tmp, HOME and node_modules/.cache are sub-paths of the scratch volume (they survive --rm)', () => {
    const m = plan().mounts
    expect(m.find(x => x.target === '/tmp')).toMatchObject({ type: 'volume', source: 'agentistics-ab12cd34-scratch-s1', subpath: 'tmp' })
    expect(m.find(x => x.target === '/home/agent')).toMatchObject({ type: 'volume', subpath: 'home' })
    expect(m.find(x => x.target === '/w/packages/core/node_modules/.cache')).toMatchObject({ subpath: 'nmcache/packages__core/.cache', readonly: false })
    expect(m.some(x => x.type === 'tmpfs')).toBe(false)
    expect(m.every(x => x.type !== 'volume' || x.subpath)).toBe(true) // never a volume root
  })
  test('the download container (r4 #2): NEVER the worktree — only the read-only host staging; no scratch, no masks', () => {
    const p = plan({ kind: 'install-download', stagingDir: '/stage/x', volumes: { scratch: 'sc', nm: 'agentistics-ab12cd34-nm-s1-g1', cache: 'cache-bun' }, masks: [{ type: 'bind', source: '/dev/null', target: '/w/.env', readonly: true }] })
    const m = p.mounts
    expect(m.find(x => x.target === '/w')).toEqual({ type: 'bind', source: '/stage/x', target: '/w', readonly: true })
    expect(m.some(x => x.source === '/w')).toBe(false)
    expect(m.some(x => x.source === 'sc')).toBe(false)
    expect(m.some(x => x.target === '/w/.env')).toBe(false)
    expect(p.workdir).toBe('/w')
    // the cache is the one writable non-nm place, and it is NOT reachable together with the worktree
    expect(m.find(x => x.target === '/cache')).toMatchObject({ source: 'cache-bun', readonly: false })
  })
  test('the download container without a staging directory cannot be planned (never falls back to the worktree)', () => {
    expect(() => plan({ kind: 'install-download', volumes: { scratch: 'sc', nm: 'n', cache: 'c' } })).toThrow(/staging/)
  })
  const refused: [string, string[]][] = [
    ['build', ['build', '.']], ['buildx', ['buildx', 'build', '.']], ['network', ['network', 'connect', 'x', 'y']],
    ['system prune', ['system', 'prune', '-f']], ['volume prune', ['volume', 'prune']], ['image rm', ['image', 'rm', 'x']], ['exec', ['exec', 'x', 'sh']],
  ]
  for (const [name, a] of refused) test(`refuses docker ${name}`, () => expect(argvRefusal(a)).not.toBeNull())
  const base = buildCreateArgv(plan())
  const mut = (f: (a: string[]) => string[]) => f([...base])
  const createMutants: [string, string[]][] = [
    ['drop --network none', mut(a => { a.splice(a.indexOf('--network'), 2); return a })],
    ['--network bridge', mut(a => { a[a.indexOf('--network') + 1] = 'bridge'; return a })],
    ['drop --cap-drop ALL', mut(a => { a.splice(a.indexOf('--cap-drop'), 2); return a })],
    ['publish a port', mut(a => [...a.slice(0, 2), '-p', '47291:47291', ...a.slice(2)])],
    ['mount docker.sock', mut(a => [...a.slice(0, 2), '--mount', 'type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock', ...a.slice(2)])],
    ['privileged', mut(a => [...a.slice(0, 2), '--privileged', ...a.slice(2)])],
    ['cap-add SYS_ADMIN', mut(a => [...a.slice(0, 2), '--cap-add', 'SYS_ADMIN', ...a.slice(2)])],
    ['-v', mut(a => [...a.slice(0, 2), '-v', '/:/host', ...a.slice(2)])],
    ['other entrypoint', mut(a => { a[a.indexOf('--entrypoint') + 1] = '/usr/local/bin/docker-entrypoint.sh'; return a })],
    ['--pid host', mut(a => [...a.slice(0, 2), '--pid', 'host', ...a.slice(2)])],
  ]
  for (const [name, a] of createMutants) test(`refuses create: ${name}`, () => expect(argvRefusal(a)).not.toBeNull())
})

describe('inspect (create → inspect → start)', () => {
  test('a container matching its plan passes', () => { const p = plan(); expect(containerProblems(inspectOf(p), p)).toEqual([]) })
  const tamper: [string, (c: any) => void][] = [
    ['network', c => { c.HostConfig.NetworkMode = 'bridge' }],
    ['entrypoint', c => { c.Path = '/usr/local/bin/docker-entrypoint.sh' }],
    ['rootfs', c => { c.HostConfig.ReadonlyRootfs = false }],
    ['capdrop', c => { c.HostConfig.CapDrop = [] }],
    ['memory', c => { c.HostConfig.Memory = 0 }],
    ['swap', c => { c.HostConfig.MemorySwap = -1 }],
    ['port', c => { c.HostConfig.PortBindings = { '3000/tcp': [{ HostPort: '3000' }] } }],
    ['nm writable', c => { for (const m of c.Mounts) if (String(m.Name).includes('-nm-')) m.RW = true }],
    ['anonymous volume', c => { c.Mounts.push({ Type: 'volume', Name: 'x', Destination: '/data', RW: true }) }],
    ['docker.sock', c => { c.Mounts.push({ Type: 'bind', Source: '/var/run/docker.sock', Destination: '/var/run/docker.sock', RW: true }) }],
    ['privileged', c => { c.HostConfig.Privileged = true }],
    ['an extra tmpfs', c => { c.Mounts.push({ Type: 'tmpfs', Source: '', Destination: '/x', RW: true }) }],
    ['user', c => { c.Config.User = '0:0' }],
  ]
  for (const [name, f] of tamper) test(`refuses a container whose ${name} differs`, () => { const p = plan(); const c = inspectOf(p); f(c); expect(containerProblems(c, p).length).toBeGreaterThan(0) })
})

describe('image catalogue (SPEC §3.4)', () => {
  test('catalogue digest + empty ONBUILD passes', () => expect(imageProblems({ RepoDigests: [BUN.ref], Config: { OnBuild: null } }, BUN)).toEqual([]))
  test('a local image without the catalogue digest is refused', () => expect(imageProblems({ RepoDigests: ['oven/bun@sha256:' + 'f'.repeat(64)], Config: {} }, BUN).join()).toMatch(/digest/))
  test('ONBUILD is refused', () => expect(imageProblems({ RepoDigests: [BUN.ref], Config: { OnBuild: ['RUN curl x'] } }, BUN).join()).toMatch(/ONBUILD/))
  test('an image outside the catalogue (tampered entry) is refused', () => expect(imageProblems({ RepoDigests: ['evil@sha256:' + '0'.repeat(64)] }, { ...BUN, ref: 'evil@sha256:' + '0'.repeat(64) }).join()).toMatch(/not in the catalogue/))
  const bad: [string, string][] = [
    ['a digest as image', 'image: oven/bun@sha256:' + 'a'.repeat(64)],
    ['a tag as image', 'image: oven/bun:1.3'],
    ['a FROM line', 'FROM ubuntu'],
    ['build:', 'build: .'],
    ['dockerfile:', 'dockerfile: Dockerfile'],
    ['a key outside the catalogue', 'image: python-3'],
    ['an unknown key', 'entrypoint2: x'],
    ['needs git (no catalogue image has it)', 'needs: [git]'],
  ]
  for (const [name, text] of bad) test(`env.yml with ${name} is refused`, () => expect(imageForProfile(text).ok).toBe(false))
  test('no env.yml = the bun image; a catalogue key is accepted', () => {
    expect(imageForProfile(null)).toMatchObject({ ok: true, image: { key: 'bun-1.3' } })
    expect(imageForProfile('image: node-22-slim\nenv:\n  FOO: bar\n')).toMatchObject({ ok: true, image: { key: 'node-22-slim' }, profile: { env: { FOO: 'bar' } } })
  })
  test('network allow list parses', () => expect(parseEnvProfile('network:\n  allow: [registry.npmjs.org]\n')).toMatchObject({ ok: true, profile: { network: { allow: ['registry.npmjs.org'] } } }))
})

describe('environment by positive list (SPEC §5.1 sentinels)', () => {
  const host = { GITHUB_TOKEN: 'SENTINELA-1', GH_TOKEN: 'SENTINELA-2', NPM_TOKEN: 'SENTINELA-3', AWS_SECRET_ACCESS_KEY: 'SENTINELA-4', ANTHROPIC_API_KEY: 'SENTINELA-5', OPENAI_API_KEY: 'SENTINELA-6', AGENTOP_MANAGED_ID: 'SENTINELA-7', PATH: '/evil', HOME: '/home/real', LANG: 'pt_BR.UTF-8', TERM: 'xterm-256color', TZ: 'America/Sao_Paulo', AGENTISTICS_FLOWS: '1' }
  test('no launcher secret reaches the env file', () => {
    const text = envFileText(containerEnv({ host, sid: 's1', profile: { NPM_AUTH: 'SENTINELA-8', MY_SECRET: 'SENTINELA-9', SAFE: 'ok' } }))
    expect(text).not.toMatch(/SENTINELA/)
    expect(text).not.toMatch(/^PATH=/m)
    expect(text).toMatch(/^HOME=\/home\/agent$/m)
    expect(text).toMatch(/^AGENTISTICS_FLOWS=0$/m)
    expect(text).toMatch(/^LANG=pt_BR.UTF-8$/m)
    expect(text).toMatch(/^SAFE=ok$/m)
    expect(text).not.toMatch(/PROXY/)
  })
  test('the proxy only in network containers', () => expect(containerEnv({ host: {}, sid: 's', proxy: 'http://127.0.0.1:3128' }).HTTPS_PROXY).toBe('http://127.0.0.1:3128'))
  test('a value with a newline is dropped (cannot smuggle a second variable)', () => expect(containerEnv({ host: {}, sid: 's', profile: { A: 'x\nGITHUB_TOKEN=y' } }).A).toBeUndefined())
})

describe('masks (SPEC §5.2 sentinels)', () => {
  test('credential files are masked by name or content; examples and node_modules are not', () => {
    const { mounts, masked } = maskMounts('/w', [
      { path: '.env', head: 'X=SENTINELA' }, { path: '.env.example', head: 'X=' }, { path: 'cfg/.npmrc', head: '//r/:_authToken=SENTINELA' },
      { path: 'notes.txt', head: 'clone https://u:SENTINELA@github.com/x' }, { path: 'keys/id_ed25519' }, { path: '.ssh/config' },
      { path: 'node_modules/x/.env', head: 'S' }, { path: 'src/ok.ts', head: 'export {}' },
    ], { gitDirInTree: true })
    expect(masked.sort()).toEqual(['.env', '.git/', '.ssh/', 'cfg/.npmrc', 'keys/id_ed25519', 'notes.txt'].sort())
    expect(mounts.find(m => m.target === '/w/.env')).toEqual({ type: 'bind', source: '/dev/null', target: '/w/.env', readonly: true })
    expect(mounts.find(m => m.target === '/w/.git')).toEqual({ type: 'tmpfs', target: '/w/.git', readonly: true })
  })
  test('a versioned secret is not listed (only untracked/ignored entries are given)', () => expect(maskReason({ path: 'src/ok.ts', head: 'x' })).toBeNull())
})

describe('volume identity (SPEC §3.2, P11)', () => {
  const intent = { name: 'v', attemptId: 'a1', labels: { 'agentistics.attempt': 'a1', 'agentistics.session': 's' }, createdAfter: '2026-11-27T10:00:00.500Z' }
  test('a name that exists before create ⇒ volume_preexistente', () => expect(beforeCreate(0, '')).toMatchObject({ ok: false, code: 'volume_preexistente' }))
  test('"no such volume" ⇒ free', () => expect(beforeCreate(1, 'Error: get v: no such volume')).toEqual({ ok: true }))
  test('an inspect error that is not "no such volume" does not prove the name free', () => expect(beforeCreate(1, 'permission denied')).toMatchObject({ ok: false }))
  test('our labels and a fresh CreatedAt (1 s resolution) ⇒ ours', () => expect(afterCreate({ Name: 'v', Labels: intent.labels, CreatedAt: '2026-11-27T07:00:00-03:00' }, intent)).toEqual({ ok: true }))
  test('foreign labels ⇒ volume_nao_nosso', () => expect(afterCreate({ Name: 'v', Labels: { ...intent.labels, 'agentistics.attempt': 'x' }, CreatedAt: '2026-11-27T10:00:01Z' }, intent)).toMatchObject({ code: 'volume_nao_nosso' }))
  test('an older CreatedAt ⇒ volume_nao_nosso', () => expect(afterCreate({ Name: 'v', Labels: intent.labels, CreatedAt: '2026-11-27T09:59:59Z' }, intent)).toMatchObject({ code: 'volume_nao_nosso' }))
  test('the marker must match attempt and nonce', () => {
    expect(markerMatches('{"attemptId":"a1","nonce":"n"}', 'a1', 'n')).toEqual({ ok: true })
    expect(markerMatches('{"attemptId":"a1","nonce":"other"}', 'a1', 'n')).toMatchObject({ ok: false })
    expect(markerMatches(null, 'a1', 'n')).toMatchObject({ ok: false })
  })
})

describe('session identity by ancestry (SPEC §3.1, P10)', () => {
  // 500 (launcher) -> 400 (bash) -> 300 (harness) -> 200 (pane/root) -> 1
  const tree: Record<number, ProcLink> = { 500: { ppid: 400, start: 50 }, 400: { ppid: 300, start: 40 }, 300: { ppid: 200, start: 30 }, 200: { ppid: 1, start: 20 }, 900: { ppid: 1, start: 90 } }
  const read = (p: number) => tree[p] ?? null
  test('descends from the root ⇒ proven', () => expect(proveAncestry('A', [200], 500, read)).toMatchObject({ proven: true, sessionId: 'A', depth: 3 }))
  test('forged id: the claimed session root is not an ancestor ⇒ per run', () => expect(proveAncestry('B', [900], 500, read).proven).toBe(false))
  test('reparented to init (setsid + fork) ⇒ per run', () => expect(proveAncestry('A', [200], 900, read)).toMatchObject({ proven: false }))
  test('a recycled pid (parent younger than child) ⇒ per run', () => {
    const t2: Record<number, ProcLink> = { ...tree, 300: { ppid: 200, start: 60 } }
    expect(proveAncestry('A', [200], 500, p => t2[p] ?? null).proven).toBe(false)
  })
  test('no root ⇒ per run', () => expect(proveAncestry('A', [], 500, read).proven).toBe(false))
  test('the proposed id comes from env or the nearest ancestor environ', () => {
    expect(proposedSessionId({ AGENTOP_MANAGED_ID: 'X' }, 500, read, () => null)).toBe('X')
    expect(proposedSessionId({}, 500, read, p => p === 300 ? 'A=1\0AGENTOP_MANAGED_ID=Y\0' : null)).toBe('Y')
  })
  test('parseStat reads ppid and start through a comm with spaces and parens', () => {
    expect(parseStat('123 (a b) c)) S 77 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 98765 1 1')).toEqual({ ppid: 77, start: 98765 })
  })
  test('tmux roots are the pane pids of agentop-<id> only', () => expect(tmuxRoots('agentop-A\t200\nagentop-AB\t300\nother\t4\n', 'A')).toEqual([200]))
})

describe('egress (SPEC §3.6, P7 decision half)', () => {
  const ok = (line: string, resolved: string[], hostAddresses: string[] = []) => egressDecision({ requestLine: line, allow: ['registry.npmjs.org'], resolved, hostAddresses })
  test('CONNECT to an allowed registry on 443 with a public address passes', () => expect(ok('CONNECT registry.npmjs.org:443 HTTP/1.1', ['104.16.0.35'])).toMatchObject({ allow: true }))
  const refusals: [string, string, string[]][] = [
    ['127.0.0.1', 'CONNECT 127.0.0.1:443 HTTP/1.1', ['127.0.0.1']],
    ['localhost', 'CONNECT localhost:443 HTTP/1.1', ['127.0.0.1']],
    ['0.0.0.0', 'CONNECT 0.0.0.0:443 HTTP/1.1', []],
    ['[::1]', 'CONNECT [::1]:443 HTTP/1.1', []],
    ['[::ffff:127.0.0.1]', 'CONNECT [::ffff:127.0.0.1]:443 HTTP/1.1', []],
    ['2130706433', 'CONNECT 2130706433:443 HTTP/1.1', []],
    ['port 47291', 'CONNECT registry.npmjs.org:47291 HTTP/1.1', ['104.16.0.35']],
    ['port 47292', 'CONNECT registry.npmjs.org:47292 HTTP/1.1', ['104.16.0.35']],
    ['an allowed name resolving to loopback (DNS rebinding)', 'CONNECT registry.npmjs.org:443 HTTP/1.1', ['127.0.0.1']],
    ['an allowed name resolving to the LAN', 'CONNECT registry.npmjs.org:443 HTTP/1.1', ['192.168.0.10']],
    ['an allowed name resolving to a mapped v6', 'CONNECT registry.npmjs.org:443 HTTP/1.1', ['::ffff:10.0.0.1']],
    ['plain GET with forged Host', 'GET http://registry.npmjs.org/ HTTP/1.1', ['104.16.0.35']],
    ['a host not in the list', 'CONNECT evil.example.com:443 HTTP/1.1', ['93.184.216.34']],
    ['host.docker.internal', 'CONNECT host.docker.internal:443 HTTP/1.1', ['172.17.0.1']],
  ]
  for (const [name, line, resolved] of refusals) test(`refuses ${name}`, () => expect(ok(line, resolved).allow).toBe(false))
  test('a public address that is one of the host interfaces is refused', () => expect(ok('CONNECT registry.npmjs.org:443 HTTP/1.1', ['203.0.113.7'], ['203.0.113.7']).allow).toBe(false))
  test('address classes', () => {
    for (const ip of ['10.1.2.3', '100.64.1.1', '169.254.1.1', '172.20.0.1', '224.0.0.1', 'fe80::1', 'fd00::1', '::', '::1', '::ffff:7f00:1']) expect(isForbiddenAddress(ip)).toBe(true)
    for (const ip of ['104.16.0.35', '2606:4700::6810:22']) expect(isForbiddenAddress(ip)).toBe(false)
  })
  test('the allow list cannot exceed agentop maximum', () => expect(egressDecision({ requestLine: 'CONNECT evil.example.com:443 HTTP/1.1', allow: ['evil.example.com'], resolved: ['93.184.216.34'], hostAddresses: [] }).allow).toBe(false))
})

describe('disk, memory, exit words', () => {
  test('over the session ceiling ⇒ kill with the overshoot said', () => {
    const v = diskVerdict({ sessionBytes: 5 * GIB, dockerFreeBytes: 50 * GIB })
    expect(v).toMatchObject({ kill: true, code: 'disco_sessao' })
    expect((v as any).message).toMatch(/overshoot by up to 15 s/)
  })
  test('docker disk under the floor ⇒ kill; unknown free ⇒ never a reason', () => {
    expect(diskVerdict({ sessionBytes: 0, dockerFreeBytes: GIB })).toMatchObject({ kill: true, code: 'disco_cheio' })
    expect(diskVerdict({ sessionBytes: 0, dockerFreeBytes: null })).toEqual({ kill: false })
  })
  test('docker system df -v sizes', () => expect(volumeSizes(JSON.stringify({ Volumes: [{ Name: 'a', Size: '1.5GB' }, { Name: 'b', Size: '0B' }, { Name: 'c', Size: '12.3kB' }] }))).toEqual(new Map([['a', 1.5e9], ['b', 0], ['c', 12300]])))
  test('memory admission (§11.2)', () => {
    expect(memoryAdmission(10 * GIB, 12 * GIB, 0)).toEqual({ ok: true, bytes: 6 * GIB })
    expect(memoryAdmission(6 * GIB, 12 * GIB, 0)).toEqual({ ok: true, bytes: 3 * GIB })
    expect(memoryAdmission(4.5 * GIB, 12 * GIB, 0)).toMatchObject({ ok: false })
    expect(memoryAdmission(10 * GIB, 12 * GIB, 4 * GIB)).toMatchObject({ ok: false })
    expect(memoryAdmission(null, null, 0)).toMatchObject({ ok: false })
  })
  test('exit words', () => {
    expect(exitWords(137, { ttlSec: 5, memoryBytes: 2 * GIB })).toMatch(/out of memory \(limit 2.0 GB\)/)
    expect(exitWords(124, { ttlSec: 5, memoryBytes: GIB })).toMatch(/time limit \(5s\)/)
    expect(exitWords(0, { ttlSec: 5, memoryBytes: GIB })).toBeNull()
  })
})

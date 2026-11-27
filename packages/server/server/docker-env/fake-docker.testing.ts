#!/usr/bin/env bun
/**
 * TEST FIXTURE — a fake `docker` binary. Every invocation appends its argv (JSON, one per line) to
 * `$AGENTISTICS_FAKE_DOCKER_LOG`, and keeps images/volumes/containers in `$AGENTISTICS_FAKE_DOCKER_STATE`.
 * `create` turns its flags into the inspect JSON the daemon would report (so the real `containerProblems` runs
 * against it); the state's `tamper` knobs make it lie the way a misbehaving daemon would. It reproduces P11:
 * `volume create` over an existing name succeeds silently and keeps the old labels.
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const logPath = process.env.AGENTISTICS_FAKE_DOCKER_LOG!
const statePath = process.env.AGENTISTICS_FAKE_DOCKER_STATE!
appendFileSync(logPath, JSON.stringify(argv) + '\n')
const st: any = (() => { try { return JSON.parse(readFileSync(statePath, 'utf8')) } catch { return {} } })()
st.images ??= {}; st.volumes ??= {}; st.containers ??= {}
const save = () => writeFileSync(statePath, JSON.stringify(st))
const out = (s: string) => process.stdout.write(s + '\n')
const fail = (msg: string, code = 1): never => { process.stderr.write(msg + '\n'); save(); process.exit(code) }

const [sub, a1] = argv
if (sub === 'version') { out('29.3.0'); process.exit(0) }
if (sub === 'image' && a1 === 'inspect') {
  const ref = argv[2]!
  const img = st.images[ref]
  if (!img) fail(`Error: No such image: ${ref}`)
  out(JSON.stringify([{ RepoDigests: [img.digest ?? ref], Config: { OnBuild: img.onBuild ?? null, Volumes: img.volumes ?? null } }]))
  process.exit(0)
}
if (sub === 'pull') { st.images[argv[1]!] = st.pullAs ?? {}; save(); process.exit(0) }
if (sub === 'volume') {
  const name = argv[argv.length - 1]!
  if (a1 === 'inspect') {
    const v = st.volumes[name]
    if (!v) fail(`Error response from daemon: get ${name}: no such volume`)
    out(JSON.stringify([{ Name: name, Labels: v.labels, CreatedAt: v.createdAt }])); process.exit(0)
  }
  if (a1 === 'create') {
    const labels: Record<string, string> = {}
    for (let i = 2; i < argv.length - 1; i++) if (argv[i] === '--label') { const [k, ...r] = argv[++i]!.split('='); labels[k!] = r.join('=') }
    if (!st.volumes[name]) st.volumes[name] = { labels: st.foreignOnCreate ? { ...labels, 'agentistics.attempt': 'someone-else' } : labels, createdAt: st.createdAtOverride ?? new Date().toISOString(), marker: null }
    out(name); save(); process.exit(0)
  }
  if (a1 === 'rm') { delete st.volumes[name]; save(); process.exit(0) }
  if (a1 === 'ls') { out(''); process.exit(0) }
}
if (sub === 'system') { out(JSON.stringify({ Volumes: Object.entries(st.volumes).map(([n, v]: any) => ({ Name: n, Size: v.size ?? '0B' })) })); process.exit(0) }
if (sub === 'create') {
  const c: any = { Path: '', Config: { User: '', Labels: {} }, HostConfig: { NetworkMode: 'default', ReadonlyRootfs: false, CapDrop: null, CapAdd: null, Memory: 0, MemorySwap: 0, SecurityOpt: null, PortBindings: {}, Mounts: [] }, Mounts: [], argv }
  let i = 1
  const take = () => argv[++i]!
  for (; i < argv.length; i++) {
    const f = argv[i]!
    if (!f.startsWith('--')) break
    if (f === '--rm' || f === '--read-only' || f === '--init') { if (f === '--read-only') c.HostConfig.ReadonlyRootfs = true; continue }
    const v = take()
    if (f === '--network') c.HostConfig.NetworkMode = v
    else if (f === '--entrypoint') c.Path = v
    else if (f === '--user') c.Config.User = v
    else if (f === '--cap-drop') c.HostConfig.CapDrop = [...(c.HostConfig.CapDrop ?? []), v]
    else if (f === '--cap-add') c.HostConfig.CapAdd = [...(c.HostConfig.CapAdd ?? []), v]
    else if (f === '--memory') c.HostConfig.Memory = Number(v)
    else if (f === '--memory-swap') c.HostConfig.MemorySwap = Number(v)
    else if (f === '--security-opt') c.HostConfig.SecurityOpt = [...(c.HostConfig.SecurityOpt ?? []), v]
    else if (f === '--label') { const [k, ...r] = v.split('='); c.Config.Labels[k!] = r.join('=') }
    else if (f === '--mount') {
      const m: Record<string, string | boolean> = {}
      for (const part of v.split(',')) { const [k, ...r] = part.split('='); m[k!] = r.length ? r.join('=') : true }
      c.HostConfig.Mounts.push({ Type: m.type, Source: m.source, Target: m.target, ReadOnly: !!m.readonly })
      c.Mounts.push(m.type === 'tmpfs' ? { Type: 'tmpfs', Source: '', Destination: m.target, RW: !m.readonly } : { Type: m.type, Source: m.type === 'bind' ? m.source : `/var/lib/docker/volumes/${m.source}/_data`, Name: m.type === 'volume' ? m.source : undefined, Destination: m.target, RW: !m.readonly })
    }
  }
  c.image = argv[i]; c.cmd = argv.slice(i + 1)
  const t = st.tamper ?? {}
  if (t.network) c.HostConfig.NetworkMode = t.network
  if (t.path) c.Path = t.path
  if (t.nmWritable) for (const m of c.Mounts) if (String(m.Name ?? '').includes('-nm-')) m.RW = true
  if (t.anonVolume) c.Mounts.push({ Type: 'volume', Name: 'anon123', Destination: '/data', RW: true })
  const id = (Object.keys(st.containers).length + 1).toString(16).padStart(12, '0') + 'abcdef'.repeat(2)
  st.containers[id] = c
  out(id); save(); process.exit(0)
}
if (sub === 'inspect') { const c = st.containers[argv[1]!]; if (!c) fail('no such container'); out(JSON.stringify([c])); process.exit(0) }
if (sub === 'start') {
  const id = argv[argv.length - 1]!
  const c = st.containers[id]
  if (!c) fail('no such container')
  const cmd: string[] = c.cmd.slice(1) // [ttl, ...argv]
  const vol = (c.Mounts.find((m: any) => m.Destination === '/v') ?? {}).Name
  if (cmd[0] === 'cat' && cmd[1] === '/v/.agentistics-volume') { const v = st.volumes[vol]; if (v?.marker) process.stdout.write(st.markerOverride ?? v.marker); save(); process.exit(v?.marker ? 0 : 1) }
  if (cmd[0] === 'sh' && /agentistics-volume/.test(cmd[2] ?? '')) {
    const m = /printf %s '([^']*)' >/.exec(cmd[2]!)
    if (st.volumes[vol]) st.volumes[vol].marker = m?.[1] ?? null
    save(); process.exit(0)
  }
  out(`FAKE-RUN ${cmd.join(' ')}`)
  if (st.sleepMs) await Bun.sleep(st.sleepMs)
  save(); process.exit(st.exitCode ?? 0)
}
if (sub === 'kill' || sub === 'rm' || sub === 'ps' || sub === 'wait' || sub === 'logs') { process.exit(0) }
fail(`fake docker: unsupported ${argv.join(' ')}`, 2)

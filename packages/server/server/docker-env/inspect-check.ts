/**
 * DOCKER.AMBIENTES S2 — what the daemon ACTUALLY did, checked before anything of the image runs (SPEC-r3 §3.3
 * step 7, §3.4). PURE: it reads the JSON `docker image inspect` / `docker inspect` printed.
 *
 * The argv guard says what we ASKED for; this says what we GOT. A container that differs in any checked field is
 * removed by id and the run refused — nothing of the image has executed yet, because the container was only
 * created (`create → inspect → start`).
 */
import { ENV_IMAGES, type EnvImage } from '@agentistics/core'
import { EXEC_WRAP, type ContainerPlan } from './docker-argv'

type Json = Record<string, any>

/** `docker image inspect <ref>` (one element). The digest must be a catalogue digest; ONBUILD must be empty. */
export function imageProblems(inspect: Json | null, image: EnvImage, images: readonly EnvImage[] = ENV_IMAGES): string[] {
  if (!inspect) return [`image ${image.key} is not present`]
  const out: string[] = []
  const known = new Set(images.map(i => i.ref))
  if (!known.has(image.ref)) out.push(`image ${image.ref} is not in the catalogue`)
  const digests: string[] = Array.isArray(inspect.RepoDigests) ? inspect.RepoDigests : []
  if (!digests.includes(image.ref)) out.push(`the local image does not carry the catalogue digest ${image.ref.split('@')[1]}`)
  const onBuild = inspect.Config?.OnBuild
  if (Array.isArray(onBuild) ? onBuild.length > 0 : onBuild != null) out.push('the image carries ONBUILD instructions')
  const vols = inspect.Config?.Volumes
  if (vols && typeof vols === 'object' && Object.keys(vols).length) out.push(`the image declares VOLUME ${Object.keys(vols).join(', ')} (an anonymous writable volume would appear)`)
  return out
}

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every(x => b.includes(x))

/** `docker inspect <id>` (one element) against the plan the container was created from. Empty = it matches. */
export function containerProblems(c: Json | null, plan: ContainerPlan): string[] {
  if (!c) return ['the container could not be inspected']
  const out: string[] = []
  const hc: Json = c.HostConfig ?? {}
  if (c.Path !== EXEC_WRAP) out.push(`Path is ${JSON.stringify(c.Path)}, not ${EXEC_WRAP}`)
  if (hc.NetworkMode !== 'none') out.push(`NetworkMode is ${JSON.stringify(hc.NetworkMode)}, not none`)
  if (hc.ReadonlyRootfs !== true) out.push('the root file system is writable')
  if (!Array.isArray(hc.CapDrop) || !hc.CapDrop.some((x: string) => /^(CAP_)?ALL$/i.test(x))) out.push('CapDrop is not ALL')
  const capAdd: string[] = Array.isArray(hc.CapAdd) ? hc.CapAdd.map((x: string) => x.replace(/^CAP_/i, '').toUpperCase()) : []
  if (!sameSet(capAdd, plan.capAdd ? [plan.capAdd] : [])) out.push(`CapAdd is ${JSON.stringify(hc.CapAdd ?? [])}`)
  if (hc.Privileged) out.push('the container is privileged')
  if (hc.Memory !== plan.memoryBytes) out.push(`Memory is ${hc.Memory}, not ${plan.memoryBytes}`)
  if (hc.MemorySwap !== plan.memoryBytes) out.push(`MemorySwap is ${hc.MemorySwap}, not ${plan.memoryBytes} (no swap)`)
  const ports = hc.PortBindings && Object.keys(hc.PortBindings).length
  if (ports || hc.PublishAllPorts) out.push('a port is published')
  if (c.Config?.User !== `${plan.user.uid}:${plan.user.gid}`) out.push(`User is ${JSON.stringify(c.Config?.User)}`)
  const secOpt: string[] = Array.isArray(hc.SecurityOpt) ? hc.SecurityOpt : []
  if (!secOpt.some(s => /^no-new-privileges(:true|=true)?$/.test(s))) out.push('no-new-privileges is not set')
  // Mounts: exactly the planned ones, at the planned destinations, with the planned rw-ness. tmpfs mounts are only
  // listed in HostConfig.Mounts; binds/volumes are in .Mounts (an anonymous volume from the image shows up there).
  const actual: Json[] = Array.isArray(c.Mounts) ? c.Mounts : []
  const planned = new Map(plan.mounts.filter(m => m.type !== 'tmpfs').map(m => [m.target, m]))
  const tmpfsPlannedAt = new Map(plan.mounts.filter(m => m.type === 'tmpfs').map(m => [m.target, m]))
  for (const m of actual) {
    if (m.Type === 'tmpfs') {
      // The daemon lists tmpfs mounts here too (Docker 29); they must be exactly the planned ones.
      const t = tmpfsPlannedAt.get(m.Destination)
      if (!t) out.push(`unexpected tmpfs at ${m.Destination}`)
      else if (m.RW === t.readonly) out.push(`${m.Destination}: tmpfs ${m.RW ? 'writable' : 'read-only'}, planned ${t.readonly ? 'read-only' : 'writable'}`)
      continue
    }
    const p = planned.get(m.Destination)
    if (!p) { out.push(`unexpected mount at ${m.Destination} (${m.Type})`); continue }
    planned.delete(m.Destination)
    if (m.Type !== p.type) out.push(`${m.Destination}: type ${m.Type}, planned ${p.type}`)
    if (m.RW === p.readonly) out.push(`${m.Destination}: ${m.RW ? 'writable' : 'read-only'}, planned ${p.readonly ? 'read-only' : 'writable'}`)
    if (p.type === 'volume' && m.Name !== p.source) out.push(`${m.Destination}: volume ${m.Name}, planned ${p.source}`)
    if (p.type === 'bind' && m.Source !== p.source) out.push(`${m.Destination}: source ${m.Source}, planned ${p.source}`)
  }
  for (const missing of planned.keys()) out.push(`planned mount missing at ${missing}`)
  const tmpfsActual: Json[] = (Array.isArray(hc.Mounts) ? hc.Mounts : []).filter((m: Json) => m.Type === 'tmpfs')
  const tmpfsPlanned = plan.mounts.filter(m => m.type === 'tmpfs')
  for (const t of tmpfsPlanned) if (!tmpfsActual.some(a => a.Target === t.target && !!a.ReadOnly === t.readonly)) out.push(`tmpfs ${t.target} missing or wrong`)
  if (tmpfsActual.length !== tmpfsPlanned.length) out.push('unexpected tmpfs mount')
  if (hc.Tmpfs && Object.keys(hc.Tmpfs).length) out.push('unexpected --tmpfs mount')
  for (const m of actual) if (/docker\.sock|containerd\.sock/.test(String(m.Source ?? ''))) out.push('the Docker socket is mounted')
  return out
}

/** §3.3: `node_modules` is writable ONLY in an install container. Checked on the PLAN (and the inspect re-checks rw-ness). */
export function nmWritableRefusal(plan: ContainerPlan, nmVolumePrefix: string): string | null {
  if (plan.kind === 'install-download' || plan.kind === 'install-scripts' || plan.kind === 'init') return null
  const bad = plan.mounts.find(m => m.type === 'volume' && m.source?.startsWith(nmVolumePrefix) && !m.readonly)
  return bad ? `node_modules (${bad.target}) is writable only during \`agentop env install\`` : null
}

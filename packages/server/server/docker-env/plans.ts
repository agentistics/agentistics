/**
 * DOCKER.AMBIENTES S2 — which container gets which mounts (SPEC-r3 §3.3, §3.5, §4). PURE.
 *
 * All writable state of a session outside the worktree lives in two volumes, mounted only by SUB-PATH (the root
 * holds the identity marker, §3.2): `scratch` (HOME = `home`, `/tmp` = `tmp`, the `node_modules/.cache` and
 * `.vite` of each workspace = `nmcache/<k>/…`) and `nm-g<gen>` (one sub-path per `node_modules` the lockfile
 * produces). With `--read-only` rootfs, a `--rm` container has NO writable place that dies with it: the worktree
 * (bind), `scratch`, `nm` and `/saida` all survive — `/tmp` included.
 *
 * `nm` is writable ONLY in the install containers; everywhere else it is mounted read-only (and `inspect`
 * re-checks it). The download container sees the worktree read-only and no `scratch`: no repo code runs there.
 */
import { OPT_DIR, type ContainerKind, type ContainerPlan, type MountSpec } from './docker-argv'

export interface NmSlot { key: string; /** relative dir of the package that owns this node_modules ('' = root) */ rel: string }

export interface SessionVolumes { scratch: string; nm: string; cache?: string }

export interface PlanInput {
  kind: ContainerKind
  name: string
  image: string
  uid: number
  gid: number
  memoryBytes: number
  root: string
  cwd: string
  envFile: string
  labels: Record<string, string>
  volumes: SessionVolumes
  nm: readonly NmSlot[]
  masks: readonly MountSpec[]
  optDir: string
  saidaDir: string
  /** install-download: the host dir holding `egress.sock`. serve: the host dir holding `ingress.sock`. */
  sockDir?: string
  ttlSec: number
  argv: string[]
}

export const nmKeyOf = (rel: string): string => rel === '' ? 'root' : rel.replace(/[^A-Za-z0-9._-]+/g, '__')
const join = (...p: string[]) => p.filter(Boolean).join('/').replace(/\/+/g, '/')

export function scratchSubdirs(nm: readonly NmSlot[]): string[] {
  return ['home', 'tmp', ...nm.flatMap(s => [`nmcache/${s.key}/.cache`, `nmcache/${s.key}/.vite`])]
}
export function nmSubdirs(nm: readonly NmSlot[]): string[] {
  return nm.flatMap(s => [s.key, `${s.key}/.cache`, `${s.key}/.vite`])
}

export function containerPlan(i: PlanInput): ContainerPlan {
  const nmWritable = i.kind === 'install-download' || i.kind === 'install-scripts'
  const mounts: MountSpec[] = []
  const worktreeRo = i.kind === 'install-download'
  mounts.push({ type: 'bind', source: i.root, target: i.root, readonly: worktreeRo })
  mounts.push(...i.masks)
  if (i.kind === 'install-download') {
    mounts.push({ type: 'tmpfs', target: '/home/agent', readonly: false })
    mounts.push({ type: 'tmpfs', target: '/tmp', readonly: false })
    if (i.volumes.cache) mounts.push({ type: 'volume', source: i.volumes.cache, subpath: 'data', target: '/cache', readonly: false })
  } else {
    mounts.push({ type: 'volume', source: i.volumes.scratch, subpath: 'home', target: '/home/agent', readonly: false })
    mounts.push({ type: 'volume', source: i.volumes.scratch, subpath: 'tmp', target: '/tmp', readonly: false })
  }
  for (const s of i.nm) {
    const target = join(i.root, s.rel, 'node_modules')
    mounts.push({ type: 'volume', source: i.volumes.nm, subpath: s.key, target, readonly: !nmWritable })
    if (i.kind !== 'install-download') {
      mounts.push({ type: 'volume', source: i.volumes.scratch, subpath: `nmcache/${s.key}/.cache`, target: `${target}/.cache`, readonly: false })
      mounts.push({ type: 'volume', source: i.volumes.scratch, subpath: `nmcache/${s.key}/.vite`, target: `${target}/.vite`, readonly: false })
    }
  }
  mounts.push({ type: 'bind', source: i.optDir, target: OPT_DIR, readonly: true })
  if (i.kind !== 'install-download') mounts.push({ type: 'bind', source: i.saidaDir, target: '/saida', readonly: false })
  if (i.sockDir) mounts.push({ type: 'bind', source: i.sockDir, target: '/run/agentistics', readonly: false })
  return {
    kind: i.kind, name: i.name, image: i.image, user: { uid: i.uid, gid: i.gid }, memoryBytes: i.memoryBytes,
    workdir: i.cwd, envFile: i.envFile, labels: i.labels, mounts, ttlSec: i.ttlSec, argv: i.argv,
  }
}

/** The init container: root of ONE volume at /v, user 0 with CHOWN only, writes the marker and hands sub-dirs to the user. */
export function initPlan(i: { name: string; image: string; volume: string; subdirs: readonly string[]; uid: number; gid: number; marker: string; envFile: string; labels: Record<string, string>; optDir: string; memoryBytes: number }): ContainerPlan {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
  const dirs = i.subdirs.map(d => q(`/v/${d}`)).join(' ')
  const script = `set -e; mkdir -p ${dirs}; printf %s ${q(i.marker)} > /v/.agentistics-volume; chmod 600 /v/.agentistics-volume; chown -R ${i.uid}:${i.gid} ${dirs}`
  return {
    kind: 'init', name: i.name, image: i.image, user: { uid: 0, gid: 0 }, memoryBytes: i.memoryBytes, workdir: '/',
    envFile: i.envFile, labels: i.labels, capAdd: 'CHOWN', ttlSec: 60, argv: ['sh', '-c', script],
    mounts: [{ type: 'volume', source: i.volume, target: '/v', readonly: false }, { type: 'bind', source: i.optDir, target: OPT_DIR, readonly: true }],
  }
}

/** A read-only look at a volume root (marker check): `cat /v/.agentistics-volume`. */
export function readMarkerPlan(i: { name: string; image: string; volume: string; envFile: string; labels: Record<string, string>; optDir: string; memoryBytes: number }): ContainerPlan {
  return {
    kind: 'read', name: i.name, image: i.image, user: { uid: 0, gid: 0 }, memoryBytes: i.memoryBytes, workdir: '/',
    envFile: i.envFile, labels: i.labels, ttlSec: 30, argv: ['cat', '/v/.agentistics-volume'],
    mounts: [{ type: 'volume', source: i.volume, target: '/v', readonly: true }, { type: 'bind', source: i.optDir, target: OPT_DIR, readonly: true }],
  }
}

/** Workspaces -> the node_modules slots (root first). Globs: a trailing `/*` only, resolved by the caller's dir list. */
export function nmSlots(workspaceDirs: readonly string[]): NmSlot[] {
  const rels = ['', ...[...new Set(workspaceDirs.map(d => d.replace(/^\.\/+|\/+$/g, '')).filter(d => d && !d.includes('..')))].sort()]
  return rels.map(rel => ({ key: nmKeyOf(rel), rel }))
}

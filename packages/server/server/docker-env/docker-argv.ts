/**
 * DOCKER.AMBIENTES S2 — the ONE place a `docker` argv is composed, and the ONE guard every docker call passes
 * through (SPEC-r3 §3.3, §3.4, §3.6). PURE.
 *
 * `buildCreateArgv` is the only producer of a `docker create`; `argvRefusal` is checked by the IO runner
 * (`docker-cli.ts`) on EVERY argv before it is executed, so a future caller that hand-writes an argv still cannot
 * publish a port, mount the Docker socket, join a network, run privileged or build an image. The checks are on
 * the argv itself (what the daemon will be told), and the post-create `inspect` (`inspect-check.ts`) re-checks
 * what the daemon actually did.
 */

export const EXEC_WRAP = '/opt/agentistics/exec-wrap'
export const OPT_DIR = '/opt/agentistics'

export type ContainerKind = 'cmd' | 'serve' | 'install-download' | 'install-scripts' | 'init' | 'read'

export interface MountSpec {
  type: 'bind' | 'volume' | 'tmpfs'
  /** Host path (bind) or volume name (volume). Absent for tmpfs. */
  source?: string
  target: string
  readonly: boolean
  /** `volume-subpath` (API >= 1.45): commands never mount a volume's ROOT. */
  subpath?: string
}

export interface ContainerPlan {
  kind: ContainerKind
  name: string
  /** `repo@sha256:…` from the catalogue. */
  image: string
  user: { uid: number; gid: number }
  memoryBytes: number
  workdir: string
  envFile: string
  labels: Record<string, string>
  mounts: MountSpec[]
  /** Seconds; exec-wrap applies it INSIDE with `timeout`, so a dead launcher still ends the command. */
  ttlSec: number
  argv: string[]
  /** Only the init container: `CHOWN` (and nothing else) so it can hand the fresh volume to the user. */
  capAdd?: 'CHOWN'
}

const mountArg = (m: MountSpec): string => {
  const parts = [`type=${m.type}`]
  if (m.source) parts.push(`source=${m.source}`)
  parts.push(`target=${m.target}`)
  if (m.subpath) parts.push(`volume-subpath=${m.subpath}`)
  if (m.readonly) parts.push('readonly')
  return parts.join(',')
}

/** The `docker create` argv (without the leading `docker`). The container is created, NOT started. */
export function buildCreateArgv(p: ContainerPlan): string[] {
  const a: string[] = ['create', '--rm', '--name', p.name,
    '--network', 'none',
    '--entrypoint', EXEC_WRAP,
    '--user', `${p.user.uid}:${p.user.gid}`,
    '--read-only',
    '--cap-drop', 'ALL']
  if (p.capAdd === 'CHOWN') a.push('--cap-add', 'CHOWN')
  a.push('--security-opt', 'no-new-privileges',
    '--pids-limit', '4096',
    '--init',
    '--restart', 'no',
    '--memory', String(p.memoryBytes),
    '--memory-swap', String(p.memoryBytes),
    '--oom-score-adj', '500',
    '--env-file', p.envFile,
    '--workdir', p.workdir)
  for (const [k, v] of Object.entries(p.labels).sort(([x], [y]) => x.localeCompare(y))) a.push('--label', `${k}=${v}`)
  for (const m of p.mounts) a.push('--mount', mountArg(m))
  a.push(p.image, String(p.ttlSec), ...p.argv)
  return a
}

/** Docker subcommands the runtime is allowed to issue at all. Anything else (build, buildx, network, system, …) is refused. */
const ALLOWED_SUB = new Set(['version', 'create', 'start', 'inspect', 'image', 'pull', 'kill', 'rm', 'volume', 'ps', 'system', 'wait', 'logs'])
const ALLOWED_IMAGE_SUB = new Set(['inspect'])
const ALLOWED_VOLUME_SUB = new Set(['inspect', 'create', 'rm', 'ls'])
const ALLOWED_SYSTEM_SUB = new Set(['df'])
const DOCKER_SOCKET = /docker\.sock|containerd\.sock|\/var\/run\/docker|\/run\/docker|podman\.sock/i

/**
 * Why this argv must not run, or `null`. Applied to every docker call, whoever composed it.
 * (`docker system df` is the read-only disk report the watchdog uses; `system prune` is refused like every other sub.)
 */
export function argvRefusal(argv: readonly string[]): string | null {
  const sub = argv[0]
  if (!sub || !ALLOWED_SUB.has(sub)) return `docker ${sub ?? ''}: not a command the environment runtime issues`
  if (sub === 'image' && !ALLOWED_IMAGE_SUB.has(argv[1] ?? '')) return `docker image ${argv[1] ?? ''}: refused (no build, no prune, no removal)`
  if (sub === 'volume' && !ALLOWED_VOLUME_SUB.has(argv[1] ?? '')) return `docker volume ${argv[1] ?? ''}: refused (never prune)`
  if (sub === 'system' && !ALLOWED_SYSTEM_SUB.has(argv[1] ?? '')) return `docker system ${argv[1] ?? ''}: refused (never prune)`
  for (const [i, arg] of argv.entries()) {
    // On `create`, a MOUNT naming the socket is the danger; the command's own words (after the image) may mention it harmlessly.
    const mountValue = argv[i - 1] === '--mount' || argv[i - 1] === '--env-file' || arg.startsWith('--mount=')
    if (DOCKER_SOCKET.test(arg) && (sub !== 'create' || mountValue)) return `the Docker socket is never mounted or named inside an environment (${arg.slice(0, 160)})`
    if (sub !== 'create') continue
    if (arg === '-p' || arg === '-P' || arg.startsWith('--publish') || /^-p\d/.test(arg)) return 'no port is ever published (ingress goes through a unix socket)'
    if (arg === '--privileged' || arg.startsWith('--privileged=')) return '--privileged is refused'
    if (arg === '-v' || arg === '--volume' || arg.startsWith('--volume=') || arg.startsWith('--volumes-from')) return 'mounts go through --mount only'
    if (arg === '--net' || arg.startsWith('--net=') || arg.startsWith('--network=')) return 'the network is always given as `--network none`'
    if (arg === '--network' && argv[i + 1] !== 'none') return 'every environment container runs with --network none'
    if ((arg === '--pid' || arg === '--ipc' || arg === '--uts' || arg === '--userns') && argv[i + 1] === 'host') return `${arg} host is refused`
    if (arg.startsWith('--pid=') || arg.startsWith('--ipc=') || arg.startsWith('--uts=') || arg.startsWith('--userns=')) return `${arg} is refused`
    if (arg === '--cap-add' && argv[i + 1] !== 'CHOWN') return `--cap-add ${argv[i + 1] ?? ''} is refused (only CHOWN, for the init container)`
    if (arg === '--device' || arg.startsWith('--device=') || arg === '--security-opt' && /unconfined|seccomp|apparmor|label/.test(argv[i + 1] ?? '')) return `${arg} ${argv[i + 1] ?? ''} is refused`
    if (arg === '--add-host' || arg.startsWith('--add-host=')) return '--add-host is refused'
  }
  if (sub === 'create') {
    const need = (flag: string, value?: string) => {
      const at = argv.indexOf(flag)
      return at >= 0 && (value === undefined || argv[at + 1] === value)
    }
    if (!need('--network', 'none')) return 'missing --network none'
    if (!need('--entrypoint', EXEC_WRAP)) return `missing --entrypoint ${EXEC_WRAP}`
    if (!need('--cap-drop', 'ALL')) return 'missing --cap-drop ALL'
    if (!need('--read-only')) return 'missing --read-only'
    if (!need('--user')) return 'missing --user'
    if (!need('--memory')) return 'missing --memory'
  }
  return null
}

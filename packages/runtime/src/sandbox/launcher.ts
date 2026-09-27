/**
 * sandbox/launcher.ts — how the shell starts a process, and what that start may honestly be called
 * (D-T5, owner decision 2026-09-25).
 *
 * ## The decision this implements
 *
 * The sandbox is OPTIONAL in v1: `setrlimit` + a capability probe (`./probe.ts`) + Docker as the
 * opt-in container. Four states are said in plain words (`./sentences.ts`): no sandbox · filesystem
 * only · full container · requested but unavailable. A mandatory sandbox was rejected — Codex's own
 * sandbox intermittently refuses to run under WSL (their issue #1039), so a mandatory one here would
 * be an agent that sometimes refuses to run.
 *
 * ## The rules that make the state honest
 *
 *  - **Resource limits are not containment.** `requested: 'rlimit'` bounds CPU, memory, file size,
 *    processes and descriptors and restricts nothing about what can be read or reached, so its state
 *    is `none` and its sentence says exactly that. Calling it a sandbox would be the green shield the
 *    spec forbids.
 *  - **`container` is claimed only when the probe EXERCISED Docker and it answered.** Anything else
 *    (binary absent, daemon down, socket permission denied, a probe that could not run) is
 *    `unavailable`, with the reason in words.
 *  - **Never downgrade silently.** A requested mechanism that is unavailable REFUSES every spawn, in
 *    words, unless the caller passed `fallbackUnsandboxed: true` explicitly — and then the sentence
 *    SAYS the command runs without a sandbox because the requested one was unavailable. The state
 *    stays `unavailable` in that case: the screen must still show that a request was not honoured.
 *  - **`filesystem-only` is RESERVED** for Landlock / bubblewrap (later, per D-T5). No v1 path
 *    produces it; its sentence exists so a host already renders all four states.
 *  - **A limit that cannot be applied is named**, never dropped: the `ulimit` fallback cannot express
 *    every limit on every shell (`./probe.ts` `UlimitFlags`), and inside a container the process
 *    count is `--pids-limit`, not `RLIMIT_NPROC`.
 *
 * Construction is pure given the probe (plus `process.getuid` when no Docker user is passed); `wrap`
 * is pure. The argv shapes live in `./wrap-argv.ts`.
 */

import type { SandboxLauncher, SandboxState, SpawnPlan } from '../tools/contract'
import type { SandboxProbe, UlimitFlags } from './probe'
import { SANDBOX_SENTENCES, type SandboxLang } from './sentences'
import {
  dockerRunArgv,
  ENV_NAME,
  hasLimits,
  invalidLimit,
  isInside,
  prlimitArgv,
  ulimitArgv,
  ulimitUnsupported,
  type DockerSettings,
  type LimitName,
  type ResourceLimits,
} from './wrap-argv'
import { isAbsolute } from 'path'

export type SandboxRequest = 'none' | 'rlimit' | 'docker'

export interface DockerOptions {
  image: string
  network?: 'none' | 'bridge'
  workspaceRoot: string
  /** docker `--memory` value, e.g. `2g`. Default `2g`. */
  memory?: string
  /** Default 256. */
  pidsLimit?: number
  /** `--read-only --tmpfs /tmp`. Default true: the workspace mount stays writable either way. */
  readOnlyRoot?: boolean
  /** Default: this process's uid/gid, so files written in the workspace belong to the user. */
  user?: { uid: number; gid: number }
}

export interface SandboxLauncherOptions {
  requested: SandboxRequest
  limits?: ResourceLimits
  docker?: DockerOptions
  probe: SandboxProbe
  /** Explicit opt-in to run unsandboxed when the requested mechanism is unavailable. Default false. */
  fallbackUnsandboxed?: boolean
}

export type UnavailableReason =
  | 'invalid-limits'
  | 'no-rlimit-mechanism'
  | 'no-limit-applicable'
  | 'docker-not-configured'
  | 'docker-invalid-config'
  | 'docker-no-uid'
  | 'docker-binary-absent'
  | 'docker-daemon-down'
  | 'docker-permission-denied'
  | 'docker-unknown'

export type Mechanism = 'none' | 'prlimit' | 'ulimit' | 'docker'

export interface SandboxLauncherInfo extends SandboxLauncher {
  readonly requested: SandboxRequest
  /** What actually wraps a spawn. */
  readonly mechanism: Mechanism
  readonly unavailableReason?: UnavailableReason
  /** Only on `unavailable`: true when `fallbackUnsandboxed` lets commands run anyway. */
  readonly runsUnsandboxed: boolean
  /** Configured limits the chosen mechanism does not apply. */
  readonly unappliedLimits: readonly LimitName[]
  readonly sentencePt: string
  describe(lang: SandboxLang): string
}

// ── Words ───────────────────────────────────────────────────────────────────────────────────────

type Bi = { en: string; pt: string }

const REASON: Record<UnavailableReason, Bi> = {
  'invalid-limits': {
    en: 'A configured resource limit is not a positive whole number.',
    pt: 'Um limite de recurso configurado não é um número inteiro positivo.',
  },
  'no-rlimit-mechanism': {
    en: 'Neither `prlimit` nor a POSIX `sh` with `ulimit` is available to apply resource limits.',
    pt: 'Nem o `prlimit` nem um `sh` POSIX com `ulimit` estão disponíveis para aplicar limites de recurso.',
  },
  'no-limit-applicable': {
    en: 'The only mechanism available (`ulimit`) cannot express any of the configured limits on this shell.',
    pt: 'O único mecanismo disponível (`ulimit`) não consegue expressar nenhum dos limites configurados neste shell.',
  },
  'docker-not-configured': {
    en: 'A container was requested without an image and a workspace to mount.',
    pt: 'Um contêiner foi pedido sem uma imagem e um workspace para montar.',
  },
  'docker-invalid-config': {
    en: 'The container settings are unusable (see the detail).',
    pt: 'As configurações do contêiner não podem ser usadas (veja o detalhe).',
  },
  'docker-no-uid': {
    en: 'This platform reports no user id to run the container as.',
    pt: 'Esta plataforma não informa um id de usuário para rodar o contêiner.',
  },
  'docker-binary-absent': {
    en: 'Docker is not installed (no `docker` on PATH).',
    pt: 'O Docker não está instalado (não há `docker` no PATH).',
  },
  'docker-daemon-down': {
    en: 'Docker is installed but its daemon is not running or cannot be reached.',
    pt: 'O Docker está instalado, mas o daemon não está rodando ou não pode ser alcançado.',
  },
  'docker-permission-denied': {
    en: 'This account has no permission on the Docker socket.',
    pt: 'Esta conta não tem permissão no socket do Docker.',
  },
  'docker-unknown': {
    en: 'Docker could not be checked (the probe did not answer), so it is not assumed to work.',
    pt: 'Não foi possível verificar o Docker (a sondagem não respondeu), então não se assume que funcione.',
  },
}

const LIMIT_WORD: Record<LimitName, Bi> = {
  cpuSeconds: { en: 'CPU time', pt: 'tempo de CPU' },
  addressSpaceBytes: { en: 'address space', pt: 'espaço de endereçamento' },
  fileSizeBytes: { en: 'file size', pt: 'tamanho de arquivo' },
  processes: { en: 'process count', pt: 'número de processos' },
  openFiles: { en: 'open files', pt: 'arquivos abertos' },
}

function fmtBytes(n: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1 && v % 1024 === 0) {
    v /= 1024
    i++
  }
  return `${v} ${units[i]}`
}

function limitValue(name: LimitName, v: number): string {
  if (name === 'cpuSeconds') return `${v} s`
  if (name === 'addressSpaceBytes' || name === 'fileSizeBytes') return fmtBytes(v)
  return String(v)
}

function limitsPhrase(limits: ResourceLimits, applied: readonly LimitName[], lang: SandboxLang): string {
  return applied
    .map((n) => `${LIMIT_WORD[n][lang]} ${limitValue(n, limits[n] as number)}`)
    .join(', ')
}

function namesPhrase(names: readonly LimitName[], lang: SandboxLang): string {
  return names.map((n) => LIMIT_WORD[n][lang]).join(', ')
}

// ── Construction ────────────────────────────────────────────────────────────────────────────────

type RlimitPick = { kind: 'prlimit' } | { kind: 'ulimit'; flags: UlimitFlags } | null

function pickRlimit(probe: SandboxProbe): RlimitPick {
  if (probe.prlimit.status === 'available') return { kind: 'prlimit' }
  if (probe.ulimit.status === 'available' && probe.ulimit.flags) return { kind: 'ulimit', flags: probe.ulimit.flags }
  return null
}

function configuredLimits(limits: ResourceLimits): LimitName[] {
  return (Object.keys(limits) as LimitName[]).filter((n) => limits[n] !== undefined)
}

interface Resolved {
  state: SandboxState
  mechanism: Mechanism
  reason?: UnavailableReason
  reasonDetail?: string
  unapplied: LimitName[]
  /** Builds the argv for a validated plan. */
  wrapArgv: (plan: SpawnPlan) => string[] | { refused: Bi }
  detail: (lang: SandboxLang) => string[]
}

function rlimitResolution(limits: ResourceLimits, pick: RlimitPick): Omit<Resolved, 'state'> | null {
  const configured = configuredLimits(limits)
  if (configured.length === 0) {
    return { mechanism: 'none', unapplied: [], wrapArgv: (p) => [...p.argv], detail: () => [] }
  }
  if (pick === null) return null
  if (pick.kind === 'prlimit') {
    return {
      mechanism: 'prlimit',
      unapplied: [],
      wrapArgv: (p) => prlimitArgv(limits, p.argv),
      detail: (lang) => [appliedSentence(limits, configured, lang)],
    }
  }
  const unapplied = ulimitUnsupported(limits, pick.flags)
  const applied = configured.filter((n) => !unapplied.includes(n))
  if (applied.length === 0) return null
  return {
    mechanism: 'ulimit',
    unapplied,
    wrapArgv: (p) => ulimitArgv(limits, pick.flags, p.argv),
    detail: (lang) => [appliedSentence(limits, applied, lang), ...unappliedSentence(unapplied, lang)],
  }
}

function appliedSentence(limits: ResourceLimits, applied: readonly LimitName[], lang: SandboxLang): string {
  return lang === 'en'
    ? `Resource limits apply (${limitsPhrase(limits, applied, 'en')}), but they are not containment: nothing restricts what can be read or reached.`
    : `Limites de recurso se aplicam (${limitsPhrase(limits, applied, 'pt')}), mas não são contenção: nada restringe o que pode ser lido ou alcançado.`
}

function unappliedSentence(unapplied: readonly LimitName[], lang: SandboxLang): string[] {
  if (unapplied.length === 0) return []
  return [
    lang === 'en'
      ? `Not applied, because this shell's ulimit cannot express it: ${namesPhrase(unapplied, 'en')}.`
      : `Não aplicado, porque o ulimit deste shell não consegue expressar: ${namesPhrase(unapplied, 'pt')}.`,
  ]
}

function validateDocker(d: DockerOptions): string | null {
  if (typeof d.image !== 'string' || d.image.trim() === '' || /\s/.test(d.image) || d.image.startsWith('-')) {
    return 'image must be a non-empty image reference'
  }
  if (!isAbsolute(d.workspaceRoot)) return 'workspaceRoot must be an absolute path'
  if (d.workspaceRoot.includes(':')) return 'workspaceRoot contains ":", which `-v src:dst` cannot express'
  if (d.memory !== undefined && !/^\d+[bkmg]?$/i.test(d.memory)) return 'memory must look like 512m or 2g'
  if (d.pidsLimit !== undefined && (!Number.isSafeInteger(d.pidsLimit) || d.pidsLimit <= 0)) {
    return 'pidsLimit must be a positive whole number'
  }
  if (d.network !== undefined && d.network !== 'none' && d.network !== 'bridge') return 'network must be none or bridge'
  return null
}

function dockerProbeReason(probe: SandboxProbe): UnavailableReason | null {
  const d = probe.docker
  if (d.status === 'available') return null
  if (d.status === 'unknown') return 'docker-unknown'
  switch (d.reason) {
    case 'binary-absent':
      return 'docker-binary-absent'
    case 'daemon-down':
      return 'docker-daemon-down'
    case 'permission-denied':
      return 'docker-permission-denied'
    default:
      return 'docker-unknown'
  }
}

function currentUser(): { uid: number; gid: number } | null {
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  const gid = typeof process.getgid === 'function' ? process.getgid() : undefined
  return uid === undefined || gid === undefined ? null : { uid, gid }
}

function resolve(opts: SandboxLauncherOptions): Resolved {
  const limits = opts.limits ?? {}
  const unavailable = (reason: UnavailableReason, reasonDetail?: string): Resolved => ({
    state: 'unavailable',
    mechanism: 'none',
    reason,
    ...(reasonDetail !== undefined ? { reasonDetail } : {}),
    unapplied: configuredLimits(limits),
    wrapArgv: (p) => [...p.argv],
    detail: () => [],
  })

  const bad = invalidLimit(limits)
  if (bad !== null && opts.requested !== 'none') return unavailable('invalid-limits', bad)

  if (opts.requested === 'none') {
    const configured = configuredLimits(limits)
    return {
      state: 'none',
      mechanism: 'none',
      unapplied: configured,
      wrapArgv: (p) => [...p.argv],
      detail: (lang) =>
        configured.length === 0
          ? []
          : [
              lang === 'en'
                ? 'Resource limits were configured but are not applied: no limit mechanism was requested.'
                : 'Limites de recurso foram configurados, mas não são aplicados: nenhum mecanismo de limite foi pedido.',
            ],
    }
  }

  if (opts.requested === 'rlimit') {
    const pick = pickRlimit(opts.probe)
    const r = rlimitResolution(limits, pick)
    if (r === null) return unavailable(pick === null ? 'no-rlimit-mechanism' : 'no-limit-applicable')
    return {
      state: 'none',
      ...r,
      detail: (lang) => {
        const d = r.detail(lang)
        return d.length > 0
          ? d
          : [lang === 'en' ? 'No resource limits were configured.' : 'Nenhum limite de recurso foi configurado.']
      },
    }
  }

  // docker
  const d = opts.docker
  if (d === undefined) return unavailable('docker-not-configured')
  const invalid = validateDocker(d)
  if (invalid !== null) return unavailable('docker-invalid-config', invalid)
  const user = d.user ?? currentUser()
  if (user === null) return unavailable('docker-no-uid')
  const probeReason = dockerProbeReason(opts.probe)
  if (probeReason !== null) return unavailable(probeReason, opts.probe.docker.detail)

  const settings: DockerSettings = {
    image: d.image,
    network: d.network ?? 'none',
    workspaceRoot: d.workspaceRoot,
    memory: d.memory ?? '2g',
    pidsLimit: d.pidsLimit ?? 256,
    readOnlyRoot: d.readOnlyRoot ?? true,
    uid: user.uid,
    gid: user.gid,
  }
  const unapplied: LimitName[] = limits.processes !== undefined ? ['processes'] : []
  return {
    state: 'container',
    mechanism: 'docker',
    unapplied,
    wrapArgv: (p) => {
      if (!isInside(settings.workspaceRoot, p.cwd)) {
        return {
          refused: {
            en: `Refused: the working directory ${p.cwd} is outside the workspace ${settings.workspaceRoot}, and the container sees only the workspace.`,
            pt: `Recusado: o diretório de trabalho ${p.cwd} está fora do workspace ${settings.workspaceRoot}, e o contêiner só enxerga o workspace.`,
          },
        }
      }
      const badName = Object.keys(p.env).find((n) => !ENV_NAME.test(n))
      if (badName !== undefined) {
        return {
          refused: {
            en: `Refused: the environment variable name ${JSON.stringify(badName)} cannot be passed into a container.`,
            pt: `Recusado: o nome de variável de ambiente ${JSON.stringify(badName)} não pode ser passado para um contêiner.`,
          },
        }
      }
      return dockerRunArgv(settings, p, limits)
    },
    detail: (lang) => {
      const out: string[] = []
      out.push(
        settings.network === 'none'
          ? lang === 'en'
            ? 'The container has no network.'
            : 'O contêiner não tem rede.'
          : lang === 'en'
            ? 'The container HAS network access (bridge): it can reach this machine\'s network and the internet.'
            : 'O contêiner TEM acesso à rede (bridge): ele alcança a rede desta máquina e a internet.',
      )
      if (!settings.readOnlyRoot) {
        out.push(
          lang === 'en'
            ? 'The container\'s own filesystem is writable.'
            : 'O sistema de arquivos do próprio contêiner é gravável.',
        )
      }
      out.push(
        lang === 'en'
          ? `Limits: memory ${settings.memory}, at most ${settings.pidsLimit} processes.`
          : `Limites: memória ${settings.memory}, no máximo ${settings.pidsLimit} processos.`,
      )
      const applied = configuredLimits(limits).filter((n) => n !== 'processes')
      if (applied.length > 0) {
        out.push(
          lang === 'en'
            ? `Resource limits inside the container: ${limitsPhrase(limits, applied, 'en')}.`
            : `Limites de recurso dentro do contêiner: ${limitsPhrase(limits, applied, 'pt')}.`,
        )
      }
      if (unapplied.length > 0) {
        out.push(
          lang === 'en'
            ? 'The configured process count is not applied as RLIMIT_NPROC inside the container (it would count the whole account); the pids limit bounds processes instead.'
            : 'O número de processos configurado não é aplicado como RLIMIT_NPROC no contêiner (contaria a conta inteira); o limite de pids limita os processos.',
        )
      }
      return out
    },
  }
}

// ── The launcher ────────────────────────────────────────────────────────────────────────────────

export function createSandboxLauncher(opts: SandboxLauncherOptions): SandboxLauncherInfo {
  let r = resolve(opts)
  const fallback = r.state === 'unavailable' && opts.fallbackUnsandboxed === true

  // A fallback still applies the resource limits it can (they are not a sandbox, but they are what
  // the caller asked for as far as this machine allows); it NEVER claims containment.
  let fallbackMechanism: Omit<Resolved, 'state'> | null = null
  if (fallback) {
    const limits = opts.limits ?? {}
    fallbackMechanism =
      invalidLimit(limits) === null && hasLimits(limits) ? rlimitResolution(limits, pickRlimit(opts.probe)) : null
    if (fallbackMechanism !== null) {
      r = { ...r, mechanism: fallbackMechanism.mechanism, unapplied: fallbackMechanism.unapplied, wrapArgv: fallbackMechanism.wrapArgv }
    }
  }

  const describe = (lang: SandboxLang): string => {
    const parts = [SANDBOX_SENTENCES[r.state][lang]]
    if (r.state === 'unavailable' && r.reason !== undefined) {
      parts.push(REASON[r.reason][lang] + (r.reasonDetail ? ` (${r.reasonDetail})` : ''))
      if (fallback) {
        parts.push(
          lang === 'en'
            ? 'Commands are running WITHOUT a sandbox, because running unsandboxed was explicitly allowed when the requested one is unavailable: the agent can read anything this account can read, reach the network and run arbitrary code.'
            : 'Os comandos estão rodando SEM sandbox, porque rodar sem sandbox foi permitido explicitamente quando o pedido não está disponível: o agente pode ler tudo o que esta conta lê, acessar a rede e executar código arbitrário.',
        )
        if (fallbackMechanism !== null) parts.push(...fallbackMechanism.detail(lang))
      } else {
        parts.push(
          lang === 'en'
            ? 'Commands are refused until it is available or the request is changed.'
            : 'Os comandos são recusados até que ele esteja disponível ou o pedido seja alterado.',
        )
      }
    } else {
      parts.push(...r.detail(lang))
    }
    return parts.join(' ')
  }

  const sentence = describe('en')
  const sentencePt = describe('pt')

  const wrap = (plan: SpawnPlan): SpawnPlan | { refused: string } => {
    if (plan.argv.length === 0) return { refused: 'Refused: there is no command to run (empty argv).' }
    if (r.state === 'unavailable' && !fallback) return { refused: sentence }
    const out = r.wrapArgv(plan)
    if (!Array.isArray(out)) return { refused: out.refused.en }
    return { argv: out, cwd: plan.cwd, env: { ...plan.env } }
  }

  return {
    state: r.state,
    sentence,
    sentencePt,
    requested: opts.requested,
    mechanism: r.mechanism,
    ...(r.reason !== undefined ? { unavailableReason: r.reason } : {}),
    runsUnsandboxed: fallback,
    unappliedLimits: r.unapplied,
    describe,
    wrap,
  }
}

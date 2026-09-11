import type { LiveUnavailableReason, SessionMeta } from '@agentistics/core'

export const LIVE_THRESHOLD_MIN = 10

/** Epoch ms of the session's last activity: end_time → last user timestamp → start_time. 0 if none. */
export function lastActivityMs(s: SessionMeta): number {
  const candidates: string[] = []
  if (s.end_time) candidates.push(s.end_time)
  const ts = s.user_message_timestamps
  if (ts && ts.length > 0) candidates.push(ts[ts.length - 1]!)
  if (s.start_time) candidates.push(s.start_time)
  for (const c of candidates) {
    const t = Date.parse(c)
    if (!Number.isNaN(t)) return t
  }
  return 0
}

export function isLive(s: SessionMeta, nowMs: number, thresholdMin: number = LIVE_THRESHOLD_MIN): boolean {
  const last = lastActivityMs(s)
  if (last <= 0) return false
  return nowMs - last <= thresholdMin * 60_000
}

/** What the "Open now" panel says when it has nothing to show. */
export interface LiveEmptyNotice {
  /** The headline sentence. */
  title: string
  /** Why, and what to do about it. Empty when the plain "nothing is open" is the whole truth. */
  detail: string
}

/**
 * The ONE place that decides what an empty "Open now" means.
 *
 * An empty list has three completely different causes and only one of them is "nobody is working":
 *
 *  - **Detection is impossible here.** A container without `pid: host` cannot see a host process;
 *    one running under a uid that may not ptrace the host user cannot read its cwd; a non-Linux
 *    host has no /proc at all. Rendering `0` for any of those is the confident zero CLAUDE.md
 *    forbids for harness capabilities — and worse, because it never self-corrects.
 *  - **This is a central.** It never reads its own /proc for this; members report their own
 *    snapshots, and a member's sharing rules apply to that channel exactly as they do to its
 *    metrics. A repository withheld from this central does not appear here either — which is
 *    correct, and invisible unless it is said.
 *  - **Nothing is open.** The only case the plain sentence is true for.
 *
 * Pure, so every branch is testable without a /proc or a browser.
 */
export function liveEmptyNotice(o: {
  count: number
  central?: boolean
  unavailable?: LiveUnavailableReason
  lang: 'pt' | 'en'
}): LiveEmptyNotice | null {
  if (o.count > 0) return null
  const pt = o.lang === 'pt'
  // A central's own host processes are beside the point, so its reason is never shown: the
  // question there is always about the members.
  if (o.central) {
    return {
      title: pt
        ? 'Nenhuma máquina está reportando um assistente aberto agora.'
        : 'No machine is reporting an open assistant right now.',
      detail: pt
        ? 'As máquinas reportam as próprias sessões abertas por WebSocket. Um repositório ou projeto que uma máquina não compartilha com esta central também não aparece aqui.'
        : 'Machines report their own open sessions over the reverse WebSocket. A repository or project a machine does not share with this central does not appear here either.',
    }
  }
  const reason = o.unavailable
  if (!reason) {
    return {
      title: pt ? 'Nenhuma sessão aberta agora.' : 'No sessions open right now.',
      detail: '',
    }
  }
  const title = pt
    ? 'Não é possível detectar sessões abertas nesta configuração.'
    : 'Live sessions cannot be detected in this setup.'
  const detail = LIVE_UNAVAILABLE_DETAIL[reason][pt ? 'pt' : 'en']
  return { title, detail }
}

/** Why each configuration cannot see the host's assistants, and what to change. EN + PT. */
const LIVE_UNAVAILABLE_DETAIL: Record<LiveUnavailableReason, { en: string; pt: string }> = {
  'unsupported-platform': {
    en: 'Open assistants are detected by reading Linux’s /proc or macOS’s process list. Neither exists here (Windows). Everything else on this page is unaffected — WSL on this same machine can run agentop with live detection.',
    pt: 'Assistentes abertos são detectados lendo o /proc do Linux ou a lista de processos do macOS. Nenhum dos dois existe aqui (Windows). O resto desta página não é afetado — o WSL nesta mesma máquina roda o agentop com detecção ao vivo.',
  },
  'no-proc': {
    en: '/proc could not be read, so no running assistant can be observed.',
    pt: 'Não foi possível ler /proc, então nenhum assistente em execução pode ser observado.',
  },
  'no-ps': {
    en: 'This machine’s `ps`/`lsof` could not be run, so no running assistant can be observed.',
    pt: 'Não foi possível executar `ps`/`lsof` nesta máquina, então nenhum assistente em execução pode ser observado.',
  },
  'container-isolated': {
    en: 'This machine runs in a container with its own process namespace, so assistants running on the host are invisible to it. Add `pid: host` to docker/machine.yml, or run the machine natively.',
    pt: 'Esta máquina roda em um container com namespace de processos próprio, então assistentes que rodam no host são invisíveis para ela. Adicione `pid: host` ao docker/machine.yml, ou rode a máquina nativamente.',
  },
  'permission-denied': {
    en: 'The host processes are visible but their working directories are not: reading them requires the same user id. Run the container as the host user (see the commented `user:` line in docker/machine.yml), or run the machine natively.',
    pt: 'Os processos do host são visíveis, mas seus diretórios de trabalho não: lê-los exige o mesmo id de usuário. Rode o container como o usuário do host (veja a linha `user:` comentada em docker/machine.yml), ou rode a máquina nativamente.',
  },
  'capability-off': {
    en: 'This instance is exposed on a network, so reading the host process list is disabled. A working directory is usually a repository name.',
    pt: 'Esta instância está exposta em rede, então a leitura da lista de processos do host está desativada. Um diretório de trabalho normalmente é o nome de um repositório.',
  },
}

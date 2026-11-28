/**
 * What an uninstall may do, and the sentences it says. No I/O of its own: the facts, the live
 * sessions and the ancestry check are handed in, and the route in `harness-install.ts` runs the
 * result under the install's own lock, runner, stream and log.
 *
 * It refuses while the harness has a live session, and when agentop itself runs inside one.
 */
import {
  HARNESS_KEPT_DATA, planHarnessUninstall,
  type HarnessUninstallFacts, type HarnessUninstallPlan, type UninstallHarness,
} from './harness-uninstall-plan'

export interface UninstallChecks {
  /** Where the binary is. Injected so a test never looks at the real PATH. */
  facts: (harness: UninstallHarness) => Promise<HarnessUninstallFacts>
  /** One short description per live session of this harness. Throws when it cannot be established. */
  liveSessions: (harness: UninstallHarness) => Promise<string[]>
  /** Is this server a descendant of a running process of this harness? */
  runningInside: (harness: UninstallHarness) => Promise<boolean>
}

/** PURE. `lost`, `exited` and `closed` rows have nothing running; every other one does. */
export function liveRowsOf(
  harness: UninstallHarness,
  rows: readonly { id: string; harness?: string; status: string; cwd: string; label?: string; harnessName?: string }[],
): string[] {
  return rows
    .filter(r => r.harness === harness && (r.status === 'running' || r.status === 'external' || r.status === 'unregistered'))
    .map(r => `${r.label || r.harnessName || r.id} (${r.cwd})`)
}

export const UNINSTALL_SAY = {
  pt: {
    removing: 'Desinstalando…', verifying: 'Conferindo se saiu…', done: 'Desinstalação concluída.',
    fail: 'Não consegui desinstalar.', still: 'O programa continua no computador. Nada mais foi alterado.',
    other: (p: string) => `Removido. Ainda existe outra cópia em ${p}.`,
    inside: (id: string) => `O agentistics está rodando dentro de uma sessão do ${id}; desinstalar agora quebraria essa sessão. Encerre-a e abra o agentistics fora dela.`,
    live: (list: string) => `Há sessões abertas deste assistente. Encerre antes de desinstalar: ${list}`,
    unknown: 'Não consegui conferir se há sessões abertas deste assistente, então não vou desinstalar.',
    missing: 'Não encontrei este programa no computador.',
    busy: 'Outra instalação está em andamento. Espere terminar e tente de novo.',
  },
  en: {
    removing: 'Uninstalling…', verifying: 'Checking it is gone…', done: 'Uninstall complete.',
    fail: 'Could not uninstall it.', still: 'The program is still on this computer. Nothing else was changed.',
    other: (p: string) => `Removed. Another copy still exists at ${p}.`,
    inside: (id: string) => `agentistics is running inside a ${id} session; uninstalling it now would break that session. End it and start agentistics outside of it.`,
    live: (list: string) => `This assistant has open sessions. End them before uninstalling: ${list}`,
    unknown: 'I could not check whether this assistant has open sessions, so I will not uninstall it.',
    missing: 'I could not find this program on this computer.',
    busy: 'Another install is running. Wait for it to finish and try again.',
  },
} as const

export interface UninstallPreview {
  reason: HarnessUninstallPlan['reason'] | 'live-sessions' | 'running-inside' | 'live-unknown'
  removes: string[]
  keeps: string[]
  /** The sentence for every reason but `ok`. */
  message?: string
}

export async function previewUninstall(
  id: UninstallHarness, checks: UninstallChecks, lang: 'pt' | 'en',
): Promise<{ view: UninstallPreview; plan: HarnessUninstallPlan }> {
  const say = UNINSTALL_SAY[lang]
  const plan = planHarnessUninstall(id, await checks.facts(id))
  const view: UninstallPreview = { reason: plan.reason, removes: plan.removes, keeps: HARNESS_KEPT_DATA[id] }
  if (plan.reason === 'not-installed') return { plan, view: { ...view, message: say.missing } }
  try {
    if (await checks.runningInside(id)) return { plan, view: { ...view, reason: 'running-inside', message: say.inside(id) } }
    const live = await checks.liveSessions(id)
    if (live.length > 0) {
      const list = `${live.slice(0, 5).join('; ')}${live.length > 5 ? ` (+${live.length - 5})` : ''}`
      return { plan, view: { ...view, reason: 'live-sessions', message: say.live(list) } }
    }
  } catch {
    return { plan, view: { ...view, reason: 'live-unknown', message: say.unknown } }
  }
  if (plan.reason === 'manual') return { plan, view: { ...view, message: plan.manual![lang] } }
  return { plan, view }
}

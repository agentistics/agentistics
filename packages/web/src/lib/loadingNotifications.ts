import type { StartupStripState } from './startupLoad'
import type { JournalBackfillSummary } from './journalBackfill'

export interface LoadingNotification {
  type: 'info' | 'success' | 'warning'
  title: string
  message: string
  meta: Record<string, unknown>
}

export function startupLoadingNotification(s: StartupStripState, lang: 'pt' | 'en'): LoadingNotification | null {
  const pt = lang === 'pt'
  if (!s.partial && !(s.deferredRepos && s.deferredRepos > 0)) return null
  const pct = s.projects !== undefined && s.projects > 0 && s.projects < 1 ? ` — ${Math.floor(s.projects * 100)}%` : ''
  const message = s.partial
    ? s.partialReason === 'snapshot'
      ? (pt ? `Mostrando os dados da última vez — atualizando${pct}…` : `Showing your data from last time — refreshing${pct}…`)
      : (pt ? `Ainda carregando projetos, sessões e repositórios${pct}. Pode usar o app enquanto isso.` : `Still loading projects, sessions and repositories${pct}. You can use the app meanwhile.`)
    : (() => {
        const n = s.deferredRepos!
        return pt
          ? `${n} ${n === 1 ? 'repositório está' : 'repositórios estão'} demorando para responder; os números de git ${n === 1 ? 'dele aparecem' : 'deles aparecem'} quando ${n === 1 ? 'ele terminar' : 'terminarem'}.`
          : `${n} ${n === 1 ? 'repository is' : 'repositories are'} slow to read; ${n === 1 ? 'its' : 'their'} git figures appear when ${n === 1 ? 'it finishes' : 'they finish'}.`
      })()
  return {
    type: 'info',
    title: pt ? 'Carregamento em andamento' : 'Loading in progress',
    message,
    meta: { notificationKey: 'loading.startup', loadingKind: 'startup', state: 'running' },
  }
}

export function journalLoadingNotification(b: JournalBackfillSummary | null | undefined, lang: 'pt' | 'en'): LoadingNotification | null {
  if (!b) return null
  const pt = lang === 'pt'
  const n = b.written.toLocaleString(pt ? 'pt-BR' : 'en-US')
  const where = b.harness ? ` · ${b.harness}${b.done !== null && b.total !== null ? ` ${b.done}/${b.total}` : ''}` : ''
  const tail = pt ? ' — até terminar, os números vêm do caminho anterior.' : ' — until it completes, the figures come from the previous path.'
  const message = pt
    ? b.state === 'pending' ? `O histórico desta máquina ainda vai ser importado para o journal, em segundo plano${tail}`
      : b.state === 'paused' ? `Importação do histórico pausada: a máquina está sem memória folgada${where} · ${n} eventos${tail}`
        : b.state === 'interrupted' ? `Importação do histórico interrompida${where} · ${n} eventos; ela continua no próximo início do servidor${tail}`
          : b.state === 'failed' ? `A importação do histórico falhou.`
            : b.state === 'done' ? 'A importação do histórico foi concluída.'
              : `Importando o histórico desta máquina para o journal${where} · ${n} eventos${tail}`
    : b.state === 'pending' ? `This machine's history is still to be imported into the journal, in the background${tail}`
      : b.state === 'paused' ? `History import paused: the machine is short on memory${where} · ${n} events${tail}`
        : b.state === 'interrupted' ? `History import interrupted${where} · ${n} events; it resumes on the next server start${tail}`
          : b.state === 'failed' ? 'The history import failed.'
            : b.state === 'done' ? 'The history import is complete.'
              : `Importing this machine's history into the journal${where} · ${n} events${tail}`
  return {
    type: b.state === 'failed' ? 'warning' : b.state === 'done' ? 'success' : 'info',
    title: pt ? 'Importação do histórico' : 'History import',
    message,
    meta: { notificationKey: 'loading.journal', loadingKind: 'journal', state: b.state },
  }
}

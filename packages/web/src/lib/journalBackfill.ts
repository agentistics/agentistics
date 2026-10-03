/**
 * The one line the web shows while the journal's first import runs (`journal/backfill.ts` on the
 * server): what it is doing, and that the figures come from /api/data until it completes. `null` is
 * "nothing to say": the import completed, the journal is off, or this is a central.
 */
export interface JournalBackfillSummary {
  state: 'pending' | 'running' | 'paused' | 'interrupted' | 'failed' | 'done'
  written: number
  harness: string | null
  done: number | null
  total: number | null
}

export function journalBackfillText(b: JournalBackfillSummary | null | undefined, lang: 'pt' | 'en'): string | null {
  if (!b) return null
  const n = b.written.toLocaleString(lang === 'pt' ? 'pt-BR' : 'en-US')
  const where = b.harness ? ` · ${b.harness}${b.done !== null && b.total !== null ? ` ${b.done}/${b.total}` : ''}` : ''
  const tail = lang === 'pt'
    ? ' — até terminar, os números vêm do caminho anterior.'
    : ' — until it completes, the figures come from the previous path.'
  if (lang === 'pt') {
    switch (b.state) {
      case 'pending': return `O histórico desta máquina ainda vai ser importado para o journal, em segundo plano${tail}`
      case 'paused': return `Importação do histórico pausada: a máquina está sem memória folgada${where} · ${n} eventos${tail}`
      case 'interrupted': return `Importação do histórico interrompida${where} · ${n} eventos; ela continua no próximo início do servidor${tail}`
      case 'failed': return `A importação do histórico falhou; rode \`agentop journal import\` para ver o motivo${tail}`
      default: return `Importando o histórico desta máquina para o journal${where} · ${n} eventos${tail}`
    }
  }
  switch (b.state) {
    case 'pending': return `This machine's history is still to be imported into the journal, in the background${tail}`
    case 'paused': return `History import paused: the machine is short on memory${where} · ${n} events${tail}`
    case 'interrupted': return `History import interrupted${where} · ${n} events; it resumes on the next server start${tail}`
    case 'failed': return `The history import failed; run \`agentop journal import\` to see why${tail}`
    default: return `Importing this machine's history into the journal${where} · ${n} events${tail}`
  }
}

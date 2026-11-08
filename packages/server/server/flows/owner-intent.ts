/**
 * owner-intent.ts — FLUXO.AVISOS: what an owner message ASKS FOR, decided by a deterministic host rule.
 *
 * A pedido is a request for WORK. The owner also asks the leader questions ("e o deploy?", "por que falhou?"),
 * and every one of those used to become a high-priority "Pedido do dono" that the delivery tick then nudged
 * the leader about — 8 automatic nudges in an hour on the Mac leader, most of them for questions that had
 * already been answered. The host classifies the text; the engine decides what to do with the answer
 * (a `question` is recorded already answered: no subtask, no reminder).
 *
 * The rule errs toward `work`: a missed question costs one needless reminder, a missed request costs the
 * owner's work being forgotten.
 *  - a polite request ("can you …/pode …/quero …/precisa …") → `work`, even when the text ends in "?"
 *  - a trailing "?" → `question`, unless a verb stands in VERB POSITION ("faz o deploy?")
 *  - otherwise a strong verb anywhere, or a verb in verb position → `work`
 *  - otherwise only a tiny text (≤ 3 words: "opcao C", "status") is a `question`; a longer statement is a report → `work`
 *  - word boundaries are Unicode-aware: "publicação" does not contain the verb "publica"
 */

export type OwnerIntent = 'question' | 'work'

/** Attachment references and pasted blobs are not words the owner wrote. */
export function ownerTextWords(text: string): string {
  return withoutQuotePrefixes(text)
    .replace(/!?\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/(?:^|\s)(?:\/|~\/|[A-Za-z]:\\)[^\s]*\.(?:png|jpe?g|gif|webp|pdf|txt|md|log|json|csv)\b/gi, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const IMPERATIVE = [
  // pt
  'faz', 'faça', 'fazer', 'corrige', 'corrija', 'conserta', 'conserte', 'arruma', 'arrume', 'implementa', 'implemente',
  'cria', 'crie', 'adiciona', 'adicione', 'remove', 'remova', 'apaga', 'apague', 'manda', 'mande', 'envia', 'envie',
  'muda', 'mude', 'troca', 'troque', 'ajusta', 'ajuste', 'atualiza', 'atualize', 'move', 'mova', 'publica', 'publique',
  'roda', 'rode', 'executa', 'execute', 'escreve', 'escreva', 'commita', 'commite', 'sobe', 'suba', 'libera', 'libere',
  'testa', 'teste', 'revisa', 'revise', 'investiga', 'investigue', 'analisa', 'analise', 'mostra', 'mostre', 'coloca',
  'coloque', 'põe', 'ponha', 'tira', 'tire', 'deixa', 'deixe', 'continua', 'continue', 'siga', 'começa', 'comece',
  'pare', 'cancela', 'cancele', 'abre', 'abra', 'fecha', 'feche', 'mata', 'mate', 'reabre', 'reabra', 'integra',
  'integre', 'dispara', 'dispare', 'prioriza', 'priorize', 'verifica', 'verifique', 'confere', 'confira', 'refaz', 'refaça',
  'segue', 'bora', 'vai', 'implementar', 'corrigir', 'criar', 'adicionar', 'remover', 'enviar', 'mudar', 'trocar', 'ajustar', 'atualizar',
  // en
  'fix', 'add', 'create', 'implement', 'make', 'change', 'update', 'remove', 'delete', 'send', 'run', 'build', 'write',
  'ship', 'deploy', 'release', 'merge', 'push', 'open', 'close', 'kill', 'start', 'stop', 'move', 'rename', 'replace',
  'continue', 'resume', 'check', 'review', 'investigate', 'test', 'show', 'put', 'set', 'use', 'try', 'redo', 'refactor',
]
const ADDED = [
  'resolve', 'resolva', 'resolver', 'refatora', 'refatore', 'tenta', 'tente', 'limpa', 'limpe', 'reverte', 'reverta', 'desfaz',
  'reinicia', 'reinicie', 'instala', 'instale', 'ativa', 'ative', 'desliga', 'desligue', 'gera', 'gere', 'documenta',
  'documente', 'prepara', 'prepare', 'finaliza', 'finalize', 'termina', 'termine', 'olha', 'olhe', 'procura', 'procure',
  'pesquisa', 'pesquise', 'estuda', 'estude', 'volta', 'volte', 'renomeia', 'renomeie', 'separa', 'separe', 'alinhar',
  'alinha', 'alinhe', 'testar',
]
const POLITE = /(?<![\p{L}\p{N}])(?:pode(?:ria|m)?(?!\s+ser(?![\p{L}\p{N}]))|consegue|conseguiria|d[áa] pra|dá para|quero|preciso|precisa|precisamos|gostaria|tem que|deve|can you|could you|would you|will you|please|por favor|i need|i want|we need)(?![\p{L}\p{N}])/iu

const AMBIGUOUS = new Set(['teste', 'ajuste', 'troca', 'move', 'deploy', 'release', 'build', 'test', 'check', 'review', 'update',
  'change', 'merge', 'push', 'run', 'start', 'stop', 'set', 'put', 'use', 'show', 'open', 'close', 'ship', 'resume', 'continue', 'try', 'make',
  'vai', 'fix', 'faz', 'continua', 'muda', 'mostra', 'sobe', 'publica', 'libera', 'roda', 'fecha', 'cria'])
const ALL_VERBS = [...IMPERATIVE, ...ADDED]
const STRONG_VERBS = ALL_VERBS.filter(v => !AMBIGUOUS.has(v))
const LB = '(?<![\\p{L}\\p{N}])'
const RB = '(?![\\p{L}\\p{N}])'
const FILLERS = 'ok|blz|beleza|mano|cara|agora|então|entao|aí|ai'
const VERB_POSITION_RE = new RegExp(
  `(?:^|[.!?;:,\\n]\\s*|${LB}(?:e|and|pra|to|${FILLERS})\\s+)(?:${ALL_VERBS.join('|')})${RB}`, 'iu')
const STRONG_RE = new RegExp(`${LB}(?:${STRONG_VERBS.join('|')})${RB}`, 'iu')

/** A text this short with no verb and no "?" is a bare answer ("opcao C", "status"); a longer one is a report. */
export const QUESTION_MAX_WORDS = 3

export function ownerIntent(text: string): OwnerIntent {
  const own = ownerTextWords(text.split('\n').filter(l => !/^\s*>/.test(l)).join('\n'))
  const words = own || ownerTextWords(text)
  if (!words) return 'work'
  // "pode ser a C" / "pode ser?" answer or ask about an option; they are not a request.
  if (/^pode ser(?![\p{L}\p{N}])/iu.test(words) && words.split(' ').length <= 6) return 'question'
  if (POLITE.test(words)) return 'work'
  if (/[?？]\s*["')\]]*$/.test(words)) return VERB_POSITION_RE.test(words) ? 'work' : 'question'
  if (VERB_POSITION_RE.test(words) || STRONG_RE.test(words)) return 'work'
  return words.split(' ').length <= QUESTION_MAX_WORDS ? 'question' : 'work'
}

/** Quote prefixes ("> …") belong to what was pasted, not to what the owner is asking. */
function withoutQuotePrefixes(text: string): string {
  return text.split('\n').map(l => l.replace(/^\s*(?:>\s?)+/, '')).join('\n')
}

/**
 * FLUXO.AVISOS: the TITLE of the request subtask. It used to copy the raw message ("Pedido do dono: /home/…/attachments/
 * 158e1f81-image.pn…"), which names a file and says nothing. Quote prefixes and attachment paths are dropped; a message
 * that was only an attachment says so in words.
 */
export function ownerRequestTitle(text: string, max = 60): string {
  const words = ownerTextWords(text)
  if (!words) return text.trim() ? '(anexo, sem texto)' : ''
  return words.length > max ? `${words.slice(0, max - 1).trimEnd()}…` : words
}

/** The nudge excerpt of an owner message: its words (no attachment paths), first `max` characters. */
export function nudgeExcerpt(text: string, max = 80): string {
  const words = ownerTextWords(text) || (text.trim() ? '(anexo, sem texto)' : '')
  return words.length > max ? `${words.slice(0, max).trimEnd()}…` : words
}

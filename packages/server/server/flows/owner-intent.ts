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
 *  - a request verb (imperative or "can you …/pode …") anywhere → `work`, even when the text ends in "?"
 *  - otherwise a trailing "?" → `question`
 *  - otherwise a short text (≤ 12 words) with no request verb → `question`
 *  - otherwise (a long statement) → `work`
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
const POLITE = /\b(?:pode(?:ria|m)?(?!\s+ser\b)|consegue|conseguiria|d[áa] pra|dá para|quero que|preciso que|precisamos|gostaria|can you|could you|would you|will you|please|por favor|i need|i want|we need)\b/i

// Words that are also everyday nouns ("e o deploy?", "and the release?"): they count only in verb position.
const AMBIGUOUS = new Set(['teste', 'ajuste', 'troca', 'move', 'deploy', 'release', 'build', 'test', 'check', 'review', 'update',
  'change', 'merge', 'push', 'run', 'start', 'stop', 'set', 'put', 'use', 'show', 'open', 'close', 'ship', 'resume', 'continue', 'try', 'make'])
const strongVerbs = IMPERATIVE.filter(v => !AMBIGUOUS.has(v))
// An unambiguous work verb counts anywhere as a whole word (errs toward work); an ambiguous one only at the start,
// after punctuation or after "e/and/pra/to".
const IMPERATIVE_RE = new RegExp(
  `\\b(?:${strongVerbs.join('|')})\\b|(?:^|[.!?;:,\\n]\\s*|\\be\\s+|\\band\\s+|\\bpra\\s+|\\bto\\s+)(?:${IMPERATIVE.join('|')})\\b`, 'i')

export const QUESTION_MAX_WORDS = 12

export function ownerIntent(text: string): OwnerIntent {
  // What the owner WROTE: lines quoted with ">" are what they pasted (a leader's reply, a log), not what they ask.
  const own = ownerTextWords(text.split('\n').filter(l => !/^\s*>/.test(l)).join('\n'))
  const words = own || ownerTextWords(text)
  if (!words) return 'work'
  if (IMPERATIVE_RE.test(words) || POLITE.test(words)) return 'work'
  if (/[?？]\s*["')\]]*$/.test(words)) return 'question'
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

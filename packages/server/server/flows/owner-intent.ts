/**
 * owner-intent.ts — FLUXO.AVISOS: what an owner message ASKS FOR, decided by a deterministic host rule.
 *
 * Quoted or forwarded lines ("> ", "> >") are never the owner's words (FLUXO.CITACAO).
 *
 * A pedido is a request for WORK. The owner also asks the leader questions ("e o deploy?", "por que falhou?"),
 * and every one of those used to become a high-priority "Pedido do dono" that the delivery tick then nudged
 * the leader about — 8 automatic nudges in an hour on the Mac leader, most of them for questions that had
 * already been answered. The host classifies the text; the engine decides what to do with the answer
 * (a `question` is recorded already answered: no subtask, no reminder).
 *
 * FLUXO.CARD-SEM-PEDIDO: the rule errs toward NO card. Only a clear request is `work`; thanks, goodbyes, remarks,
 * reports and questions about his own English used to become cards (and a nudge each). The message reaches the leader
 * either way, so nothing is lost by not carding it.
 *  - a polite request ("can you …/pode …/quero …/precisa …/me dá …") → `work`, even when the text ends in "?"
 *  - a trailing "?" → `question`, unless a verb stands in VERB POSITION ("faz o deploy?")
 *  - otherwise a strong verb anywhere, or a verb in verb position → `work`
 *  - a complaint about a previous answer → `complaint`; everything else → `question` (no card)
 *  - word boundaries are Unicode-aware: "publicação" does not contain the verb "publica"
 */

/** `complaint`: the owner says a previous answer missed or never came. Not work (no subtask), not a question to close
 *  as answered — it is the opposite: an answer is OWED. The engine must keep it open and surface it, see docs/owner-request-queue.md. */
export type OwnerIntent = 'question' | 'work' | 'complaint'

/** Attachment references and pasted blobs are not words the owner wrote. */
export function ownerTextWords(text: string): string {
  return text
    .replace(/!?\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/(?:^|\s)(?:\/|~\/|[A-Za-z]:\\)[^\s]*\.(?:png|jpe?g|gif|webp|pdf|txt|md|log|json|csv|m4a|mp3|ogg|oga|opus|wav|aac|flac|weba|mp4|mov|webm|mkv)\b/gi, ' ')
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
  'hotfix',
]
const ADDED = [
  'resolve', 'resolva', 'resolver', 'refatora', 'refatore', 'tenta', 'tente', 'limpa', 'limpe', 'reverte', 'reverta', 'desfaz',
  'reinicia', 'reinicie', 'instala', 'instale', 'ativa', 'ative', 'desliga', 'desligue', 'gera', 'gere', 'documenta',
  'documente', 'prepara', 'prepare', 'finaliza', 'finalize', 'termina', 'termine', 'olha', 'olhe', 'procura', 'procure',
  'pesquisa', 'pesquise', 'estuda', 'estude', 'volta', 'volte', 'renomeia', 'renomeie', 'separa', 'separe', 'alinhar',
  'alinha', 'alinhe', 'testar',
  // answering IS the request ("responde as coisas que eu falei"); the past tense "respondeu" is a complaint, not this
  'responde', 'responda', 'responder', 'explica', 'explique', 'esclarece', 'esclareça',
]
// "quero saber / entender / ver se" asks to be TOLD something (no card); "não consegue" is a report; "seria legal" is a clear wish.
const POLITE = /(?<![\p{L}\p{N}])(?:pode(?:ria|m)?(?!\s+ser(?![\p{L}\p{N}]))|(?<!n[ãa]o\s+)consegue|conseguiria|d[áa] pra|dá para|quero(?!\s+(?:saber|entender|perguntar|ver\s+se|checar\s+se))|queria|preciso|precisa|precisamos|gostaria|(?:vc|voc[êe])\s+tem que|tem que\s+(?:fazer|implementar|corrigir|criar|adicionar|remover|enviar|mudar|trocar|ajustar|atualizar|resolver|responder|alinhar|testar)|deve(?!\s+(?:ser|sair)(?![\p{L}\p{N}]))|me\s+(?:faz|fa[çc]a|mostra|mostre|manda|mande|abre|abra)|seria\s+(?:legal|bom|bacana|melhor|ideal)|me\s+d[aá]|me\s+passa|me\s+diz|me\s+fala|can you|could you|would you|will you|please|por favor|i need|i want|we need)(?![\p{L}\p{N}])/iu
// An infinitive ("fazer", "resolver") names an action in a sentence about something else; only a polite opener makes it a request.
const INFINITIVES = new Set(['fazer', 'implementar', 'corrigir', 'criar', 'adicionar', 'remover', 'enviar', 'mudar', 'trocar', 'ajustar',
  'atualizar', 'resolver', 'responder', 'alinhar', 'testar'])

const AMBIGUOUS = new Set(['hotfix', 'teste', 'ajuste', 'troca', 'move', 'deploy', 'release', 'build', 'test', 'check', 'review', 'update',
  'change', 'merge', 'push', 'run', 'start', 'stop', 'set', 'put', 'use', 'show', 'open', 'close', 'ship', 'resume', 'continue', 'try', 'make',
  'vai', 'fix', 'faz', 'continua', 'muda', 'mostra', 'sobe', 'publica', 'libera', 'roda', 'fecha', 'cria'])
const ALL_VERBS = [...IMPERATIVE, ...ADDED].filter(v => !INFINITIVES.has(v) && v !== 'vai' && v !== 'pesquisa')
const STRONG_VERBS = ALL_VERBS.filter(v => !AMBIGUOUS.has(v))
const LB = '(?<![\\p{L}\\p{N}])'
const RB = '(?![\\p{L}\\p{N}])'
const FILLERS = 'ok|blz|beleza|mano|cara|agora|então|entao|aí|ai|e|and|now|valeu|obrigado|thanks'
/** A verb counts as a request only where a request STARTS: the text, a line or a sentence (after an optional filler). */
const VERB_POSITION_RE = new RegExp(
  `(?:^|[.!?;:,\\n]\\s*)(?:(?:${FILLERS})[,!\\s]+)?(?:${ALL_VERBS.join('|')})${RB}`, 'iu')
const STRONG_RE = new RegExp(`${LB}(?:${STRONG_VERBS.join('|')})${RB}`, 'iu')
/** A strong verb buried in a long text is a story, not an order; it only counts in a short message. */
const STRONG_MAX_WORDS = 15

/** A complaint about a PREVIOUS ANSWER, with no new request in it ("vc n me respondeu", "não era isso que eu pedi"). */
const COMPLAINT_RE = new RegExp(
  `${LB}(?:` +
  // "vc n me respondeu", "você não respondeu", "ninguém me respondeu", "ignorou", "esqueceu de responder"
  `(?:(?:vc|voc[êe]|tu|ningu[ée]m)\\s+)?(?:n|n[ãa]o|nunca)\\s+(?:me\\s+|a\\s+|o\\s+)?(?:respond(?:eu|eram|estes?)|entend(?:eu|eram)|ouv(?:iu|iram)|viu|leu|fez|atendeu|resolveu)|` +
  `(?:vc|voc[êe])\\s+(?:me\\s+)?(?:ignorou|esqueceu(?:\\s+de\\s+(?:responder|mim))?)|` +
  // "não era isso", "não foi isso que eu pedi", "isso não é o que eu falei"
  `n[ãa]o\\s+(?:era|foi|[ée])\\s+(?:isso|assim|esse|essa)(?:\\s+que\\s+eu\\s+(?:pedi|falei|disse|quis))?|` +
  `isso\\s+n[ãa]o\\s+(?:era|[ée]|foi)\\s+o\\s+que\\s+eu\\s+(?:pedi|falei|disse|quis)|` +
  `n[ãa]o\\s+(?:era|foi)\\s+o\\s+que\\s+eu\\s+(?:pedi|falei|disse|quis)` +
  `)${RB}`, 'iu')

const isQuoted = (l: string): boolean => /^\s*>/.test(l)
const hasQuote = (text: string): boolean => text.split('\n').some(isQuoted)
/** The lines the owner wrote themselves: a quoted or forwarded line ("> ", "> >", ">") is someone else's text, at any depth. */
function ownLines(text: string): string {
  return text.split('\n').filter(l => !isQuoted(l)).join('\n')
}

/** The owner's own words; a message that is ONLY a quote has none, so it is labelled by what was quoted (it is never a card). */
function titleWords(text: string): string {
  return ownerTextWords(ownLines(text)) || ownerTextWords(text.split('\n').map(l => l.replace(/^\s*(?:>\s?)+/, '')).join('\n'))
}

export function ownerIntent(text: string): OwnerIntent {
  const quoted = hasQuote(text)
  const words = ownerTextWords(ownLines(text))
  // Only quoted lines and no own words (a bare forward): nothing was asked, so it is recorded as a `question` (no card, no reminder).
  if (!words && quoted) return 'question'
  // Only an attachment (png, voice note, link): no words to act on. The leader answers it; it is not a work card.
  if (!words) return text.trim() ? 'complaint' : 'work'
  // "pode ser a C" / "pode ser?" answer or ask about an option; they are not a request.
  if (/^pode ser(?![\p{L}\p{N}])/iu.test(words) && words.split(' ').length <= 6) return 'question'
  if (POLITE.test(words)) return 'work'
  if (/[?？]\s*["')\]]*$/.test(words)) return VERB_POSITION_RE.test(words) ? 'work' : 'question'
  if (VERB_POSITION_RE.test(words) || (STRONG_RE.test(words) && words.split(' ').length <= STRONG_MAX_WORDS)) return 'work'
  // A complaint is never a card, at any length: nothing here asks for work (the request verbs were tested above).
  if (COMPLAINT_RE.test(words)) return 'complaint'
  // FLUXO.CARD-SEM-PEDIDO: nothing above is a clear request, so there is no card. Thanks, goodbyes, remarks, reports and
  // questions about his own English all land here; the message still reaches the leader, which is all they need.
  return 'question'
}

/**
 * FLUXO.AVISOS: the TITLE of the request subtask. It used to copy the raw message ("Pedido do dono: /home/…/attachments/
 * 158e1f81-image.pn…"), which names a file and says nothing. Quote prefixes and attachment paths are dropped; a message
 * that was only an attachment says so in words.
 */
export function ownerRequestTitle(text: string, max = 60): string {
  const words = titleWords(text)
  if (!words) return text.trim() ? '(anexo, sem texto)' : ''
  return words.length > max ? `${words.slice(0, max - 1).trimEnd()}…` : words
}

/** The nudge excerpt of an owner message: its words (no attachment paths), first `max` characters. */
export function nudgeExcerpt(text: string, max = 80): string {
  const words = titleWords(text) || (text.trim() ? '(anexo, sem texto)' : '')
  return words.length > max ? `${words.slice(0, max).trimEnd()}…` : words
}

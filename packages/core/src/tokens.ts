/**
 * tokens.ts — PURE. What a token count MEANS, counted one way and named one way.
 *
 * ## Why this module exists
 *
 * A session carries four counters, and only two of them were being added up in several places.
 * Measured on one real machine, over its 123 stored Claude sessions:
 *
 * ```
 * input + output + cacheRead + cacheWrite   8.725.910.796
 * input + output                               29.744.918   ← 0,34 % of it
 * ```
 *
 * So a surface that summed two of the four was not "slightly low", it was reporting a third of one
 * percent. The session drawer showed a 978M-token session as 3,1M and priced it with the cache
 * hardcoded to zero, while the cockpit — which had always added all four — showed the real figure
 * beside it. Two arithmetics for one question, disagreeing by 300×, which is how a dashboard loses
 * the right to be believed.
 *
 * There is now ONE arithmetic, here, and every surface calls it. `tokens.lint.test.ts` fails the
 * build when a new two-term sum appears anywhere in the repo, because the fix that is not enforced
 * is the fix that comes back.
 *
 * ## Why the VOCABULARY is in the same file as the counting
 *
 * These numbers reach the billions and mean nothing on their own — "8,7B tokens" reads as a fault
 * until you know that 96 % of it is the model re-reading a context it already paid a tenth of a
 * cent per million to keep. A total with no explanation of what it contains does not inform anyone,
 * it just alarms them, and the alarm is what makes someone stop trusting the number.
 *
 * So a label may not exist without its explanation: `TOKEN_KINDS` carries both, in both languages,
 * and every surface that prints a token figure prints the matching `help` beside or under it. Same
 * discipline as `HARNESS_CAPABILITIES` — the type makes the honest thing the easy thing.
 */

import type { Lang } from './i18n'
import type { ModelUsage, SessionMeta } from './types'

/**
 * The four counters a turn is billed on, kept apart because they are four different prices and four
 * different stories. `total` is never stored — it is always `totalTokens()` of these, so the parts
 * and the whole cannot drift.
 */
export interface TokenBreakdown {
  /** Input the model had to read fresh, with no cache to serve it from. */
  input: number
  /** Everything the model wrote, thinking included. */
  output: number
  /** Input served from the cache instead of being re-read — the cheap majority of the volume. */
  cacheRead: number
  /** Input written INTO the cache so later turns can read it — charged at a premium, once. */
  cacheWrite: number
}

export const EMPTY_TOKENS: TokenBreakdown = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

/** The session's four counters. Absent counters are zero — a session that recorded none reads 0. */
export function sessionTokens(
  s: Pick<SessionMeta, 'input_tokens' | 'output_tokens'
    | 'cache_read_input_tokens' | 'cache_creation_input_tokens'>,
): TokenBreakdown {
  return {
    input: s.input_tokens ?? 0,
    output: s.output_tokens ?? 0,
    cacheRead: s.cache_read_input_tokens ?? 0,
    cacheWrite: s.cache_creation_input_tokens ?? 0,
  }
}

/** The same four counters read off a `ModelUsage` — the per-model shape the pricing table takes. */
export function usageTokens(u: Partial<ModelUsage> | undefined): TokenBreakdown {
  return {
    input: u?.inputTokens ?? 0,
    output: u?.outputTokens ?? 0,
    cacheRead: u?.cacheReadInputTokens ?? 0,
    cacheWrite: u?.cacheCreationInputTokens ?? 0,
  }
}

export function addTokens(a: TokenBreakdown, b: TokenBreakdown): TokenBreakdown {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  }
}

export function sumTokens(parts: Iterable<TokenBreakdown>): TokenBreakdown {
  let acc = EMPTY_TOKENS
  for (const p of parts) acc = addTokens(acc, p)
  return acc
}

/**
 * Every billed counter — THE number, and the one the word "tokens" means everywhere in this product.
 *
 * Including the cache is not a stylistic choice: the cache counters are what the provider bills, and
 * a "total" that omits 96 % of the volume is not a total. Where a surface genuinely wants the two
 * conversational counters, it asks for them by name (`input` + `output`) and SAYS so on screen.
 */
export function totalTokens(b: TokenBreakdown): number {
  return b.input + b.output + b.cacheRead + b.cacheWrite
}

/** Everything the model READ this session, however it was served. The denominator of the hit rate. */
export function readTokens(b: TokenBreakdown): number {
  return b.input + b.cacheRead + b.cacheWrite
}

/** Total of a session in one call — the shape most call sites want. */
export function sessionTokenTotal(
  s: Parameters<typeof sessionTokens>[0] & Pick<Partial<SessionMeta>, 'tokens_unavailable'>,
): number | undefined {
  if (s.tokens_unavailable) return undefined
  return totalTokens(sessionTokens(s))
}

/** Total of a `ModelUsage` in one call. */
export function usageTokenTotal(u: Partial<ModelUsage> | undefined): number {
  return totalTokens(usageTokens(u))
}

/**
 * Share of the total each counter holds, 0–1. All zero when there is nothing to take a share of —
 * never `NaN`, which is what a bare `part / total` puts into a CSS width.
 */
export function tokenShares(b: TokenBreakdown): TokenBreakdown {
  const t = totalTokens(b)
  if (t <= 0) return EMPTY_TOKENS
  return {
    input: b.input / t,
    output: b.output / t,
    cacheRead: b.cacheRead / t,
    cacheWrite: b.cacheWrite / t,
  }
}

// ---------------------------------------------------------------------------------------------
// The vocabulary
// ---------------------------------------------------------------------------------------------

/**
 * Everything this product can print a token number FOR.
 *
 * The four counters, plus the three derived readings that are worth a name of their own because
 * each is a different question and they are routinely confused for one another.
 */
export type TokenKind =
  | 'input' | 'output' | 'cacheRead' | 'cacheWrite'
  | 'total' | 'read' | 'conversation'

export interface TokenTerm {
  /** The short label a column heading or a legend uses. */
  label: string
  /**
   * One plain sentence saying what produced this number.
   *
   * Not a definition of the term — a reason for the figure on screen. Someone reading "1,2B" needs
   * to know why it is that big before they need to know what a KV cache is.
   */
  help: string
}

const TERMS: Record<TokenKind, Record<Lang, TokenTerm>> = {
  input: {
    en: {
      label: 'Input (fresh)',
      help: 'Text the model had to read for the first time — no cache could serve it. The smallest of the four counters on a long session, and the most expensive per token after output.',
    },
    pt: {
      label: 'Entrada (nova)',
      help: 'Texto que o modelo teve de ler pela primeira vez — nenhum cache podia servir. É o menor dos quatro contadores numa sessão longa, e o mais caro por token depois da saída.',
    },
  },
  output: {
    en: {
      label: 'Output',
      help: 'Everything the model wrote: answers, code, tool arguments and its reasoning. The most expensive token there is, and usually a small slice of the volume.',
    },
    pt: {
      label: 'Saída',
      help: 'Tudo que o modelo escreveu: respostas, código, argumentos de ferramenta e o raciocínio. É o token mais caro que existe, e normalmente uma fatia pequena do volume.',
    },
  },
  cacheRead: {
    en: {
      label: 'Cache read',
      help: 'The conversation so far, re-read from the KV cache on every single turn instead of being sent again. This is why the total reaches billions: a 200k context read across 500 turns is 100M tokens by itself — at roughly a tenth of the price of fresh input.',
    },
    pt: {
      label: 'Leitura de cache',
      help: 'A conversa até aqui, relida do cache KV a cada turno em vez de ser reenviada. É por isso que o total chega aos bilhões: um contexto de 200k lido ao longo de 500 turnos já são 100M de tokens — a cerca de um décimo do preço da entrada nova.',
    },
  },
  cacheWrite: {
    en: {
      label: 'Cache write',
      help: 'Text written into the cache so the following turns can read it cheaply. Charged once, at a premium over fresh input — it is what every later cache read is paying off.',
    },
    pt: {
      label: 'Escrita de cache',
      help: 'Texto gravado no cache para que os turnos seguintes o leiam barato. Cobrado uma vez, com ágio sobre a entrada nova — é o que cada leitura de cache posterior amortiza.',
    },
  },
  total: {
    en: {
      label: 'Total tokens',
      help: 'All four counters added up — fresh input, output, cache read and cache write. This is the number the provider bills on, which is why it is the one shown by default.',
    },
    pt: {
      label: 'Total de tokens',
      help: 'Os quatro contadores somados — entrada nova, saída, leitura e escrita de cache. É o número em cima do qual o provedor cobra, e por isso é o exibido por padrão.',
    },
  },
  read: {
    en: {
      label: 'Read by the model',
      help: 'Everything that entered the model, however it was served: fresh input plus cache reads plus cache writes. The denominator of the cache hit rate.',
    },
    pt: {
      label: 'Lido pelo modelo',
      help: 'Tudo que entrou no modelo, seja como for servido: entrada nova mais leituras mais escritas de cache. É o denominador da taxa de acerto do cache.',
    },
  },
  conversation: {
    en: {
      label: 'Conversation only',
      help: 'Fresh input plus output — the text of the exchange, with the cache traffic left out. A useful reading of how much was actually said, and NOT what you are billed for.',
    },
    pt: {
      label: 'Só a conversa',
      help: 'Entrada nova mais saída — o texto da troca, sem o tráfego de cache. É uma leitura útil de quanto foi realmente dito, e NÃO é o que você paga.',
    },
  },
}

/**
 * A share as a percentage STRING, which never prints `0%` for a quantity that exists.
 *
 * Found by opening the panel: with a real machine's 17.8B total, output — 64.2M tokens and the most
 * expensive counter there is — rendered as `0%`, and the explanatory sentence read "output, the most
 * expensive token, is 0%". That is the confident-zero this codebase forbids everywhere else, applied
 * to the exact number the reader is least able to check.
 *
 * `<1%` is the honest answer, and it is also the interesting one: it says the cache has grown so
 * large that the expensive tokens have become a rounding error, which is the actual finding.
 */
export function tokenSharePct(part: number, total: number): string {
  if (total <= 0 || part <= 0) return '0%'
  const pct = (part / total) * 100
  if (pct < 0.5) return '<1%'
  return `${Math.round(pct)}%`
}

export function tokenTerm(kind: TokenKind, lang: Lang): TokenTerm {
  return TERMS[kind][lang]
}

export function tokenLabel(kind: TokenKind, lang: Lang): string {
  return TERMS[kind][lang].label
}

export function tokenHelp(kind: TokenKind, lang: Lang): string {
  return TERMS[kind][lang].help
}

/** The four counters in the order they are always drawn, so no two surfaces order them differently. */
export const TOKEN_PARTS = ['input', 'output', 'cacheRead', 'cacheWrite'] as const

/** The CSS variable each counter is drawn in, so a legend and its bar can never disagree. */
export const TOKEN_COLORS: Record<(typeof TOKEN_PARTS)[number], string> = {
  input: 'var(--accent-blue, #3b82f6)',
  output: 'var(--accent-green, #22c55e)',
  cacheRead: 'var(--accent-purple, #a855f7)',
  cacheWrite: 'var(--accent-orange, #f59e0b)',
}

/**
 * One sentence explaining a total to somebody who just read it — already localized.
 *
 * The requirement it exists for: a big number needs its reason ATTACHED, not a page away. This is
 * the sentence that goes under any headline token figure, and it names the dominant counter rather
 * than reciting all four, because the honest answer to "why is that 8,7 billion" is almost always
 * "because 96 % of it is the cache being re-read".
 */
export function totalTokensExplained(b: TokenBreakdown, lang: Lang): string {
  const t = totalTokens(b)
  if (t <= 0) {
    return lang === 'pt'
      ? 'Nenhum token registrado neste recorte.'
      : 'No tokens recorded in this scope.'
  }
  const pct = (n: number) => tokenSharePct(n, t)
  return lang === 'pt'
    ? `Soma dos quatro contadores. Leitura de cache é ${pct(b.cacheRead)} do total — é a conversa sendo relida a cada turno, e custa cerca de 1/10 da entrada nova. Saída, o token mais caro, é ${pct(b.output)}.`
    : `All four counters added up. Cache read is ${pct(b.cacheRead)} of it — the conversation being re-read every turn, at roughly 1/10 the price of fresh input. Output, the most expensive token, is ${pct(b.output)}.`
}

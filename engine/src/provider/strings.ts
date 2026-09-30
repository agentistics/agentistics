/**
 * strings.ts — the provider verb's own sentences, EN + PT.
 *
 * They lived in the public `cli-i18n.ts`, whose only reason to import `@agentistics/runtime` was the
 * two types these strings render. Spec §4.4 recommends the sentences move WITH the verb, so the
 * public host names nothing of the runtime; this is that move, text unchanged.
 */
import type { RateLimitAbsentReason, RateLimitResourceKind } from '@agentistics/runtime'

export type CliLang = 'en' | 'pt'

export interface ProviderStrings {
  rateLimitLabel: string
  rateLimitKind: Record<RateLimitResourceKind, string>
  rateLimitLeft: (remaining: string, limit?: string) => string
  /** A limit with no remaining stated — said, never rendered as `0 left`. */
  rateLimitLimitOnly: (limit: string) => string
  rateLimitUntil: (time: string) => string
  rateLimitRetryAfter: (seconds: string) => string
  rateLimitDropped: (n: number) => string
  rateLimitAbsent: (reason: RateLimitAbsentReason, dropped: number) => string
}

const EN: ProviderStrings = {
  rateLimitLabel: 'rate limit',
  rateLimitKind: {
    requests: 'requests',
    tokens: 'tokens',
    'input-tokens': 'input tokens',
    'output-tokens': 'output tokens',
    'project-tokens': 'project tokens',
  },
  rateLimitLeft: (remaining, limit) => `${limit === undefined ? remaining : `${remaining}/${limit}`} left`,
  rateLimitLimitOnly: limit => `limit ${limit} (remaining not stated)`,
  rateLimitUntil: time => `until ${time}`,
  rateLimitRetryAfter: seconds => `retry after ${seconds}s`,
  rateLimitDropped: n => `${n} header${n === 1 ? '' : 's'} unreadable`,
  rateLimitAbsent: (reason, dropped) => {
    switch (reason) {
      case 'not-documented': return 'not stated — this provider documents no rate-limit header'
      case 'unknown-format': return 'not read — no documented rate-limit header format for this provider'
      case 'no-headers': return 'not stated — the response carried no rate-limit header'
      case 'unparseable': return `not read — ${dropped} rate-limit header${dropped === 1 ? ' was' : 's were'} present and none could be parsed`
    }
  },
}

const PT: ProviderStrings = {
  rateLimitLabel: 'limite de taxa',
  rateLimitKind: {
    requests: 'requisições',
    tokens: 'tokens',
    'input-tokens': 'tokens de entrada',
    'output-tokens': 'tokens de saída',
    'project-tokens': 'tokens do projeto',
  },
  rateLimitLeft: (remaining, limit) => `${limit === undefined ? remaining : `${remaining}/${limit}`} restantes`,
  rateLimitLimitOnly: limit => `limite ${limit} (restante não informado)`,
  rateLimitUntil: time => `até ${time}`,
  rateLimitRetryAfter: seconds => `tentar de novo em ${seconds}s`,
  rateLimitDropped: n => `${n} ${n === 1 ? 'cabeçalho ilegível' : 'cabeçalhos ilegíveis'}`,
  rateLimitAbsent: (reason, dropped) => {
    switch (reason) {
      case 'not-documented': return 'não informado — este provedor não documenta cabeçalho de limite de taxa'
      case 'unknown-format': return 'não lido — não há formato documentado de cabeçalho de limite de taxa para este provedor'
      case 'no-headers': return 'não informado — a resposta não trouxe cabeçalho de limite de taxa'
      case 'unparseable': return `não lido — ${dropped} ${dropped === 1 ? 'cabeçalho de limite de taxa presente, ilegível' : 'cabeçalhos de limite de taxa presentes, nenhum legível'}`
    }
  },
}

export function providerStrings(lang: CliLang): ProviderStrings {
  return lang === 'pt' ? PT : EN
}

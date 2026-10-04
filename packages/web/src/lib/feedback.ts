/**
 * feedback.ts — "found a bug or have a suggestion?": what goes along, and the GitHub URL that carries it.
 *
 * PURE. Nothing here sends anything: `buildFeedbackTarget` returns a URL the PERSON opens in their own
 * browser, so the report is filed from THEIR GitHub account — no server endpoint, no token, no telemetry.
 *
 * What may travel is a CLOSED list (`INFO_KEYS`): the agentop version, the engine version, OS/arch, the
 * browser and the NAMES of the harnesses detected. Never a path, a session, a token, a repo name or an
 * email — adding a line means adding it to `INFO_KEYS` on purpose, and `collectInfo` only ever reads the
 * fields it is handed, so a stray one cannot ride along. Every line is optional: the person unticks it.
 */

export type FeedbackKind = 'bug' | 'suggestion'
export type InfoKey = 'version' | 'engine' | 'os' | 'browser' | 'harnesses'
export const INFO_KEYS: readonly InfoKey[] = ['version', 'engine', 'os', 'browser', 'harnesses']

/** The repository the report is filed against. */
export const FEEDBACK_REPO = 'agentistics/agentistics'
/**
 * Where a suggestion goes. `discussions` needs the repository to have Discussions enabled with an `ideas`
 * category, which a page cannot know without calling GitHub — so the default is an issue labelled
 * `suggestion`, which works everywhere. Flip this the day Discussions is on.
 */
export const SUGGESTION_VIA: 'issue' | 'discussions' = 'issue'
/** A prefilled URL longer than this is not reliably opened (browsers, proxies and GitHub itself truncate). */
export const MAX_URL_LENGTH = 6000

export interface FeedbackFacts {
  version?: string | null
  engine?: string | null
  /** A user-agent string, optionally with the UA-CH platform/architecture when the browser has them. */
  userAgent?: string | null
  platform?: string | null
  arch?: string | null
  harnesses?: readonly string[] | null
}

export interface InfoLine { key: InfoKey; label: string; value: string }

const LABELS: Record<InfoKey, { en: string; pt: string }> = {
  version: { en: 'agentop version', pt: 'Versão do agentop' },
  engine: { en: 'Engine version', pt: 'Versão do engine' },
  os: { en: 'OS / architecture', pt: 'SO / arquitetura' },
  browser: { en: 'Browser', pt: 'Navegador' },
  harnesses: { en: 'Harnesses detected', pt: 'Harnesses detectados' },
}
export const infoLabel = (k: InfoKey, pt: boolean): string => LABELS[k][pt ? 'pt' : 'en']

/** `Chrome 130`, `Firefox 131`, `Safari 17` — the family and MAJOR version only; never the full UA string. */
export function browserOf(ua: string | null | undefined): string {
  if (!ua) return ''
  const pick = (re: RegExp, name: string): string | null => { const m = re.exec(ua); return m ? `${name} ${m[1]}` : null }
  return pick(/Edg\/(\d+)/, 'Edge') ?? pick(/OPR\/(\d+)/, 'Opera') ?? pick(/Firefox\/(\d+)/, 'Firefox')
    ?? pick(/Chrome\/(\d+)/, 'Chrome') ?? pick(/Version\/(\d+)[\d.]* .*Safari/, 'Safari') ?? ''
}

/** The OS family from the UA, no version detail beyond what the family needs. */
export function osOf(ua: string | null | undefined, platform?: string | null, arch?: string | null): string {
  const p = (platform || '').trim()
  let os = p
  if (!os && ua) {
    os = /Windows/i.test(ua) ? 'Windows' : /Android/i.test(ua) ? 'Android' : /iPhone|iPad|iOS/i.test(ua) ? 'iOS'
      : /Mac OS X|Macintosh/i.test(ua) ? 'macOS' : /CrOS/i.test(ua) ? 'ChromeOS' : /Linux/i.test(ua) ? 'Linux' : ''
  }
  const a = (arch || '').trim() || (ua && (/aarch64|arm64|\barm\b/i.test(ua) ? 'arm64' : /x86_64|x64|Win64|WOW64|amd64/i.test(ua) ? 'x64' : '')) || ''
  return [os, a].filter(Boolean).join(' · ')
}

/** The lines that CAN be sent: one per key with something to say. A fact we do not have is absent, never blank. */
export function collectInfo(f: FeedbackFacts, pt: boolean): InfoLine[] {
  // Names only — a harness id is a short lowercase word; anything else is dropped rather than trusted.
  const harnesses = (f.harnesses ?? []).filter(h => /^[a-z][a-z0-9-]{0,31}$/.test(h)).join(', ')
  const raw: Record<InfoKey, string> = {
    version: (f.version ?? '').trim(),
    engine: (f.engine ?? '').trim(),
    os: osOf(f.userAgent, f.platform, f.arch),
    browser: browserOf(f.userAgent),
    harnesses,
  }
  return INFO_KEYS.filter(k => raw[k]).map(k => ({ key: k, label: infoLabel(k, pt), value: raw[k] }))
}

/** Only the lines the person left ticked. */
export const includedInfo = (lines: readonly InfoLine[], off: ReadonlySet<InfoKey>): InfoLine[] =>
  lines.filter(l => !off.has(l.key))

export interface FeedbackDraft { kind: FeedbackKind; title: string; description: string }

const BUG_TEMPLATE = (pt: boolean) => pt
  ? { what: 'O que aconteceu', steps: 'Como reproduzir', expected: 'O que era esperado' }
  : { what: 'What happened', steps: 'Steps to reproduce', expected: 'Expected behaviour' }

/** The markdown body of the report. The info block is exactly the lines passed in — nothing is added. */
export function buildBody(d: FeedbackDraft, info: readonly InfoLine[], pt: boolean): string {
  const desc = d.description.trim()
  const parts: string[] = []
  if (d.kind === 'bug') {
    const t = BUG_TEMPLATE(pt)
    parts.push(`### ${t.what}\n\n${desc || '_…_'}`, `### ${t.steps}\n\n1. …`, `### ${t.expected}\n\n_…_`)
  } else {
    parts.push(desc || '_…_')
  }
  if (info.length > 0) {
    parts.push(`### ${pt ? 'Informações incluídas' : 'Included information'}\n\n` + info.map(l => `- **${l.label}:** ${l.value}`).join('\n'))
  }
  return parts.join('\n\n')
}

export interface FeedbackTarget {
  url: string
  /** Set when the full body did not fit in the URL: the page opens WITHOUT it and the body is for the clipboard. */
  clipboard: string | null
}

const enc = encodeURIComponent

function target(kind: FeedbackKind, title: string, body: string): string {
  if (kind === 'suggestion' && SUGGESTION_VIA === 'discussions') {
    return `https://github.com/${FEEDBACK_REPO}/discussions/new?category=ideas&title=${enc(title)}&body=${enc(body)}`
  }
  const label = kind === 'bug' ? 'bug' : 'suggestion'
  return `https://github.com/${FEEDBACK_REPO}/issues/new?labels=${label}&title=${enc(title)}&body=${enc(body)}`
}

/**
 * The URL to open. When the encoded URL would exceed `max`, the body is withheld from it and returned as
 * `clipboard` instead, with a one-line pointer in its place — the page then says it is on the clipboard.
 */
export function buildFeedbackTarget(d: FeedbackDraft, info: readonly InfoLine[], pt: boolean, max = MAX_URL_LENGTH): FeedbackTarget {
  const title = d.title.trim()
  const body = buildBody(d, info, pt)
  const full = target(d.kind, title, body)
  if (full.length <= max) return { url: full, clipboard: null }
  const pointer = pt ? '_(Cole aqui o texto copiado — ele não coube no link.)_' : '_(Paste the copied text here — it did not fit in the link.)_'
  return { url: target(d.kind, title, pointer), clipboard: body }
}

/** Can the report be sent? A title is the one thing GitHub needs to make the page worth opening. */
export const canSend = (d: FeedbackDraft): boolean => d.title.trim().length > 0

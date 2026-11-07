/**
 * liveText — PURE. The words the Live Delivery view uses for things the machine writes as data.
 *
 * One module for the server (the leaders' band is built there) and the browser (a card), so a raw
 * `{"message":{"to":…,"kind":"handback"}}` is turned into a sentence the same way on both sides and
 * never reaches a screen as JSON.
 */

export type LiveLang = 'pt' | 'en'

const KIND_WORD: Record<string, { pt: string; en: string }> = {
  handback: { pt: 'handback', en: 'handback' },
  block: { pt: 'bloqueio', en: 'block' },
  question: { pt: 'pergunta', en: 'question' },
}

/** Does the text look like a JSON object/array the machine wrote (possibly behind a `↳ ` arrow)? */
export function looksLikeJson(raw: string): boolean {
  const t = raw.replace(/^[\s↳>•·-]+/, '').trim()
  // A terminal row can cut the object short, so the closing brace is not required — a `{"` is enough.
  return (t.startsWith('{') && (t.endsWith('}') || t.includes('"'))) || (t.startsWith('[') && (t.endsWith(']') || t.includes('{"')))
}

const idsOf = (o: unknown): string[] => {
  const out: string[] = []
  const walk = (v: unknown, depth: number) => {
    if (depth > 4 || v === null || typeof v !== 'object') return
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if ((k === 'from' || k === 'to') && typeof x === 'string') out.push(x)
      else walk(x, depth + 1)
    }
  }
  walk(o, 0)
  return out
}

/**
 * A last-action line as a sentence. Plain text is returned trimmed (one line, at most `max`); a
 * JSON payload becomes "handback de <title>" / "pergunta para <title>" when it names a message
 * kind, and a neutral phrase otherwise — never the braces. `titleOf` resolves a session id to the
 * name a person knows it by.
 */
export function humanizeAction(
  raw: string | null | undefined,
  lang: LiveLang,
  titleOf?: (id: string) => string | undefined,
  max = 140,
): string | null {
  if (raw === null || raw === undefined) return null
  const text = raw.replace(/^[\s↳]+/, '').trim()
  if (!text) return null
  if (!looksLikeJson(text)) return text.split('\n')[0]!.slice(0, max)
  const pt = lang === 'pt'
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch {
    // A line cut mid-object (a terminal row): still never show the braces.
    const kind = /"kind"\s*:\s*"([a-z_-]+)"/i.exec(text)?.[1]?.toLowerCase()
    const from = /"from"\s*:\s*"([^"]+)"/i.exec(text)?.[1]
    if (kind && KIND_WORD[kind]) return sentence(kind, from, undefined, pt, titleOf)
    return pt ? 'atividade interna do agente' : 'internal agent activity'
  }
  const root = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>
  const msg = (root.message && typeof root.message === 'object' ? root.message : root) as Record<string, unknown>
  const kind = typeof msg.kind === 'string' ? msg.kind.toLowerCase() : null
  if (kind && KIND_WORD[kind]) {
    const ids = idsOf(parsed)
    return sentence(kind, typeof msg.from === 'string' ? msg.from : ids[0], typeof msg.to === 'string' ? msg.to : undefined, pt, titleOf)
  }
  return pt ? 'atividade interna do agente' : 'internal agent activity'
}

function sentence(kind: string, from: string | undefined, to: string | undefined, pt: boolean, titleOf?: (id: string) => string | undefined): string {
  const word = KIND_WORD[kind]![pt ? 'pt' : 'en']
  const who = from ? (titleOf?.(from) ?? from) : null
  const dest = to ? (titleOf?.(to) ?? null) : null
  if (who) return pt ? `${word} de ${shortTitle(who, 44)}` : `${word} from ${shortTitle(who, 44)}`
  if (dest) return pt ? `${word} para ${shortTitle(dest, 44)}` : `${word} to ${shortTitle(dest, 44)}`
  return word
}

/**
 * A card's short title: the first clause, at most `max` characters (the full text goes on hover).
 * "LIVE.LIDERES · dono 06/11 …: cartões …" -> "LIVE.LIDERES · dono 06/11 …" stays recognisable
 * because a title is "CODE · what it is".
 */
export function shortTitle(title: string, max = 60): string {
  const t = title.replace(/\s+/g, ' ').trim()
  if (t.length <= max) return t
  // Prefer a natural clause end after the "CODE ·" prefix.
  const search = t.slice(0, max + 1)
  const cuts = [': ', ' — ', ' – ', ' (', '; ', '. ', ', ']
  let at = -1
  for (const c of cuts) {
    const i = search.indexOf(c, 12)
    if (i >= 12 && (at === -1 || i < at)) at = i
  }
  if (at >= 12) return t.slice(0, at).trim()
  const sp = search.lastIndexOf(' ')
  return `${t.slice(0, sp > 24 ? sp : max).trim()}…`
}

/** Strip the "[ LÍDER ] - " decoration a leader session's title carries. */
export const plainLeaderName = (title: string): string =>
  title.replace(/^\s*\[\s*L[ÍI]DER\s*\]\s*[-–—:]?\s*/i, '').trim() || title

// ------------------------------------------------------------------------------------ last action

/** The statuses the book names itself, as words — an invented one is shown as it was typed. */
const STATUS_WORD: Record<string, { pt: string; en: string }> = {
  backlog: { pt: 'backlog', en: 'backlog' }, todo: { pt: 'a fazer', en: 'to do' },
  in_progress: { pt: 'em andamento', en: 'in progress' }, in_review: { pt: 'em revisão', en: 'in review' },
  blocked: { pt: 'bloqueado', en: 'blocked' }, done: { pt: 'concluído', en: 'done' }, abandoned: { pt: 'abandonado', en: 'abandoned' },
}
const statusWord = (s: string | undefined, pt: boolean): string => (s ? STATUS_WORD[s]?.[pt ? 'pt' : 'en'] ?? s.replace(/_/g, ' ') : '?')

/**
 * The newest thing the activity log says about a piece, as ONE sentence in the person's language — the
 * ACTION, not the record's own label. The log keeps `comment` events as `on subtask "<title>"`, which in a
 * Portuguese UI was English and merely repeated the card's own title (QA MED 7); a status move, a claim or a
 * session filing each has its own sentence. A kind this does not know falls back to `humanizeAction` of the
 * detail, so nothing is invented and JSON still never reaches a screen.
 */
export function describeLastAction(
  a: { text: string; kind?: string; from?: string; to?: string } | null | undefined,
  lang: LiveLang,
  titleOf?: (id: string) => string | undefined,
): string | null {
  if (!a) return null
  const pt = lang === 'pt'
  switch (a.kind) {
    case 'comment': {
      // A PREFIX test: the title inside may hold quotes of its own and the reply cuts the text, so the closing quote is not guaranteed.
      const m = /^on subtask\s+["“]/i.exec(a.text.trim())
      if (m || !a.text.trim() || a.text.trim() === 'comment') return pt ? 'comentou na subtarefa' : 'commented on the subtask'
      return (pt ? 'comentou: ' : 'commented: ') + (humanizeAction(a.text, lang, titleOf) ?? '')
    }
    case 'status': return pt ? `mudou de ${statusWord(a.from, true)} para ${statusWord(a.to, true)}` : `moved from ${statusWord(a.from, false)} to ${statusWord(a.to, false)}`
    case 'claim': return pt ? 'assumiu a tarefa' : 'claimed the task'
    case 'release': return pt ? 'liberou a tarefa' : 'released the task'
    case 'session': return pt ? `anexou uma sessão${a.text && a.text !== 'session' ? ` (${a.text})` : ''}` : `filed a session${a.text && a.text !== 'session' ? ` (${a.text})` : ''}`
    case 'priority': return pt ? `mudou a prioridade para ${a.to ?? '?'}` : `set the priority to ${a.to ?? '?'}`
    case 'step': return pt ? `passo ${a.to ?? a.text}` : `step ${a.to ?? a.text}`
    case 'checkin': {
      try {
        const o = JSON.parse(a.text) as { summary?: unknown }
        if (typeof o.summary === 'string' && o.summary.trim()) return (pt ? 'check-in: ' : 'check-in: ') + o.summary.trim().split('\n')[0]!.slice(0, 120)
      } catch { /* not JSON: fall through to the plain text */ }
      return pt ? 'fez um check-in' : 'checked in'
    }
    default: return humanizeAction(a.text, lang, titleOf)
  }
}

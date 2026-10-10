/**
 * nayNotify.ts — the RULES behind the session notifications the floating Nay button speaks.
 *
 * PURE: no DOM, no clock, no storage. The store (`nayNotifyStore.ts`) and the card
 * (`components/nay/NayNotifyCard.tsx`) are the parts that touch the world; everything they have to
 * DECIDE is here, so it can be pinned by a test:
 *  - what a snooze typed by hand means, and why one is refused;
 *  - when a session counts as "not opened for a while";
 *  - how long a session has been waiting, in words;
 *  - where the card goes relative to the button, and which way its tail points.
 *
 * A notification never approves anything by itself: nothing in this module produces an action, and
 * the card's approve control only lists the options the SERVER read off the session's screen.
 */

/** What a card is about. Each maps to one row of the notification settings. */
export type NayAlertKind = 'turn' | 'approval' | 'stale' | 'limit'

export interface NayAlert {
  /** Identity of THIS occurrence: one session can wait many times, and each is its own card. */
  key: string
  kind: NayAlertKind
  sessionId: string
  name: string
  harness?: string | undefined
  model?: string | undefined
  /** When the session started waiting (the end of its last turn), epoch ms. */
  sinceMs: number
  /**
   * False when the page first saw the session ALREADY waiting, so `sinceMs` is when it was first
   * seen and the real wait may be longer. The card then says "at least".
   */
  sinceKnown: boolean
  /** A test card from the settings screen: no real session behind it, so it acts on nothing. */
  demo?: boolean
  /** It comes from a Nay conversation, which always rings the Nay sound (see `resolveSound`). */
  nay?: boolean
  /** PLAN.LIMITS: a plan window crossed a threshold. No session behind it — `sessionId` is the
   *  synthetic `limits:<harness>` so one card per harness replaces the last. */
  limit?: {
    harness: string
    window: '5h' | 'week'
    threshold: number
    pct: number
    resetsAt: number
    /** Another harness with room, offered only at 100%. */
    alt?: string
  }
}

export function alertKey(kind: NayAlertKind, sessionId: string, sinceMs: number): string {
  return `${kind}:${sessionId}:${sinceMs}`
}

// --- animations ----------------------------------------------------------------------------------

/** The four ways the button can "speak". `launch` is the default the owner chose (2026-09-29). */
export const NAY_ANIMATIONS = ['launch', 'balloon', 'unfurl', 'voice'] as const
export type NayAnimation = (typeof NAY_ANIMATIONS)[number]
export const DEFAULT_NAY_ANIMATION: NayAnimation = 'launch'

export const NAY_ANIMATION_LABEL: Record<NayAnimation, { pt: string; en: string }> = {
  launch: { pt: 'Arremesso', en: 'Launch' },
  balloon: { pt: 'Balão de fala', en: 'Speech bubble' },
  unfurl: { pt: 'Desdobrar', en: 'Unfurl' },
  voice: { pt: 'Ondas de voz', en: 'Voice waves' },
}

export const NAY_ANIMATION_HINT: Record<NayAnimation, { pt: string; en: string }> = {
  launch: { pt: 'Uma faísca sai do botão e o cartão abre onde ela cai', en: 'A spark leaves the button and the card opens where it lands' },
  balloon: { pt: 'Um balão com rabicho nasce do botão', en: 'A bubble with a tail grows out of the button' },
  unfurl: { pt: 'A moldura do botão se estica até virar o cartão', en: 'The button\'s frame stretches into the card' },
  voice: { pt: 'O botão solta ondas e a frase é digitada', en: 'The button sends out waves and the line is typed' },
}

export function parseNayAnimation(v: unknown): NayAnimation {
  return (NAY_ANIMATIONS as readonly unknown[]).includes(v) ? v as NayAnimation : DEFAULT_NAY_ANIMATION
}

// --- snooze --------------------------------------------------------------------------------------

export const SNOOZE_MIN_MS = 60_000
export const SNOOZE_MAX_MS = 24 * 3_600_000

/** The two fixed snoozes the card offers before "enter a time". */
export const SNOOZE_PRESETS: readonly { ms: number; label: { pt: string; en: string } }[] = [
  { ms: 15 * 60_000, label: { pt: '15 min', en: '15 min' } },
  { ms: 3_600_000, label: { pt: '1 h', en: '1 h' } },
]

export type SnoozeParse =
  | { ok: true; ms: number }
  | { ok: false; reason: 'empty' | 'format' | 'range' }

/**
 * A snooze typed by hand: minutes or hours.
 *
 * Accepted: `30`, `30m`, `30 min`, `2h`, `2 h`, `1,5h`, `1.5h`, `1h30`, `1h30m`, `1h 30min`. A bare
 * number is MINUTES — it is the unit the two preset buttons beside the field are in. Refused, each
 * with its own reason so the field can say which: nothing typed, a shape it cannot read, and a time
 * under a minute or over a day (a snooze of three days is a dismissal somebody will forget made).
 */
export function parseSnooze(input: string): SnoozeParse {
  const s = input.trim().toLowerCase().replace(/\s+/g, '')
  if (!s) return { ok: false, reason: 'empty' }
  let minutes: number | null = null
  const hm = /^(\d+)h(\d+)(?:m|min)?$/.exec(s)
  if (hm) minutes = Number(hm[1]) * 60 + Number(hm[2])
  const single = /^(\d+(?:[.,]\d+)?)(m|min|h)?$/.exec(s)
  if (minutes === null && single) {
    const n = Number(single[1]!.replace(',', '.'))
    minutes = single[2] === 'h' ? n * 60 : n
  }
  if (minutes === null || !Number.isFinite(minutes)) return { ok: false, reason: 'format' }
  const ms = Math.round(minutes * 60_000)
  if (ms < SNOOZE_MIN_MS || ms > SNOOZE_MAX_MS) return { ok: false, reason: 'range' }
  return { ok: true, ms }
}

export function snoozeError(reason: 'empty' | 'format' | 'range', lang: 'pt' | 'en'): string {
  const pt = lang === 'pt'
  if (reason === 'empty') return pt ? 'Digite um tempo, como 30m ou 2h.' : 'Type a time, like 30m or 2h.'
  if (reason === 'format') return pt ? 'Use minutos ou horas: 30m, 2h, 1h30.' : 'Use minutes or hours: 30m, 2h, 1h30.'
  return pt ? 'Entre 1 minuto e 24 horas.' : 'Between 1 minute and 24 hours.'
}

/** "15 min", "1 h", "1 h 30 min" — how a snooze is said back to the person who set it. */
export function formatSpan(ms: number): string {
  const total = Math.max(0, Math.round(ms / 60_000))
  const h = Math.floor(total / 60), m = total % 60
  if (h === 0) return `${m} min`
  return m === 0 ? `${h} h` : `${h} h ${m} min`
}

// --- waiting -------------------------------------------------------------------------------------

/** "há 3 min", "há pelo menos 2 h 10 min", "agora" — the wait on the card, from the page's clock. */
export function formatWaiting(sinceMs: number, nowMs: number, known: boolean, lang: 'pt' | 'en'): string {
  const ms = Math.max(0, nowMs - sinceMs)
  if (ms < 60_000) return known ? (lang === 'pt' ? 'agora' : 'just now') : (lang === 'pt' ? 'há pelo menos 1 min' : 'at least 1 min')
  const span = formatSpan(ms)
  if (lang === 'pt') return known ? `há ${span}` : `há pelo menos ${span}`
  return known ? `${span} ago` : `at least ${span}`
}

/**
 * How long a card stays up before it goes back into the button by itself, in seconds (owner,
 * 2026-09-30: 5 s by default). `0` is "never". The card never leaves while somebody is using it —
 * the pointer is over it, it has the keyboard, or a drawer (approve, snooze, end) is open — and it
 * stays in the bell either way.
 */
export const AUTO_DISMISS_OPTIONS_SEC: readonly number[] = [3, 5, 10, 30, 0]
export const DEFAULT_AUTO_DISMISS_SEC = 5

/** The stale thresholds the settings offer, in minutes. `0` is "never". */
export const STALE_OPTIONS_MIN: readonly number[] = [15, 30, 60, 120, 240, 0]
export const DEFAULT_STALE_MIN = 60

/**
 * Is this session "not opened for a while" NOW?
 *
 * The clock starts at the LATER of two moments: when the session started waiting and when the
 * person last opened it. Opening a session is looking at it, and a session somebody looked at five
 * minutes ago has not been neglected for an hour whatever its state says. Only a session that is
 * waiting on a person counts — a session that is working is not neglected, it is busy.
 */
export function staleDue(o: {
  state: string
  sinceMs: number
  lastOpenedMs?: number | undefined
  nowMs: number
  thresholdMin: number
}): boolean {
  if (!(o.thresholdMin > 0)) return false
  if (o.state !== 'waiting' && o.state !== 'waiting-approval') return false
  const from = Math.max(o.sinceMs, o.lastOpenedMs ?? 0)
  return o.nowMs - from >= o.thresholdMin * 60_000
}

/**
 * Is the card for this alert still TRUE? A card left up after the person answered the session
 * somewhere else is a notification lying about the present. An approval card is true while the
 * session is blocked on a dialog; the other two while it waits on a person in any way.
 */
export function alertStillTrue(kind: NayAlertKind, state: string | undefined): boolean {
  // A plan-limit card is about a plan, not a session: true until dismissed or snoozed.
  if (kind === 'limit') return true
  if (kind === 'approval') return state === 'waiting-approval'
  return state === 'waiting' || state === 'waiting-approval'
}

// --- placement -----------------------------------------------------------------------------------

export interface Rect { x: number; y: number; w: number; h: number }

export interface CardPlacement {
  left: number
  top: number
  /** The button's centre, in the card's own coordinates — the transform origin of every animation. */
  originX: number
  originY: number
  /** Which edge of the card faces the button. */
  tailSide: 'top' | 'bottom'
  /** Where along that edge the tail sits. */
  tailX: number
}

/** The card's width: a fixed column on a desktop, the screen minus its gutters on a phone. */
export function cardWidth(vpW: number, isMobile: boolean): number {
  return isMobile ? Math.max(0, vpW - 24) : Math.min(360, vpW - 24)
}

const GAP = 14
const MARGIN = 12

/**
 * Where the card opens. It stands on the side of the button that has room — above a button in the
 * lower half, below one in the upper half — aligned to the button's own side of the screen, and
 * never past a margin or into the phone's bottom bar. With no button on screen (hidden inside a
 * session on a phone) it stands in the bottom corner the button would have occupied.
 */
export function cardPlacement(o: { fab: Rect | null; vpW: number; vpH: number; cardW: number; cardH: number; bottomInset: number }): CardPlacement {
  const floor = o.vpH - o.bottomInset
  const fab = o.fab ?? { x: o.vpW - 56 - 20, y: floor - 56 - 20, w: 56, h: 56 }
  const cx = fab.x + fab.w / 2, cy = fab.y + fab.h / 2
  let left = cx > o.vpW / 2 ? fab.x + fab.w - o.cardW : fab.x
  left = Math.max(MARGIN, Math.min(o.vpW - o.cardW - MARGIN, left))
  const above = cy > o.vpH / 2
  let top = above ? fab.y - GAP - o.cardH : fab.y + fab.h + GAP
  top = Math.max(MARGIN, Math.min(floor - o.cardH - MARGIN, top))
  const originX = cx - left, originY = cy - top
  return {
    left, top, originX, originY,
    tailSide: originY > o.cardH / 2 ? 'bottom' : 'top',
    tailX: Math.max(18, Math.min(o.cardW - 34, originX - 8)),
  }
}

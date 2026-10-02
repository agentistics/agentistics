/**
 * sessionNotifications.ts — Web Notifications & Sound Effects for Live Sessions
 */

import { versionedAsset } from './brand'
import type { SessionMeta } from '@agentistics/core'
import { isNayCwd, sessionLabel } from '@agentistics/core'
import { HARNESS_LABELS } from './harness'
import { clampVolume } from './soundVolume'
import { findNaySound, isNaySoundId, type NaySoundId } from './notificationSounds'
import {
  alertKey, DEFAULT_AUTO_DISMISS_SEC, DEFAULT_NAY_ANIMATION, DEFAULT_STALE_MIN, formatWaiting, parseNayAnimation, type NayAlert,
  type NayAlertKind, type NayAnimation,
} from './nayNotify'
import { observeFleet, pushAlert, pushDemoAlert, requestShock, resetNayNotifyStore, setSnoozeReleaseHandler, waitingSince } from './nayNotifyStore'
import { isSessionMuted } from './mutedSessions'
import { pushNotification, setMutedCategories, type NotificationType } from './notifications'
import { isNotificationCategory } from './notificationCategories'

export type SessionActivity = 'working' | 'waiting' | 'waiting-approval' | 'exited'
/** The four original chimes, plus the thirteen synthesized in `notificationSounds.ts`. */
export type LegacySoundPreset = 'chime' | 'soft' | 'alert' | 'ping'
export type SoundPreset = LegacySoundPreset | NaySoundId
const LEGACY_PRESETS: readonly string[] = ['chime', 'soft', 'alert', 'ping']
export function isSoundPreset(v: unknown): v is SoundPreset {
  return (typeof v === 'string' && LEGACY_PRESETS.includes(v)) || isNaySoundId(v)
}

/** The events the settings screen lists: the four states, plus "not opened for a while". */
export type NotifyEvent = SessionActivity | 'stale'

export interface NotificationSettings {
  enabled: boolean
  askedPrompt: boolean
  events: {
    'waiting-approval': boolean
    'waiting': boolean
    'working': boolean
    'exited': boolean
    /** A session waiting on a person that nobody has opened for `staleAfterMin`. */
    'stale': boolean
  }
  /**
   * REQUIRED, because it always exists.
   *
   * It was declared optional while `getNotificationSettings` fills it from the defaults on every
   * read — so the `?` described a state the code cannot produce, and made `keyof` on it resolve to
   * `never`. That is what broke the typecheck on `dev`: three errors in the settings screen, all of
   * them the type disagreeing with its own reader rather than a real absence.
   *
   * A stored blob written before this field existed is still handled — the reader spreads the
   * defaults under whatever it parsed, which is where the guarantee comes from.
   */
  eventSounds: {
    'waiting-approval': SoundPreset
    'waiting': SoundPreset
    'working': SoundPreset
    'exited': SoundPreset
    'stale': SoundPreset
    /**
     * Anything from a NAY CONVERSATION, whatever the event (owner, 2026-09-30): the Nay is a voice
     * of its own, so "needs you" and "needs approval" mean OTHER sessions. See `resolveSound`.
     */
    'nay': SoundPreset
  }
  soundEnabled: boolean
  soundPreset: SoundPreset
  soundVolume: number // 0.0 to 1.0
  /**
   * DO NOT DISTURB: no card, no sound, no shock, no system notification. The bell still records
   * every event, so nothing that happened is lost — it is only not announced.
   */
  doNotDisturb: boolean
  /** Minutes a waiting session may go unopened before the Nay button says so. `0` = never. */
  staleAfterMin: number
  /** Seconds before a card leaves by itself; `0` never. See `AUTO_DISMISS_OPTIONS_SEC`. */
  autoDismissSec: number
  /** How the Nay button delivers a card. Chosen in the chat settings; see `nayNotify.ts`. */
  nayAnimation: NayAnimation
  /** Kinds of bell notification turned off (`notificationCategories.ts`). Absent = none. */
  mutedCategories: string[]
}

import { createSharedPref } from './sharedPref'

const STORAGE_KEY = 'agentistics-notification-settings'

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  enabled: true,
  askedPrompt: false,
  events: {
    'waiting-approval': true,
    'waiting': true,
    'working': false,
    'exited': true,
    'stale': true,
  },
  // One synthesized sound per event, each chosen for what the event asks of the person: a light
  // pluck for "it answered", a rising question for "it needs you", the quietest one for a reminder.
  // Shipped defaults (owner, 2026-09-30); a stored choice is kept, only an ABSENT one reads these.
  eventSounds: {
    'waiting-approval': 'question',
    'waiting': 'triad',
    'working': 'soft',
    'exited': 'drop',
    'stale': 'breeze',
    'nay': 'nay',
  },
  soundEnabled: true,
  soundPreset: 'chime',
  soundVolume: 0.8,
  doNotDisturb: false,
  staleAfterMin: DEFAULT_STALE_MIN,
  nayAnimation: DEFAULT_NAY_ANIMATION,
  autoDismissSec: DEFAULT_AUTO_DISMISS_SEC,
  mutedCategories: [],
}

/**
 * PURE: whatever was stored, read as settings.
 *
 * Total by construction — the defaults are spread UNDER the parsed blob, per group, so a document
 * written before a field existed still yields a complete object rather than an `undefined` the
 * settings screen would render as a blank switch.
 */
export function readNotificationSettings(raw: unknown): NotificationSettings {
  const parsed = (raw ?? {}) as Partial<NotificationSettings>
  const sounds = { ...DEFAULT_NOTIFICATION_SETTINGS.eventSounds, ...(parsed.eventSounds ?? {}) }
  // A sound id this build does not know (stored by a newer one, or edited by hand) falls back to the
  // event's default rather than playing nothing while the screen shows a blank picker.
  for (const k of Object.keys(sounds) as (keyof typeof sounds)[]) {
    if (!isSoundPreset(sounds[k])) sounds[k] = DEFAULT_NOTIFICATION_SETTINGS.eventSounds[k]
  }
  const stale = Number(parsed.staleAfterMin)
  const autoDismiss = Number(parsed.autoDismissSec)
  return {
    ...DEFAULT_NOTIFICATION_SETTINGS,
    ...parsed,
    events: { ...DEFAULT_NOTIFICATION_SETTINGS.events, ...(parsed.events ?? {}) },
    eventSounds: sounds,
    soundPreset: isSoundPreset(parsed.soundPreset) ? parsed.soundPreset : DEFAULT_NOTIFICATION_SETTINGS.soundPreset,
    doNotDisturb: parsed.doNotDisturb === true,
    staleAfterMin: Number.isFinite(stale) && stale >= 0 ? stale : DEFAULT_STALE_MIN,
    nayAnimation: parseNayAnimation(parsed.nayAnimation),
    autoDismissSec: Number.isFinite(autoDismiss) && autoDismiss >= 0 ? autoDismiss : DEFAULT_AUTO_DISMISS_SEC,
    mutedCategories: Array.isArray(parsed.mutedCategories) ? parsed.mutedCategories.filter(isNotificationCategory) : [],
  }
}

/**
 * WHAT NOTIFIES ME IS SHARED; WHETHER THIS BROWSER HAS BEEN ASKED IS NOT.
 *
 * The choice — notify me when a session needs me, with this sound, at this volume — is about the
 * work, so switching it off at the desk must switch it off on the phone. `askedPrompt` is the
 * opposite: it records that THIS browser was shown the permission dialog, and the permission it
 * tracks is per device (an iOS home-screen app and a desktop Chrome each grant their own). Sharing
 * it would suppress the prompt on a device that has never been asked, which is the one way to make
 * notifications silently impossible to enable.
 */
const ASKED_KEY = 'agentistics-notification-asked'

const store = createSharedPref<NotificationSettings>({
  key: STORAGE_KEY,
  prefKey: 'notificationSettings',
  fallback: DEFAULT_NOTIFICATION_SETTINGS,
  parse: raw => (raw === null || typeof raw !== 'object' ? null : readNotificationSettings(raw)),
})

function readAsked(): boolean {
  try {
    const own = localStorage.getItem(ASKED_KEY)
    if (own !== null) return own === '1'
    // Before the split, `askedPrompt` lived inside the settings blob. Adopt it once so a browser
    // that HAS been asked is not asked again the day this ships.
    return store.get().askedPrompt === true
  } catch {
    return false
  }
}

export function getNotificationSettings(): NotificationSettings {
  return { ...store.get(), askedPrompt: readAsked() }
}

export function saveNotificationSettings(settings: NotificationSettings): void {
  try { localStorage.setItem(ASKED_KEY, settings.askedPrompt ? '1' : '0') } catch { /* private mode */ }
  store.set({ ...settings, askedPrompt: false })
  try {
    window.dispatchEvent(new CustomEvent('agentistics:notification-settings-changed', { detail: settings }))
  } catch {
    /* no window (a test, a worker) — the store is written either way */
  }
}

export function subscribeNotificationSettings(fn: () => void): () => void {
  return store.subscribe(fn)
}

// The bell shows only what is not muted: keep its filter in step with the stored choice.
setMutedCategories(store.get().mutedCategories ?? [])
store.subscribe(() => setMutedCategories(store.get().mutedCategories ?? []))

// ----------------------------------------------------------------------------
// Audio Synthesis Engine (Web Audio API)
// ----------------------------------------------------------------------------

let audioCtx: AudioContext | null = null

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null
  if (!audioCtx) {
    const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    if (AudioContextClass) {
      audioCtx = new AudioContextClass()
    }
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    void audioCtx.resume().catch(() => {})
  }
  return audioCtx
}

export function playNotificationSound(preset: SoundPreset = 'chime', volume: number = 0.8): void {
  try {
    const ctx = getAudioContext()
    if (!ctx) return

    const now = ctx.currentTime
    const masterGain = ctx.createGain()
    masterGain.gain.setValueAtTime(clampVolume(volume, 0.8), now)
    masterGain.connect(ctx.destination)

    const synth = findNaySound(preset)
    if (synth) { synth.play(ctx, masterGain, now + 0.01); return }

    if (preset === 'chime') {
      // Warm dual-tone chord: C5 (523.25 Hz) -> E5 (659.25 Hz) -> G5 (783.99 Hz)
      const freqs = [523.25, 659.25, 783.99]
      freqs.forEach((freq, idx) => {
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        osc.type = 'sine'
        osc.frequency.setValueAtTime(freq, now + idx * 0.08)

        gain.gain.setValueAtTime(0.01, now + idx * 0.08)
        gain.gain.exponentialRampToValueAtTime(0.3, now + idx * 0.08 + 0.03)
        gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.08 + 0.6)

        osc.connect(gain)
        gain.connect(masterGain)

        osc.start(now + idx * 0.08)
        osc.stop(now + idx * 0.08 + 0.65)
      })
    } else if (preset === 'soft') {
      // Gentle double pulse (A4 -> C#5)
      const freqs = [440, 554.37]
      freqs.forEach((freq, idx) => {
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        osc.type = 'sine'
        osc.frequency.setValueAtTime(freq, now + idx * 0.12)

        gain.gain.setValueAtTime(0.01, now + idx * 0.12)
        gain.gain.exponentialRampToValueAtTime(0.2, now + idx * 0.12 + 0.02)
        gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.12 + 0.4)

        osc.connect(gain)
        gain.connect(masterGain)

        osc.start(now + idx * 0.12)
        osc.stop(now + idx * 0.12 + 0.45)
      })
    } else if (preset === 'alert') {
      // Triple ascending alert tone (E5 -> G#5 -> B5)
      const freqs = [659.25, 830.61, 987.77]
      freqs.forEach((freq, idx) => {
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        osc.type = 'triangle'
        osc.frequency.setValueAtTime(freq, now + idx * 0.09)

        gain.gain.setValueAtTime(0.01, now + idx * 0.09)
        gain.gain.exponentialRampToValueAtTime(0.35, now + idx * 0.09 + 0.02)
        gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.09 + 0.4)

        osc.connect(gain)
        gain.connect(masterGain)

        osc.start(now + idx * 0.09)
        osc.stop(now + idx * 0.09 + 0.45)
      })
    } else if (preset === 'ping') {
      // High crystal bell (A5 -> A6)
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(880, now)
      osc.frequency.exponentialRampToValueAtTime(1760, now + 0.05)

      gain.gain.setValueAtTime(0.4, now)
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.5)

      osc.connect(gain)
      gain.connect(masterGain)

      osc.start(now)
      osc.stop(now + 0.55)
    }
  } catch {
    /* AudioContext blocked or unsupported */
  }
}

// ----------------------------------------------------------------------------
// No operating-system notifications
// ----------------------------------------------------------------------------
//
// The web app notifies IN-APP ONLY (owner, 2026-09-30): the Nay button's card, its sound, and the
// header bell. The browser Notification API (permission prompt, service-worker toasts, the
// "system notification while the tab is hidden" switch) is gone. Delivery to a desktop when no
// browser is open belongs to `agentop events` (server/events/), which this does not touch.

/**
 * What a notification needs to know about a session in order to NAME it.
 *
 * Widened from `SessionMeta` so the live FLEET can be notified about — which is the whole point of
 * the feature and was, for a while, the one caller that did not exist: the settings screen could
 * send a test notification, the tests exercised the transitions, and nothing in the running app
 * ever called this. Reported as "as notificações web não estão funcionando", and it was exactly
 * that: a feature wired to nothing.
 *
 * A fleet row is not a `SessionMeta` and never will be — it is a live process, not a transcript —
 * so the parameter states the three things actually read here instead of demanding the whole type.
 */
export interface NotifiableSession {
  user_label?: string
  title?: string
  first_prompt?: string
  project_path?: string
  harness?: string
  model?: string
}

export function handleSessionStateTransitions(
  prevActivities: Record<string, SessionActivity>,
  nextActivities: Record<string, SessionActivity>,
  sessionsMap: Map<string, NotifiableSession>,
  lang: 'pt' | 'en' = 'pt'
): void {
  const settings = getNotificationSettings()
  if (!settings.enabled) return

  for (const [id, nextState] of Object.entries(nextActivities)) {
    const prevState = prevActivities[id]
    if (prevState && prevState === nextState) continue

    // Check if this event type is enabled in settings
    if (!settings.events[nextState]) continue

    const session = sessionsMap.get(id)
    const sessionTitle = session ? sessionLabel(session) : ''
    const folderName = session?.project_path ? (session.project_path.split('/').filter(Boolean).pop() || '') : ''
    const sessionSubject = sessionTitle || folderName || id.slice(0, 8)
    const harnessName = session?.harness
      ? ((HARNESS_LABELS as Record<string, string>)[session.harness] || session.harness.toUpperCase())
      : ''
    // The connector is LOCALIZED. It was a hardcoded Portuguese `em` used by both branches, so an
    // English notification read "Session X (CLAUDE CODE em agentistics) is waiting for your
    // response" — one Portuguese word in the middle of an English sentence, on the surface a user
    // reads at a glance while doing something else.
    const inWord = lang === 'pt' ? 'em' : 'in'
    const locationInfo = folderName ? ` (${harnessName} ${inWord} ${folderName})` : harnessName ? ` (${harnessName})` : ''

    let title = ''
    let body = ''

    if (nextState === 'waiting-approval') {
      title = lang === 'pt'
        ? `[Precisa de Aprovação] ${sessionSubject}`
        : `[Needs Approval] ${sessionSubject}`
      body = lang === 'pt'
        ? `A sessão "${sessionSubject}"${locationInfo} está aguardando sua autorização para continuar.`
        : `Session "${sessionSubject}"${locationInfo} is waiting for your authorization to proceed.`
    } else if (nextState === 'waiting') {
      title = lang === 'pt'
        ? `[Aguardando Resposta] ${sessionSubject}`
        : `[Waiting Input] ${sessionSubject}`
      body = lang === 'pt'
        ? `A sessão "${sessionSubject}"${locationInfo} concluiu o turno e aguarda sua resposta.`
        : `Session "${sessionSubject}"${locationInfo} finished its turn and is waiting for your response.`
    } else if (nextState === 'working') {
      title = lang === 'pt'
        ? `[Em Andamento] ${sessionSubject}`
        : `[Working] ${sessionSubject}`
      body = lang === 'pt'
        ? `A sessão "${sessionSubject}"${locationInfo} iniciou o processamento.`
        : `Session "${sessionSubject}"${locationInfo} started working.`
    } else if (nextState === 'exited') {
      title = lang === 'pt'
        ? `[Sessão Encerrada] ${sessionSubject}`
        : `[Session Closed] ${sessionSubject}`
      body = lang === 'pt'
        ? `A sessão "${sessionSubject}"${locationInfo} foi finalizada.`
        : `Session "${sessionSubject}"${locationInfo} was closed.`
    }

    if (!title || !body) continue
    const kind: NayAlertKind | null = nextState === 'waiting' ? 'turn' : nextState === 'waiting-approval' ? 'approval' : null
    const nay = isNayCwd(session?.project_path)
    const since = waitingSince(id)
    const sinceMs = since?.sinceMs ?? Date.now()
    deliver({
      event: nextState, nay,
      title, body, tag: `session-${id}`,
      bell: { code: BELL_CODE[nextState], id, name: sessionSubject, harness: harnessName, sinceMs },
      ...(kind ? {
        alert: {
          key: alertKey(kind, id, sinceMs), kind, sessionId: id, name: sessionSubject,
          harness: session?.harness, model: session?.model, sinceMs, sinceKnown: since?.known ?? true,
          ...(nay ? { nay: true } : {}),
        },
      } : {}),
      shock: nextState === 'waiting',
    }, settings)
  }
}

// ----------------------------------------------------------------------------
// Delivery — the Nay button's card, the bell, and the system notification
// ----------------------------------------------------------------------------

/** Every session event is written to the bell (`notifications.ts`) under one of these codes. */
export const BELL_CODE: Record<NotifyEvent, string> = {
  'waiting': 'session.turn_ended',
  'waiting-approval': 'session.needs_approval',
  'stale': 'session.stale',
  'working': 'session.working',
  'exited': 'session.exited',
}

const BELL_TYPE: Record<NotifyEvent, NotificationType> = {
  'waiting': 'info', 'waiting-approval': 'warning', 'stale': 'info', 'working': 'info', 'exited': 'info',
}

/** Codes the Nay button shows as its own card — the generic toast must not show them a second time. */
export const NAY_CARD_CODES: ReadonlySet<string> = new Set([BELL_CODE.waiting, BELL_CODE['waiting-approval'], BELL_CODE.stale])

/**
 * PURE: which sound one notification rings. A notification from a NAY CONVERSATION always rings
 * the Nay sound, whatever the event; every other session rings its event's own sound.
 */
export function resolveSound(event: NotifyEvent, nay: boolean, settings: Pick<NotificationSettings, 'eventSounds'>): SoundPreset {
  return nay ? settings.eventSounds.nay : settings.eventSounds[event]
}

interface Delivery {
  event: NotifyEvent
  /** The session is a Nay conversation (`isNayCwd`): it rings the Nay sound. */
  nay?: boolean
  title: string
  body: string
  tag: string
  bell: { code: string; id: string; name: string; harness: string; sinceMs: number }
  alert?: NayAlert
  /** "The session replied" — the button shocks (the button decides whether the page allows it). */
  shock?: boolean
}

/**
 * Where one event goes — in-app only.
 *
 * - The BELL always gets it, so nothing is lost to do-not-disturb, a hidden tab or a card that left.
 *   Its `meta` is the same in every open tab (the minute, not the millisecond), so the server's
 *   dedupe keeps ONE row however many tabs saw the transition; it leaves by itself once the session
 *   no longer needs the person (`pruneBell`, in `nayNotifyStore.ts`).
 * - A VISIBLE tab shows the Nay button's card and plays the event's sound.
 * - A tab in the BACKGROUND does nothing more: a card there would be stale by the time anybody
 *   looked, and every hidden tab ringing would ring once per tab. The bell already has it.
 * - Do-not-disturb silences all of it except the bell.
 */
/** Test seam: every delivery, as decided — the sentence and the event, before any channel runs. */
let deliveryObserver: ((d: { event: NotifyEvent; title: string; body: string; nay: boolean }) => void) | null = null
export function observeDeliveries(fn: typeof deliveryObserver): void { deliveryObserver = fn }

/**
 * Managed id -> the key a mute is stored under (`sessionIdentityKey`: conversationId ?? id). Filled
 * from every fleet snapshot, because a delivery only carries the managed id. A row this page has not
 * seen falls back to the id itself, which is the key whenever no conversation is linked.
 */
const muteKeyById = new Map<string, string>()
function isMutedId(id: string): boolean {
  return isSessionMuted(muteKeyById.get(id) ?? id)
}

function deliver(d: Delivery, settings: NotificationSettings): void {
  // MUTE SUPPRESSES DELIVERY ONLY — bell, card, shock, sound. The session's state (`waiting`) is
  // computed upstream of here and never touched. The observer still sees it: it is the decision log.
  if (isMutedId(d.bell.id)) return
  deliveryObserver?.({ event: d.event, title: d.title, body: d.body, nay: d.nay === true })
  if (typeof document !== 'undefined') {
    pushNotification({
      type: BELL_TYPE[d.event],
      code: d.bell.code,
      meta: {
        sessionId: d.bell.id, name: d.bell.name, harness: d.bell.harness,
        at: new Date(d.bell.sinceMs).toISOString().slice(0, 16),
      },
    })
  }
  if (settings.doNotDisturb) return
  const visible = typeof document !== 'undefined' && document.visibilityState === 'visible'
  if (!visible) return
  if (d.alert) pushAlert(d.alert)
  if (d.shock) requestShock()
  if (settings.soundEnabled) playNotificationSound(resolveSound(d.event, d.nay === true, settings), settings.soundVolume)
}

/** A snoozed card coming back: the card and its sound again, never the bell a second time. */
setSnoozeReleaseHandler(alert => {
  const settings = getNotificationSettings()
  if (!settings.enabled || settings.doNotDisturb) return
  if (isMutedId(alert.sessionId)) return
  if (!pushAlert(alert)) return
  const event: NotifyEvent = alert.kind === 'turn' ? 'waiting' : alert.kind === 'approval' ? 'waiting-approval' : 'stale'
  if (settings.soundEnabled) playNotificationSound(resolveSound(event, alert.nay === true, settings), settings.soundVolume)
})

/** The title and body of a "not opened for a while" notification, for the system path. */
function staleText(name: string, place: string, waited: string, lang: 'pt' | 'en'): { title: string; body: string } {
  return lang === 'pt'
    ? { title: `[Sem abrir] ${name}`, body: `A sessão "${name}"${place} espera por você ${waited} e ninguém a abriu.` }
    : { title: `[Not opened] ${name}`, body: `Session "${name}"${place} has been waiting for you ${waited} and nobody opened it.` }
}


/**
 * The live fleet's transitions, as notifications. THE CALLER THAT WAS MISSING.
 *
 * Two rules it must keep, and they are the same two the cockpit's bell and the VS Code extension
 * keep — stated here because this is a third implementation of the same idea and they have to agree:
 *
 * - IT RINGS ON THE TRANSITION, NEVER ON THE LEVEL. A session sitting in `waiting` is the normal
 *   end of every turn; notifying on the state rather than the change is a notification per poll.
 * - THE FIRST SNAPSHOT ANNOUNCES NOTHING. Opening a machine with nine blocked sessions would
 *   otherwise greet the reader with nine toasts about things that happened while they were away —
 *   the header's own counter is what reports a standing situation.
 *
 * `states` is exported for the caller to hold: it keeps the previous snapshot, and holding it here
 * would make the module remember something across a page it no longer belongs to.
 */
export function fleetActivityStates(
  rows: readonly { id: string; state: string }[],
): Record<string, SessionActivity> {
  const out: Record<string, SessionActivity> = {}
  for (const r of rows) {
    // Only the four this feature has words for. `lost`, `closed` and `unknown` are not events that
    // happened to a person — they are what a row IS — and inventing a sentence for them would put
    // "your session is unknown" on someone's desktop.
    if (r.state === 'working' || r.state === 'waiting' || r.state === 'waiting-approval' || r.state === 'exited') {
      out[r.id] = r.state
    }
  }
  return out
}

/**
 * The states seen on the PREVIOUS poll but not yet announced — see `notifyFleetTransitions`.
 *
 * Module-level and not a parameter, because the caller already threads one snapshot and adding a
 * second would let the two drift apart. It is reset by a `null` snapshot, which is what a fresh
 * page is.
 */
let unconfirmed: Record<string, SessionActivity> = {}

type FleetNotifyRow = { id: string; conversationId?: string; state: string; title?: string; cwd?: string; harness?: string; model?: string }

/**
 * "Not opened for a while": read this poll into the store's waiting clocks and raise each session
 * that has just crossed the line. It runs on EVERY poll, the first included — the clocks have to
 * start somewhere — and cannot fire on the first one, because every clock starts at that poll.
 */
function raiseStale(rows: readonly FleetNotifyRow[], lang: 'pt' | 'en'): void {
  const settings = getNotificationSettings()
  const due = observeFleet(rows, settings.enabled && settings.events.stale ? settings.staleAfterMin : 0)
  for (const c of due) {
    const r = rows.find(x => x.id === c.id)
    if (!r) continue
    const name = r.title || (r.cwd?.split('/').filter(Boolean).pop() ?? '') || r.id.slice(0, 8)
    const harness = r.harness ? ((HARNESS_LABELS as Record<string, string>)[r.harness] || r.harness) : ''
    const folder = r.cwd?.split('/').filter(Boolean).pop() ?? ''
    const place = folder ? ` (${harness}${harness ? (lang === 'pt' ? ' em ' : ' in ') : ''}${folder})` : ''
    const { title, body } = staleText(name, place, formatWaiting(c.sinceMs, Date.now(), c.known, lang), lang)
    const nay = isNayCwd(r.cwd)
    deliver({
      event: 'stale', nay, title, body, tag: `session-stale-${r.id}`,
      bell: { code: BELL_CODE.stale, id: r.id, name, harness, sinceMs: c.sinceMs },
      alert: {
        key: alertKey('stale', r.id, c.sinceMs), kind: 'stale', sessionId: r.id, name,
        harness: r.harness, model: r.model, sinceMs: c.sinceMs, sinceKnown: c.known,
        ...(nay ? { nay: true } : {}),
      },
    }, settings)
  }
}

export function notifyFleetTransitions(
  prev: Record<string, SessionActivity> | null,
  rows: readonly FleetNotifyRow[],
  lang: 'pt' | 'en',
): Record<string, SessionActivity> {
  const seen = fleetActivityStates(rows)
  for (const r of rows) muteKeyById.set(r.id, r.conversationId ?? r.id)
  raiseStale(rows, lang)
  // `null` is the first snapshot — see the rule above. It is deliberately distinct from `{}`, which
  // is a machine that genuinely had no sessions a moment ago and now has one.
  if (prev === null) { unconfirmed = seen; return seen }

  /*
   * A STATE COUNTS ONLY ONCE IT HAS BEEN SEEN TWICE IN A ROW.
   *
   * `attention.ts` decides `working` from whether the pane MOVED, and a pane moves for reasons that
   * are not a turn: a repaint, an advisory line, a plugin notice. One of those flips a session to
   * `working` for a single poll and back, and every flip was an announcement — reported as "tem
   * sessao que fica alternando o status de needs you pra working e fica disparando notificacao
   * adoidado".
   *
   * This is not a new idea in this codebase: `event-plan.ts` holds the same rule, for the same
   * signal, and says a time window does NOT work — the next flicker lands outside it. The web
   * notifier simply never applied it.
   *
   * The cost is stated: a state that lasts less than one poll interval is never announced. That is
   * the right trade for a channel whose whole job is to interrupt a person.
   */
  /*
   * …AND A ROW THIS PAGE HAS NEVER SEEN IN ANOTHER STATE IS A LEVEL, NOT A TRANSITION.
   *
   * The rule above settles WHEN a state is believed; this one settles whether believing it is
   * NEWS. They are different bugs and both were live: the flicker announced a state that was never
   * really there, and this one announced a state that was there all along before anyone looked.
   *
   * Rows join and leave the fleet for reasons that are not a session changing state — a short-lived
   * session born and finished inside one poll interval, a retired predecessor
   * `collapseSupersededSessions` hides and shows again, a row reading `lost` for one poll (which
   * has no words here, so it leaves the map) and returning as `exited` on the next. Each arrived
   * with no previous state and each rang "[Session Closed]" for a session nobody had watched close:
   * "notificações de sessões FECHADAS estão disparando para sessões que já fecharam". The
   * two-poll confirmation alone only DELAYS that by one poll.
   *
   * It is the same rule the FIRST SNAPSHOT already applies, at the scale of one session instead of
   * a whole page. The one exception is stated rather than inferred: `waiting-approval`. Every other
   * sentence here reports a CHANGE ("it finished its turn", "it was closed", "it started working")
   * and is only true if the state before it was seen; that one reports a session BLOCKED ON A
   * PERSON, stays true until they answer, and may have no later transition to ring on — so silence
   * there costs the session itself rather than one notification.
   *
   * The state is RECORDED either way. Withholding the announcement must not withhold the baseline,
   * or a row first seen as `working` could never announce anything it did afterwards.
   */
  const next: Record<string, SessionActivity> = { ...prev }
  const announce: Record<string, SessionActivity> = {}
  for (const [id, state] of Object.entries(seen)) {
    if (prev[id] === state) continue          // already announced, nothing new
    if (unconfirmed[id] !== state) continue   // first sighting — wait for the next poll
    const firstSight = prev[id] === undefined
    next[id] = state
    if (!firstSight || state === 'waiting-approval') announce[id] = state
  }
  // A row that vanished from the fleet stops being tracked, or its last state would be re-announced
  // if it came back to the same one.
  for (const id of Object.keys(next)) if (!(id in seen)) delete next[id]
  unconfirmed = seen
  if (Object.keys(announce).length === 0) return next
  const map = new Map<string, NotifiableSession>()
  for (const r of rows) {
    map.set(r.id, {
      ...(r.title ? { title: r.title } : {}),
      ...(r.cwd ? { project_path: r.cwd } : {}),
      ...(r.harness ? { harness: r.harness } : {}),
      ...(r.model ? { model: r.model } : {}),
    })
  }
  // Only what was CONFIRMED this poll AND is a transition — `prev` is passed as the baseline so the
  // handler's own "has it changed" check still holds for each of them. `next` is what the caller
  // keeps, withheld rows included: a row seen for the first time now is not news, and must be a
  // baseline the moment it changes.
  handleSessionStateTransitions(prev, announce, map, lang)
  return next
}

/** Test seam: the confirmation memory is module state, and a test must be able to clear it. */
export function resetNotificationMemory(): void {
  unconfirmed = {}
  resetNayNotifyStore()
}

/**
 * THE PREVIEW behind every "Testar" (owner, 2026-09-30: "cannot test combinations"). It plays what a
 * real "needs you" notification does with the CURRENT settings, in the same order `deliver` does:
 * the card with the chosen entrance, the button's shock, and the event's own sound when sound is on.
 * A demo card carries no session, never enters the inbox and never reaches the bell. Do-not-disturb
 * is deliberately NOT applied — a preview that shows nothing cannot preview anything; the settings
 * screen says in words that do-not-disturb would silence it.
 */
export function previewNayNotification(lang: 'pt' | 'en'): void {
  const settings = getNotificationSettings()
  pushDemoAlert(lang)
  requestShock()
  if (settings.soundEnabled) playNotificationSound(settings.eventSounds.waiting, settings.soundVolume)
}

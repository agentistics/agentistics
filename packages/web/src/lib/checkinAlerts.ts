/**
 * checkinAlerts.ts — the IO half of CHECKIN.S4: the SSE `checkin` event in, ONE Nay card out.
 *
 * The rules are `checkinNotify.ts` (pure, tested); this module only reads the world (the event, the
 * clock, localStorage, the notification settings) and hands the decision to the store. A round that
 * is not `needs_you` raises nothing — the leader solved it or there was nothing to solve, and that
 * lives in the task's Activity, not in a notification.
 */

import { subscribeEvent } from './eventStream'
import type { CheckinState } from './checkin'
import {
  inQuietHours, markSummaryGiven, mergeHeld, planRound, summaryDue,
  type CheckinNeed, type SubjectMemory, type SummaryState,
} from './checkinNotify'
import { alertKey, type NayAlert } from './nayNotify'
import { pushAlert } from './nayNotifyStore'
import { getNotificationSettings, playNotificationSound } from './sessionNotifications'

const MEMORY_KEY = 'agentistics-checkin-subjects'
const HELD_KEY = 'agentistics-checkin-held'
const SUMMARY_KEY = 'agentistics-checkin-summary'
/** A subject not heard of for a week is forgotten, so the map cannot grow for ever. */
const MEMORY_TTL_MS = 7 * 24 * 3_600_000

function read<T>(key: string, fallback: T): T {
  try { const raw = localStorage.getItem(key); return raw === null ? fallback : JSON.parse(raw) as T } catch { return fallback }
}
function write(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* private window: a convenience lost */ }
}

interface Held { leader: string; need: CheckinNeed }

function lang(): 'pt' | 'en' {
  try { return (document.documentElement.lang || navigator.language || 'pt').toLowerCase().startsWith('en') ? 'en' : 'pt' } catch { return 'pt' }
}

function raise(leader: string, items: CheckinNeed[], now: number, summary?: 'away' | 'morning'): void {
  if (items.length === 0) return
  const settings = getNotificationSettings()
  const alert: NayAlert = {
    key: alertKey('checkin', `${leader}:${summary ?? 'round'}`, now), kind: 'checkin', sessionId: `checkin:${leader}`,
    name: leader, sinceMs: now, sinceKnown: true,
    checkin: { leader, ...(summary ? { summary } : {}), items },
  }
  if (!pushAlert(alert, now)) return
  if (settings.soundEnabled) {
    const loud = items.some(i => i.critical)
    playNotificationSound(settings.eventSounds[loud ? 'waiting-approval' : 'waiting'], settings.soundVolume)
  }
}

/** Hold what cannot ring now (silence, do-not-disturb, a hidden tab) for the next summary. */
function hold(leader: string, needs: CheckinNeed[]): void {
  if (needs.length === 0) return
  const held = read<Held[]>(HELD_KEY, [])
  const merged = mergeHeld(held.map(h => h.need), needs)
  const leaderOf = new Map(held.map(h => [h.need.subject, h.leader]))
  for (const n of needs) leaderOf.set(n.subject, leader)
  write(HELD_KEY, merged.map(need => ({ leader: leaderOf.get(need.subject) ?? leader, need })))
}

/** The `checkin` SSE event (a `CheckinState`). Exported so a test can drive it without a socket. */
export function onCheckinState(state: CheckinState, now = Date.now()): void {
  const last = state.last
  if (!last || last.state !== 'needs_you' || !last.needs?.length) return
  const settings = getNotificationSettings()
  if (!settings.enabled) return
  const prev = read<Record<string, SubjectMemory>>(MEMORY_KEY, {})
  for (const [k, v] of Object.entries(prev)) if (now - v.at > MEMORY_TTL_MS) delete prev[k]
  const silent = settings.doNotDisturb || (typeof document !== 'undefined' && document.visibilityState !== 'visible')
  const plan = planRound({ needs: last.needs, memory: prev, quiet: inQuietHours(settings.quietHours, now), now })
  write(MEMORY_KEY, plan.memory)
  // DND and a hidden tab hold even the critical ones: a card nobody sees is a card that did not ring.
  if (silent) { hold(state.session, [...plan.raise, ...plan.held]); return }
  hold(state.session, plan.held)
  raise(state.session, plan.raise, now)
}

/** Raise the summary when it is due. Called on start, when the tab shows again, and once a minute. */
export function checkSummary(now = Date.now()): void {
  const settings = getNotificationSettings()
  const held = read<Held[]>(HELD_KEY, [])
  const st = read<SummaryState>(SUMMARY_KEY, { lastSeenAt: now, lastSummaryDay: null })
  const visible = typeof document === 'undefined' || document.visibilityState === 'visible'
  if (visible && !settings.doNotDisturb && settings.enabled) {
    const due = summaryDue({ q: settings.quietHours, nowMs: now, held: held.length, state: st })
    if (due) {
      write(HELD_KEY, [])
      write(SUMMARY_KEY, markSummaryGiven(st, now))
      raise(held[0]!.leader, held.map(h => h.need), now, due)
      return
    }
  }
  // Only a visible tab counts as "the app was open": a tab left hidden is the person being away.
  if (visible) write(SUMMARY_KEY, { ...st, lastSeenAt: now })
}

let started = false
export function startCheckinAlerts(): () => void {
  if (started || typeof window === 'undefined') return () => {}
  started = true
  const off = subscribeEvent('checkin', event => {
    try { onCheckinState(JSON.parse(event.data) as CheckinState) } catch { /* a malformed broadcast: the next one repairs it */ }
  })
  const onVis = () => checkSummary()
  document.addEventListener('visibilitychange', onVis)
  const timer = setInterval(() => checkSummary(), 60_000)
  checkSummary()
  return () => { started = false; off(); document.removeEventListener('visibilitychange', onVis); clearInterval(timer) }
}

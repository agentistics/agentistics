/**
 * seen.ts — "the last version this person was told about", kept on the SERVER per person.
 *
 * It was `localStorage` (`ag-whats-new-seen`), so the same update was announced once per browser.
 * It is a choice about the work, not the screen, so it lives in `/api/user-prefs` (`whatsNewSeen`)
 * like every other personal store: whichever device opens first shows it, the others stay quiet.
 * The browser copy keeps the OLD key and the old format (a bare version string) as the first paint
 * and as the one-time migration source: when the server has nothing and this browser has a value,
 * that value is uploaded (`adoptLocalWhenAbsent`).
 */
import { createSharedPref, loadPersonalPrefs } from '../lib/sharedPref'
import { SEEN_KEY, nextSeen, planWhatsNew, type WhatsNewPlan } from './select'
import type { ReleaseNotes } from './releases'

export const seenStore = createSharedPref<string>({
  key: SEEN_KEY,
  prefKey: 'whatsNewSeen',
  adoptLocalWhenAbsent: true,
  fallback: '',
  parse: raw => (typeof raw === 'string' ? raw.trim() : null),
  encode: v => v,
  decode: raw => raw,
})

/**
 * Settle a load of `current`: wait for the server's answer, decide what to announce (the server
 * value wins; absent, the browser's migrated one; absent too — a first install — nothing), then
 * remember `current`. Never throws; an unreachable server falls back to the browser copy.
 */
export async function settleWhatsNew(current: string, table?: Record<string, ReleaseNotes>): Promise<WhatsNewPlan | null> {
  if (!current) return null
  try { await loadPersonalPrefs() } catch { /* offline: the browser copy decides */ }
  const seen = seenStore.get()
  const plan = planWhatsNew({ current, seen, table })
  const next = nextSeen(current, seen)
  if (next) seenStore.set(next)
  return plan
}

/**
 * "Open the news after an update" — saved in the machine's server-side settings like the seen
 * version, so one answer covers every device. ABSENT reads as ON (the default is to announce);
 * only an explicit `false` ("Don't show again") silences the automatic open. The notification and
 * Settings → What's new keep working either way.
 */
export const autoOpenStore = createSharedPref<boolean>({
  key: 'ag-whats-new-auto-open',
  prefKey: 'whatsNewAutoOpen',
  adoptLocalWhenAbsent: true,
  fallback: true,
  parse: raw => (typeof raw === 'boolean' ? raw : null),
  encode: v => (v ? '1' : '0'),
  decode: raw => raw === '1',
})

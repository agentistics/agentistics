/**
 * Executing a confirmed idle review. Each session runs its own sequence and stops at ITS first
 * failure; the others continue. The effects are injected so the order and the stop rule are tested
 * without a server. A session is re-checked first: the user may have messaged it since the modal
 * opened, and ending it then would end live work.
 */
import type { GroupSuggestion } from '@agentistics/core'

export type IdleAction = 'file-end' | 'end' | 'keep'

export interface IdlePlanItem { id: string; key: string; title: string; action: IdleAction; group: GroupSuggestion }

export type IdleOutcome = { id: string; title: string; result: 'ended' | 'kept' | 'skipped' | 'failed'; message?: string }

export interface IdleEffects {
  stillIdle(id: string): Promise<boolean>
  /** Returns the group id to file into (creating it when `kind: 'new'` or when it vanished), or null. */
  ensureGroup(g: GroupSuggestion): string | null
  fileInto(groupId: string, key: string): void
  end(id: string): Promise<{ ok: boolean; message: string }>
  keep(keys: string[]): void
}

export async function runIdlePlan(items: IdlePlanItem[], fx: IdleEffects): Promise<IdleOutcome[]> {
  const out: IdleOutcome[] = []
  const keep = items.filter(i => i.action === 'keep')
  for (const it of items) {
    if (it.action === 'keep') continue
    if (!(await fx.stillIdle(it.id))) { out.push({ id: it.id, title: it.title, result: 'skipped' }); continue }
    if (it.action === 'file-end') {
      const gid = fx.ensureGroup(it.group)
      if (!gid) { out.push({ id: it.id, title: it.title, result: 'failed', message: 'group' }); continue }
      fx.fileInto(gid, it.key)
    }
    const r = await fx.end(it.id)
    out.push(r.ok
      ? { id: it.id, title: it.title, result: 'ended' }
      : { id: it.id, title: it.title, result: 'failed', message: r.message })
  }
  if (keep.length > 0) {
    fx.keep(keep.map(k => k.key))
    for (const k of keep) out.push({ id: k.id, title: k.title, result: 'kept' })
  }
  // Report in the order the user saw.
  const order = new Map(items.map((it, i) => [it.id, i]))
  return out.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
}

/**
 * Whether the idle-review card/notice should show. `candidateKeys`/`dismissedKeys` are optional —
 * the modal-suppression and snooze rules alone are what `SessionsPage` used to check before the
 * card existed, and still all that a caller with no dismissal state needs. When BOTH are given, a
 * batch every one of whose sessions is in `dismissedKeys` stays hidden until a session outside that
 * set becomes a candidate — the `×` on the card dismisses the CURRENT batch, never "idle sessions
 * forever": `lib/idleReviewStore.ts` is what actually keeps `dismissedKeys` across renders.
 */
export function bannerVisible(a: {
  candidates: number
  modalOpen: boolean
  snoozedUntil: number | null
  now: number
  candidateKeys?: readonly string[]
  dismissedKeys?: ReadonlySet<string>
}): boolean {
  if (a.candidates === 0 || a.modalOpen) return false
  if (!(a.snoozedUntil === null || a.now >= a.snoozedUntil)) return false
  if (a.candidateKeys && a.dismissedKeys) {
    const dismissed = a.dismissedKeys
    return a.candidateKeys.some(k => !dismissed.has(k))
  }
  return true
}

export type GroupResolution = { action: 'reuse'; groupId: string } | { action: 'create'; name: string }

/**
 * Decide whether a group SUGGESTION should reuse an existing group or be created fresh.
 *
 * `ensureGroup` used to call `createSessionGroup` unconditionally for every `kind: 'new'` plan
 * item, so two idle sessions whose suggestion is the same not-yet-existing name (two "Idle ·
 * 2026-09-26" rows, or two sessions of the same task) each minted their own group. This is the
 * pure decision behind the fix, so it can be tested without the group store:
 *
 * - `kind: 'new'` first reuses a name already created THIS RUN (`createdThisRun` — a group an
 *   earlier item in the same apply just created is not yet in `existingGroups`, which is read
 *   once at the start of the modal), then a same-named survivor already on disk, and only then
 *   creates.
 * - `kind: 'existing'` reuses its id when the group is still there. When it vanished (deleted
 *   between the suggestion and the apply), it falls back to its NAME through the exact same rule
 *   a `kind: 'new'` suggestion follows — reuse this run's own creation first, then a same-named
 *   survivor, and only then mint one.
 */
export function resolveGroupSuggestion(
  g: GroupSuggestion,
  existingGroups: readonly { id: string; name: string }[],
  createdThisRun: ReadonlyMap<string, string>,
): GroupResolution {
  if (g.kind === 'existing' && existingGroups.some(e => e.id === g.groupId)) {
    return { action: 'reuse', groupId: g.groupId }
  }
  const createdId = createdThisRun.get(g.name)
  if (createdId) return { action: 'reuse', groupId: createdId }
  const survivor = existingGroups.find(e => e.name === g.name)
  if (survivor) return { action: 'reuse', groupId: survivor.id }
  return { action: 'create', name: g.name }
}

/** "1 session" / "2 sessions" / "1 sessão" / "2 sessões" — proper singular/plural for the idle-
 *  sessions count, shared by the idle-review card, the review modal's summary and the
 *  `sessions.idle` notification so the surfaces never disagree on when to say "session" and when
 *  "sessions". */
export function idleSessionNoun(count: number, lang: 'pt' | 'en'): string {
  if (lang === 'pt') return count === 1 ? 'sessão' : 'sessões'
  return count === 1 ? 'session' : 'sessions'
}

/** The idle-review card's one-line offer — "N idle session(s)", with the PT adjective agreeing in
 *  number too ("ociosa"/"ociosas"), plus the optional "· ~freed" clause (absent, never "· ~", when
 *  no candidate's memory is known). Renamed from `idleBannerText` when the full-width banner was
 *  replaced by this compact card at the top of the sessions list. */
export function idleCardText(count: number, freed: string | null, lang: 'pt' | 'en'): string {
  const sessions = lang === 'pt'
    ? (count === 1 ? '1 sessão ociosa' : `${count} sessões ociosas`)
    : (count === 1 ? '1 idle session' : `${count} idle sessions`)
  return freed === null ? sessions : `${sessions} · ~${freed}`
}

/** The review modal's header summary — "N session(s)" (now properly pluralized) plus the optional
 *  "frees ~X" clause, which is absent (never "frees ~") when no candidate's memory is known. */
export function idleSummaryText(count: number, freed: string | null, lang: 'pt' | 'en'): string {
  const sessions = `${count} ${idleSessionNoun(count, lang)}`
  if (freed === null) return sessions
  return lang === 'pt' ? `${sessions} · libera ~${freed}` : `${sessions} · frees ~${freed}`
}

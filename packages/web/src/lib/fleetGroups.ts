/**
 * fleetGroups.ts — which sub-group a fleet row belongs to, for the sessions aside — PURE.
 *
 * Project and Task reuse `groupSessions` in `@agentistics/tui/control/session-fleet` — the very
 * function the terminal cockpit and `agentop session ls` resolve their bands with. A second
 * implementation of "which band does this row belong to" is exactly the defect that module exists
 * to remove.
 *
 * Status is the one exception, and it is web-only on purpose. The shared `status` dimension in
 * `session-dimensions.ts` deliberately collapses `exited`/`lost`/`closed` into one `Off` bucket —
 * the "3 desligadas, wtf" fix, a decision made for the terminal's filter menu and tested there.
 * This aside groups by the raw `session.state` instead (seven distinct buckets), because that is
 * a different, purely visual arrangement question, and reusing the collapsed dimension would
 * either mislabel a merged bucket or reopen a decision this feature has no reason to touch.
 *
 * What lives here besides the grouping itself: the WORDS (this module deliberately owns none of
 * `groupSessions`'s own vocabulary, but Status needs its own, since it does not go through that
 * function), the rule that a band holding one group draws no heading, and the manual reordering a
 * person can apply on top of the automatic (most-urgent-first) order.
 */

import {
  DEFAULT_ORDER, dimensionWordBook, groupSessions, sessionRank, sortSessions,
  type ControlSession, type DimensionWordBook, type SessionGroup, type SessionState,
} from '@agentistics/tui/control/session-fleet'
import type { AsideGroupBy } from './sessionsAsidePrefs'

type Lang = 'pt' | 'en'

/**
 * The word book, built for Project and Task — the two dimensions that still go through
 * `groupSessions`. Status never reads this: see `STATUS_GROUP_WORDS` below.
 *
 * `DimensionWordBook` is a `Record` over every dimension because `groupSessions` takes the whole
 * book; this aside only ever asks for one of them at a time. The other entries carry their real
 * names so nothing reads as a placeholder, but only `project` needs a `values` map — a project,
 * repo, model or task key IS its name.
 */
function wordBook(lang: Lang): DimensionWordBook {
  const pt = lang === 'pt'
  return dimensionWordBook({
    labels: {
      day: pt ? 'Dia' : 'Day',
      status: pt ? 'Estado' : 'Status',
      harness: pt ? 'Assistente' : 'Assistant',
      model: pt ? 'Modelo' : 'Model',
      project: pt ? 'Projeto' : 'Project',
      repo: pt ? 'Repositório' : 'Repository',
      task: pt ? 'Tarefa' : 'Task',
      marked: pt ? 'Marcadas' : 'Marked',
    },
    // Each absence is its OWN sentence: "the folder was never recorded" and "no delivery filed"
    // are different facts, and one blank heading shared between them is how a list starts lying.
    unfiled: {
      day: pt ? 'Sem data' : 'No date',
      status: pt ? 'Sem estado' : 'No status',
      harness: pt ? 'Assistente desconhecido' : 'Unknown assistant',
      model: pt ? 'Sem modelo' : 'No model',
      project: pt ? 'Sem projeto' : 'No project',
      repo: pt ? 'Fora de um repositório' : 'Outside a repository',
      // The same word `SessionFacts.tsx` already prints on a row's own delivery chip — a group
      // heading calling this "no task" while the row underneath it says "no delivery" is one
      // feature disagreeing with itself about its own vocabulary.
      task: pt ? 'Sem entrega' : 'No delivery',
      marked: pt ? 'Não marcadas' : 'Not marked',
    },
    states: {},
    goneProject: pt ? 'Pasta removida' : 'Folder is gone',
    marked: pt ? 'Marcadas' : 'Marked',
  })
}

/** The seven raw states, in the words this aside heads a Status group with. */
const STATUS_GROUP_WORDS: Record<SessionState, { en: string; pt: string }> = {
  working: { en: 'Working', pt: 'Trabalhando' },
  waiting: { en: 'Needs you', pt: 'Precisa de você' },
  'waiting-approval': { en: 'Needs approval', pt: 'Precisa de aprovação' },
  exited: { en: 'Finished', pt: 'Encerradas' },
  lost: { en: 'Lost', pt: 'Desconectadas' },
  closed: { en: 'Closed', pt: 'Fechadas' },
  unknown: { en: 'External', pt: 'Externas' },
}

/**
 * One group per raw state — never through `bucketKey`/`groupSessions`, and never collapsed.
 *
 * Ordered the same way `groupSessions` orders every other dimension: by each group's most urgent
 * member, ties broken by label.
 */
function statusGroups(rows: readonly ControlSession[], lang: Lang): SessionGroup[] {
  const groups = new Map<SessionState, SessionGroup>()
  for (const s of rows) {
    const found = groups.get(s.state)
    if (found) found.sessions.push(s)
    else groups.set(s.state, { key: s.state, label: STATUS_GROUP_WORDS[s.state][lang], sessions: [s] })
  }
  return [...groups.values()]
    .map(g => ({ ...g, sessions: sortSessions(g.sessions, DEFAULT_ORDER) }))
    .sort((a, b) => {
      const byRank = sessionRank(a.sessions[0]!) - sessionRank(b.sessions[0]!)
      return byRank !== 0 ? byRank : a.label.localeCompare(b.label)
    })
}

/**
 * Reorder groups by a person's manual choice — PURE.
 *
 * A key in `order` that no longer has a group (a deleted task, a status nobody has right now)
 * simply is not in `groups` and drops out on its own — nothing to reconcile. A group not yet in
 * `order` (a brand new task, a status nobody has seen before) is appended after every
 * manually-placed group, in whatever order the automatic urgency-first sort already gave it — so
 * a new group is never lost, only unpositioned until somebody moves it.
 */
export function applyManualOrder(
  groups: readonly SessionGroup[],
  order: readonly string[],
): SessionGroup[] {
  if (order.length === 0) return [...groups]
  const byKey = new Map(groups.map(g => [g.key, g]))
  const known = order
    .map(k => byKey.get(k))
    .filter((g): g is SessionGroup => g !== undefined)
  const knownKeys = new Set(known.map(g => g.key))
  const rest = groups.filter(g => !knownKeys.has(g.key))
  return [...known, ...rest]
}

/**
 * The fleet as groups of the chosen dimension — most urgent group first, and the rows inside each
 * in `DEFAULT_ORDER` — with the person's manual order applied on top.
 */
export function asideGroups(
  rows: readonly ControlSession[],
  by: AsideGroupBy,
  lang: Lang,
  order: readonly string[] = [],
): SessionGroup[] {
  if (rows.length === 0) return []
  const raw = by === 'status'
    ? statusGroups(rows, lang)
    : groupSessions(rows, by, wordBook(lang), [], DEFAULT_ORDER)
  return applyManualOrder(raw, order)
}

/** Whether these bands are worth heading at all — a band holding ONE group repeats what the band
 *  above it already said and costs a row, the same reason the cockpit's cascade drops its root
 *  when the grouping is already the project. */
export function showsGroupHeadings(groups: readonly SessionGroup[]): boolean {
  return groups.length > 1
}

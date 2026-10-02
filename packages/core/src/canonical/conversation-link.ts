/**
 * canonical/conversation-link.ts — PURE. WHERE a session's conversation link came from, and if there
 * is none, whether one will ever exist. The session surface's question (the chat chooses between
 * "not linked yet" and "this harness can never be linked this way").
 *
 * Named `SessionConversationLink`, not `ConversationLink`: `entities.ts` already exports
 * `ConversationLink` (`assigned | observed | none`, the RUN's vocabulary). The three vocabularies
 * answer different questions and keep their names; `rollupProvenanceOf` maps to the rollup's.
 *
 * `unrecoverable` is NEVER inferred from absence: a live session with no link yet is `null`.
 */
import type { HarnessId } from '../types'

export type ConversationLinkProvenance = 'spawn' | 'recovered' | 'unrecoverable'

export type ConversationLinkReason =
  | 'assigned-id' | 'resumed-id'
  | 'harness-session-file' | 'process-log' | 'first-sighting'
  | 'no-id-route' | 'platform-unsupported' | 'external-process'

export interface SessionConversationLink {
  provenance: ConversationLinkProvenance
  reason: ConversationLinkReason
  /** `true` for spawn/* and the harness's-own-statement recoveries; first-sighting is `false`. */
  exact: boolean
}

const PROVENANCE: Record<ConversationLinkReason, ConversationLinkProvenance> = {
  'assigned-id': 'spawn', 'resumed-id': 'spawn',
  'harness-session-file': 'recovered', 'process-log': 'recovered', 'first-sighting': 'recovered',
  'no-id-route': 'unrecoverable', 'platform-unsupported': 'unrecoverable', 'external-process': 'unrecoverable',
}

export const CONVERSATION_LINK_REASONS = Object.keys(PROVENANCE) as ConversationLinkReason[]

const make = (reason: ConversationLinkReason): SessionConversationLink => ({
  provenance: PROVENANCE[reason],
  reason,
  exact: PROVENANCE[reason] !== 'unrecoverable' && reason !== 'first-sighting',
})

/**
 * `null` = not linked YET. Rules: an external process is `unrecoverable`; a recorded
 * `linkVia` wins; absent `linkVia` + a conversation id reads by the legacy field (absent/`assigned`
 * → `spawn/assigned-id`, `observed` → `recovered/first-sighting`). `no-id-route` /
 * `platform-unsupported` are decided by the caller (`noRoute`, `platform`) from harness facts.
 */
export function conversationLinkOf(o: {
  harness: HarnessId
  conversationId?: string
  linkVia?: ConversationLinkReason
  conversationLink?: 'assigned' | 'observed'
  external: boolean
  platform: NodeJS.Platform
  /** The harness has no assign flag, no id-taking resume and no session record. */
  noIdRoute?: boolean
  /** The only route is a `/proc` read (agy). */
  needsProc?: boolean
}): SessionConversationLink | null {
  if (o.external) return make('external-process')
  if (o.conversationId) {
    if (o.linkVia) return make(o.linkVia)
    return make(o.conversationLink === 'observed' ? 'first-sighting' : 'assigned-id')
  }
  if (o.noIdRoute) return make('no-id-route')
  if (o.needsProc && o.platform !== 'linux') return make('platform-unsupported')
  return null
}

/** The rollup's vocabulary (`task-model.ts` `LinkProvenance`). */
export function rollupProvenanceOf(link: SessionConversationLink | null): 'assigned' | 'observed' | 'none' {
  if (!link || link.provenance === 'unrecoverable') return 'none'
  return link.reason === 'first-sighting' ? 'observed' : 'assigned'
}

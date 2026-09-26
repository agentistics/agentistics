/**
 * The edit-policy slot — B1 spec §4.6 (docs/superpowers/specs/2026-09-25-runtime-b1-provider.md).
 *
 * PURE. B1 rewrites no history: `ProviderRequest.messages` is sent verbatim and nothing in B1
 * reads this policy. The type exists so the context-manager phase (CM §7) plugs into a declared
 * slot on `ProviderClient.capabilities.editPolicy` rather than widening the client interface later.
 * Every provider adapter states which content kinds may be replaced in place, and the context
 * manager may never edit a kind its provider declares immutable.
 */

import type { ProviderId } from '../providers'

/** The kinds of content a provider's history could ever contain a replaceable copy of. */
export type EditableKind = 'tool-result' | 'tool-input' | 'reasoning' | 'assistant-text'

/**
 * `replaceable`: the provider is known to accept an edited copy of this kind in place.
 * `immutable`: replacing it is known — or, for a product rule, decided — to be unsafe.
 * `unverified`: nobody has measured it either way; treated as NOT editable (see `mayReplace`).
 */
export type EditPermission = 'replaceable' | 'immutable' | 'unverified'

interface EditPolicyCommon {
  provider: ProviderId
  kinds: Record<EditableKind, EditPermission>
  /** the doc or measurement this declaration rests on */
  source: string
}

/**
 * A discriminated union so that `status: 'measured'` WITHOUT `verifiedAt` fails to type-check —
 * a measured policy with no recorded measurement date is a contradiction the compiler should
 * catch, not a runtime check.
 */
export type EditPolicy =
  | (EditPolicyCommon & { status: 'declared-unverified'; verifiedAt?: undefined })
  | (EditPolicyCommon & { status: 'measured'; verifiedAt: string })

/**
 * Anthropic's edit policy: declared, UNVERIFIED (B1 spec §4.6). `reasoning: 'immutable'` — CM §7
 * cites Anthropic's own documentation that editing earlier turns can invalidate later reasoning
 * blocks on its newest models, mechanised by the signed `signature_delta` (R12 §1.3).
 * `assistant-text: 'immutable'` is a PRODUCT rule, not an API one (CM §7): assistant text is never
 * rewritten in place here, regardless of what the API would accept.
 * `tool-result` and `tool-input` are `unverified` — nobody has sent Anthropic an edited history and
 * checked it is accepted with the reasoning intact; that measurement belongs to the context-manager
 * phase (CM §7), not to B1.
 */
export const ANTHROPIC_EDIT_POLICY: EditPolicy = Object.freeze({
  provider: 'anthropic',
  kinds: Object.freeze({
    'tool-result': 'unverified',
    'tool-input': 'unverified',
    reasoning: 'immutable',
    'assistant-text': 'immutable',
  }),
  status: 'declared-unverified',
  source:
    'CM §7 (docs/superpowers/specs/2026-09-25-runtime-context-manager-design.md), citing ' +
    "Anthropic's documentation that editing earlier turns can invalidate later reasoning blocks " +
    '(signed signature_delta, R12 §1.3); assistant-text immutability is a product rule (CM §7 line 227).',
})

/**
 * True ONLY for `'replaceable'`. An `'unverified'` kind is NOT editable: the context manager may
 * never edit a kind nobody has verified, exactly as a metric with an unknown capability renders
 * N/A rather than a confident value — "nobody measured this yet" must read as "no", not as "sure,
 * why not".
 */
export function mayReplace(policy: EditPolicy, kind: EditableKind): boolean {
  return policy.kinds[kind] === 'replaceable'
}

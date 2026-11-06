/**
 * nayLaunch.ts — PURE: the harness / model / reasoning effort a Nay conversation starts with, as the
 * web shows and edits it. The server decides for real (`sessions/nay-launch.ts`); this file only
 * builds the picker's options and the one-line summary a conversation header wears.
 *
 * `''` always means "the CLI's own default", never "none": the flag is simply not passed.
 * Only what each CLI really accepts is offered — the efforts it prints and, where it has no model
 * flag, no model picker at all (`HarnessAnswer` from `/api/fleet/new`, built from `spawn-spec.ts`).
 */

import { bindingPct, type PlanLimits } from '@agentistics/core'
import type { HarnessAnswer } from './wizardSteps'

/** `account` is `''` for "Automática" (the account router picks the one with most room). It is a per-start
 *  choice: it is not part of the saved Settings -> Chat defaults. */
export interface NayLaunchChoice { harness: string; model: string; effort: string; account: string }

export const NAY_DEFAULT_HARNESS = 'claude'

export interface SelectOption { value: string; label: string }

/** `labels` is the product's own name for each harness (`HARNESS_LABELS`); the server's label is the
 *  fallback, since it can be the bare CLI name. */
export function harnessOptions(harnesses: readonly HarnessAnswer[], labels: Record<string, string> = {}): SelectOption[] {
  return harnesses.map(h => ({ value: h.id, label: labels[h.id] ?? h.label }))
}

const defaultLabel = (pt: boolean, name?: string) =>
  (pt ? 'Padrão do assistente' : 'Assistant default') + (name ? ` (${name})` : '')

/** `null` when the harness has no model flag — the picker is then absent, not empty. */
export function modelOptions(h: HarnessAnswer | undefined, pt: boolean, current = ''): SelectOption[] | null {
  if (!h || !h.supportsModel) return null
  const models = h.models && h.models.length > 0 ? h.models : h.modelSuggestions.map(id => ({ id, label: id }))
  const named = h.defaultModel ? models.find(m => m.id === h.defaultModel)?.label ?? h.defaultModel : undefined
  const out = [{ value: '', label: defaultLabel(pt, named) }, ...models.map(m => ({ value: m.id, label: m.label }))]
  // A typed id the catalog does not list (a free-text CLI) stays selectable rather than vanishing.
  if (current && !out.some(o => o.value === current)) out.push({ value: current, label: current })
  return out
}

/** `null` when the CLI has no effort flag. */
export function effortOptions(h: HarnessAnswer | undefined, pt: boolean): SelectOption[] | null {
  if (!h || h.efforts.length === 0) return null
  return [{ value: '', label: defaultLabel(pt, h.defaultEffort) }, ...h.efforts.map(e => ({ value: e, label: e }))]
}

/**
 * Bring a saved or half-edited choice in line with what this machine can run: an unknown harness
 * falls back to Claude Code (or the first one offered), and a model or effort that does not belong
 * to the chosen harness is cleared to its default. Never invents a value.
 */
export function normalizeChoice(c: Partial<NayLaunchChoice>, harnesses: readonly HarnessAnswer[]): NayLaunchChoice {
  const ids = harnesses.map(h => h.id)
  const harness = [c.harness, NAY_DEFAULT_HARNESS, ids[0]].find(id => id && ids.includes(id)) ?? (c.harness || NAY_DEFAULT_HARNESS)
  const h = harnesses.find(x => x.id === harness)
  const models = h?.models?.map(m => m.id) ?? h?.modelSuggestions ?? []
  const model = h?.supportsModel && c.model && (models.includes(c.model) || h.modelFreeText) ? c.model : ''
  const effort = h && c.effort && h.efforts.includes(c.effort) ? c.effort : ''
  // An account belongs to its harness; the field validates it against the accounts it can list.
  const account = c.account && c.harness === harness ? c.account : ''
  return { harness, model, effort, account }
}

/** Changing the harness clears the model and effort: they belonged to the previous one. */
export function withHarness(c: NayLaunchChoice, harness: string): NayLaunchChoice {
  return c.harness === harness ? c : { harness, model: '', effort: '', account: '' }
}

/**
 * "Claude Code · Opus 4.8 · high" — what a conversation runs on, for its header. A model or effort
 * that was never passed reads as the assistant's default rather than being left out, so the line
 * never implies a choice nobody made.
 */
export function launchSummary(
  run: { harness: string; model?: string | undefined; effort?: string | undefined },
  harnessLabel: string,
  harness: HarnessAnswer | undefined,
  pt: boolean,
): string {
  const parts = [harnessLabel]
  if (!harness || harness.supportsModel) {
    const name = run.model ? harness?.models?.find(m => m.id === run.model)?.label ?? run.model : (pt ? 'modelo padrão' : 'default model')
    parts.push(name)
  }
  if (run.effort) parts.push(run.effort)
  return parts.join(' · ')
}


export interface AccountChoice {
  value: string
  label: string
  /** 0..100 of the binding window still free; `null` when no window is known. */
  freePct: number | null
  /** Under this the row says so in words — a bar alone does not. */
  nearLimit: boolean
}

export const NEAR_LIMIT_FREE_PCT = 15

const freeOf = (l: PlanLimits, now: number): number | null =>
  l.windows.length === 0 ? null : Math.max(0, Math.min(100, Math.round(100 - bindingPct(l, now))))

/**
 * The accounts a harness can start on, for the Nay selector: the ones the plan-limits store knows,
 * each with the room left. `auto` is the account router's pick — the one with most room — and it is
 * the default, so a person who never opens the field gets what every other start gets.
 * `labels` is `accountLabels` from `usePlanLimits` (key `harness:account`).
 */
export function accountChoices(
  limits: readonly PlanLimits[] | null,
  labels: Record<string, string>,
  harness: string,
  now: number,
): { auto: AccountChoice | null; accounts: AccountChoice[] } {
  const mine = (limits ?? []).filter(l => l.harness === harness)
  const accounts = mine.map(l => {
    const freePct = freeOf(l, now)
    return {
      value: l.account,
      label: labels[`${harness}:${l.account}`] ?? l.label ?? l.plan ?? l.sourcePlan ?? l.account,
      freePct,
      nearLimit: freePct !== null && freePct < NEAR_LIMIT_FREE_PCT,
    }
  })
  if (accounts.length === 0) return { auto: null, accounts }
  const best = accounts.reduce((a, b) => ((b.freePct ?? -1) > (a.freePct ?? -1) ? b : a))
  return { auto: { value: '', label: best.label, freePct: best.freePct, nearLimit: best.nearLimit }, accounts }
}

/**
 * nayLaunch.ts — PURE: the harness / model / reasoning effort a Nay conversation starts with, as the
 * web shows and edits it. The server decides for real (`sessions/nay-launch.ts`); this file only
 * builds the picker's options and the one-line summary a conversation header wears.
 *
 * `''` always means "the CLI's own default", never "none": the flag is simply not passed.
 * Only what each CLI really accepts is offered — the efforts it prints and, where it has no model
 * flag, no model picker at all (`HarnessAnswer` from `/api/fleet/new`, built from `spawn-spec.ts`).
 */

import type { HarnessAnswer } from './wizardSteps'

export interface NayLaunchChoice { harness: string; model: string; effort: string }

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
  return { harness, model, effort }
}

/** Changing the harness clears the model and effort: they belonged to the previous one. */
export function withHarness(c: NayLaunchChoice, harness: string): NayLaunchChoice {
  return c.harness === harness ? c : { harness, model: '', effort: '' }
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

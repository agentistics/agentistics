/**
 * nay-launch.ts — PURE: what a new Nay conversation starts WITH — harness, model and reasoning
 * effort.
 *
 * Two sources, in this order: what the person picked in the dock's create picker (the request),
 * then the defaults saved in Settings -> Chat (`chatHarness` / `chatModel` / `chatEffort`). A
 * request that names something this machine cannot run is REFUSED, because the person is looking
 * at the picker and would otherwise get a session that is not the one they asked for. A saved
 * default that no longer applies is DROPPED quietly, because nobody chose it just now: a model left
 * over from another CLI, or an effort a CLI no longer prints, falls back to the CLI's own default
 * rather than failing every new conversation until somebody visits Settings.
 *
 * Only the flags each CLI really accepts: `efforts` is the closed list the CLI prints
 * (`spawn-spec.ts`), and a model is passed only to a harness with a model flag.
 */

export interface NayHarnessOption {
  id: string
  supportsModel: boolean
  efforts: readonly string[]
  models: readonly { id: string }[]
  /** The CLI accepts ids outside the list (the catalog is the verified table, not the CLI's own). */
  modelFreeText: boolean
}

export interface NayDefaults { chatHarness?: string; chatModel?: string; chatEffort?: string }
export interface NayLaunchRequest { harness?: unknown; model?: unknown; effort?: unknown }

export interface NayLaunch { harness: string; model?: string; effort?: string }
export type NayLaunchResult =
  | ({ ok: true } & NayLaunch)
  | { ok: false; reason: 'unknown_harness' | 'unknown_effort' | 'no_model_flag' | 'no_harness'; value?: string }

/** The harness a Nay conversation uses when nobody chose one: Nay was built on Claude Code. */
export const NAY_DEFAULT_HARNESS = 'claude'

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,127}$/

function savedModel(opt: NayHarnessOption, want: string | undefined): string | undefined {
  const id = want?.trim() ?? ''
  if (!id || !opt.supportsModel) return undefined
  if (opt.models.some(m => m.id === id)) return id
  return opt.modelFreeText && SAFE_ID.test(id) ? id : undefined
}

export function planNayLaunch(
  req: NayLaunchRequest,
  saved: NayDefaults,
  harnesses: readonly NayHarnessOption[],
): NayLaunchResult {
  const byId = new Map(harnesses.map(h => [h.id, h]))
  let harness: string
  if (typeof req.harness === 'string' && req.harness !== '') {
    if (!byId.has(req.harness)) return { ok: false, reason: 'unknown_harness', value: req.harness }
    harness = req.harness
  } else {
    const pick = [saved.chatHarness, NAY_DEFAULT_HARNESS, harnesses[0]?.id].find(h => h && byId.has(h))
    if (!pick) return { ok: false, reason: 'no_harness' }
    harness = pick
  }
  const opt = byId.get(harness)!
  // A saved model and effort belong to the SAVED harness; carried onto another one they would be
  // a claude model handed to codex.
  const savedHarness = byId.has(saved.chatHarness ?? '') ? saved.chatHarness : NAY_DEFAULT_HARNESS
  const sameAsSaved = harness === savedHarness

  let model: string | undefined
  if (typeof req.model === 'string') {
    const id = req.model.trim()
    if (id && !opt.supportsModel) return { ok: false, reason: 'no_model_flag', value: id }
    model = id || undefined
  } else if (sameAsSaved) model = savedModel(opt, saved.chatModel)

  let effort: string | undefined
  if (typeof req.effort === 'string') {
    const e = req.effort.trim()
    if (e && !opt.efforts.includes(e)) return { ok: false, reason: 'unknown_effort', value: e }
    effort = e || undefined
  } else if (sameAsSaved && saved.chatEffort && opt.efforts.includes(saved.chatEffort)) effort = saved.chatEffort

  return { ok: true, harness, ...(model ? { model } : {}), ...(effort ? { effort } : {}) }
}

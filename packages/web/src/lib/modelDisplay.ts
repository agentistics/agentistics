/**
 * modelDisplay.ts — PURE. The model name a session card shows.
 *
 * The transcript's recorded model ("claude-opus-5-5") is what actually ran; the spawn alias
 * ("opus") is only what was asked for. Observed wins; the alias is the fallback for a session
 * that has not recorded anything yet.
 *
 * `modelLabel` labels the SPAWN ids of `HARNESS_MODELS` ("opus"), not the full ids transcripts
 * record, so a Claude id of the shape `claude-<family>-<major>[-<minor>][-<date>]` is read here
 * ("Opus 5.5"). Anything else is shown exactly as recorded — a guessed label over an id this
 * table does not know would be the confident-zero defect in words.
 */
import { modelLabel } from '@agentistics/core'

const CLAUDE_ID = /^claude-([a-z]+)-(\d{1,2})(?:-(\d{1,2}))?(?:-\d{8})?$/

export function modelDisplay(harness: string, observed?: string | null, started?: string | null): string | undefined {
  if (!observed) return started || undefined
  const labelled = modelLabel(harness, observed)
  if (labelled !== observed) return labelled
  const m = CLAUDE_ID.exec(observed)
  if (m) return `${m[1]![0]!.toUpperCase()}${m[1]!.slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}`
  return observed
}

/**
 * The composer band's model. A model the session's PROTOCOL states it runs now (a structured row's
 * `set_config_option` answer, a source's own control) is the present tense and wins; the transcript's
 * model is the past tense — what answered the last turn, read once with the page's metrics — so after a
 * switch from the menu it kept naming the old model until a reload. Without a stated one, `modelDisplay`.
 */
export function bandModel(harness: string, stated: string | null | undefined, observed?: string | null, started?: string | null): string | undefined {
  return stated || modelDisplay(harness, observed, started)
}

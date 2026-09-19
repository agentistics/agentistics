/**
 * sessionPresets.ts — reusable "quick launch" session templates ("preset/wake").
 *
 * A preset is a saved combination of what a new session needs to start: which harness to run, the
 * literal first message, and optionally where to run it and which model/effort to ask for. It is
 * per-MACHINE preference (`Preferences.sessionPresets` in `packages/server/server/preferences.ts`),
 * never board data — "a template I like to reuse" is a fact about how one person works, not about
 * the work itself, and it never travels to a central (same reasoning as `billing`/`comparisons`).
 *
 * WHY `promptTemplate` HAS NO TEMPLATING SYNTAX: it is the literal text typed into the session's
 * first message, unchanged — exactly the convention `fleet-spawn.ts`'s own `prompt` field already
 * uses (see `NewSessionModal`'s `promptWithAttachments`, which is composed by the CALLER before the
 * string ever reaches `/api/fleet/new`). Nothing in this product interpolates a first prompt, so a
 * `{{var}}` syntax here would be a second, unused convention for the same idea.
 *
 * TWO STRUCTURAL RULES CARRIED OVER FROM THE BOARD SPEC (t-918cc82233, s-d85c7d9d9d):
 * - A preset is NEVER a session. It holds no state, no tmux registration, nothing capturable — the
 *   same argument `shell-isolation.test.ts` exists to have settled once already. It must never be
 *   drawn as if it were a session row, and it can never enter the fleet registry.
 * - Launching one starts a REAL billable assistant. The caller (the web launch shelf) must gate the
 *   act with its own consent step — a click on a shelf of 44px cards is not, on its own, the
 *   deliberate act starting an assistant should require.
 */

/** A saved session template. */
export interface SessionPreset {
  id: string
  /** The user's own name for the shelf card. Required — an unnamed preset cannot be told apart
   *  from another in the launch shelf, and it doubles as the started session's `label`. */
  label: string
  /**
   * A bare `HarnessId`-shaped string, deliberately NOT typed against `HarnessId` here. A preset
   * saved on one machine may legitimately name a harness a DIFFERENT machine has not installed —
   * the closed-set check belongs at LAUNCH time (`fleet-spawn.ts`'s `planFleetSpawn`, which knows
   * what is actually startable HERE), the same separation that module already draws for `model`.
   */
  harness: string
  /** The literal first message. Required: a preset with nothing to say only picks a harness and a
   *  folder, which the ordinary new-session wizard already does in two clicks. */
  promptTemplate: string
  /** Absolute path this preset launches in. Absent means the launch shelf cannot one-click start
   *  it — the caller falls back to opening the full wizard pre-filled instead, letting the person
   *  pick a folder the one time a preset does not already name one. */
  cwd?: string
  /** Never validated against a closed set here — same reason `fleet-spawn.ts` never validates
   *  `model`: the CLI's own `--model` accepts a full model name the day it ships, and a fixed list
   *  would reject valid input. */
  model?: string
  /** Validated against the harness's own closed enum only at LAUNCH time, never here — a preset
   *  saved while one CLI version was installed may still name an effort a newer version renamed. */
  effort?: string
}

/** Past this, the settings list stops being something anyone reads top to bottom, and the honest
 *  fix is deleting old presets rather than scrolling a longer one. Well above `SHELF_PRESET_COUNT`
 *  — the cap here is about the MANAGEMENT list, not the shelf. */
export const MAX_SESSION_PRESETS = 30

/** "Only the 5 most [...]" — the board's own cut for the launch shelf (see the design note on
 *  s-d85c7d9d9d): a whole list of presets is the same board screen that already exists a tab over,
 *  so the shelf shows a SHORT shelf and points at Settings for the rest. */
export const SHELF_PRESET_COUNT = 5

/**
 * POSIX-absolute, and deliberately not a generic "looks like a path" check — mirrors
 * `fleet-spawn.ts`'s `absolutePath` exactly (duplicated rather than imported: that module is
 * server-only and this one is shared with the browser and the MCP package). A relative path
 * resolves against whichever process happens to read it, never against what the user meant, and a
 * NUL byte truncates the path in every syscall that eventually receives it.
 */
export function absolutePresetPath(raw: string): boolean {
  return raw.startsWith('/') && !raw.includes('\0')
}

function trimmedOrUndefined(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const t = raw.trim()
  return t.length > 0 ? t : undefined
}

/** What a create/edit form must have before it can be saved. Pure — no I/O, no closed-set checks
 *  against installed harnesses (that set is per-machine and the form already offers only real
 *  ones; this is the shape check every draft needs regardless of what is installed). */
export type PresetDraftIssue = 'label' | 'harness' | 'prompt' | 'cwd_relative'

export interface PresetDraftInput {
  label: string
  harness: string
  promptTemplate: string
  cwd?: string
  model?: string
  effort?: string
}

export function validatePresetDraft(input: PresetDraftInput): { ok: true } | { ok: false; issue: PresetDraftIssue } {
  if (!trimmedOrUndefined(input.label)) return { ok: false, issue: 'label' }
  if (!trimmedOrUndefined(input.harness)) return { ok: false, issue: 'harness' }
  if (!trimmedOrUndefined(input.promptTemplate)) return { ok: false, issue: 'prompt' }
  const cwd = trimmedOrUndefined(input.cwd)
  if (cwd && !absolutePresetPath(cwd)) return { ok: false, issue: 'cwd_relative' }
  return { ok: true }
}

/**
 * Read whatever is in `preferences.json` into presets we can render.
 *
 * Total, never throws. A preset that cannot pass `validatePresetDraft` is DROPPED rather than
 * repaired — a half-read preset would launch a session with an assistant or a message nobody
 * actually asked for, which is worse than the preset being gone and re-creatable in a few clicks.
 * Capped at `MAX_SESSION_PRESETS`, keeping the first ones read (insertion order) — a hand-edited or
 * corrupted-then-grown file must not silently keep growing forever.
 */
export function normalizeSessionPresets(raw: unknown): SessionPreset[] {
  if (!Array.isArray(raw)) return []
  const out: SessionPreset[] = []
  for (const item of raw) {
    if (out.length >= MAX_SESSION_PRESETS) break
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    if (typeof r.id !== 'string' || r.id === '') continue
    const label = trimmedOrUndefined(r.label)
    const harness = trimmedOrUndefined(r.harness)
    const promptTemplate = trimmedOrUndefined(r.promptTemplate)
    if (!label || !harness || !promptTemplate) continue
    const cwd = trimmedOrUndefined(r.cwd)
    if (cwd && !absolutePresetPath(cwd)) continue
    const model = trimmedOrUndefined(r.model)
    const effort = trimmedOrUndefined(r.effort)
    out.push({
      id: r.id,
      label,
      harness,
      promptTemplate,
      ...(cwd ? { cwd } : {}),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
    })
  }
  return out
}

/** Insert or replace by id, preserving order — an edit must not move a preset to the end of the
 *  shelf, which reads the same order this list is stored in. */
export function upsertSessionPreset(list: readonly SessionPreset[], next: SessionPreset): SessionPreset[] {
  const at = list.findIndex(p => p.id === next.id)
  if (at === -1) return [...list, next].slice(0, MAX_SESSION_PRESETS)
  const out = [...list]
  out[at] = next
  return out
}

export function removeSessionPreset(list: readonly SessionPreset[], id: string): SessionPreset[] {
  return list.filter(p => p.id !== id)
}

/** The ones the launch shelf actually shows — a prefix, never a re-sort: the board asked for a
 *  short shelf, not a re-ranked one, and the ones left out are still one click away in Settings. */
export function presetsForShelf(list: readonly SessionPreset[], limit = SHELF_PRESET_COUNT): SessionPreset[] {
  return list.slice(0, limit)
}

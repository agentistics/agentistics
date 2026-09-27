/**
 * limit.ts — PURE. When a session stopped because the HARNESS cut it off, and when it may go again.
 *
 * This is a different kind of stop from every other state in `attention.ts`, and the difference is
 * the whole reason it gets its own module rather than another `approval` pattern:
 *
 *  - A `waiting-approval` session is blocked on a person, and answering it costs a keystroke.
 *  - A `limit-blocked` session is blocked on a CLOCK. Nothing anyone types moves it, and a "continue"
 *    sent before the reset is not merely useless — it burns the first request of the new window on a
 *    prompt whose only content is the word continue, and the harness answers it with the same error.
 *
 * So the banner is only half of what this module reads. The other half is the RESET TIME the banner
 * carries, because a fleet-wide resume that ignores it is a button that reliably fails on every row
 * it touches.
 *
 * ## The pattern was captured, never written from memory
 *
 * Same rule as `attention-rules.ts`, and for the same reason: a plausible pattern that never matches
 * fails silently. Captured on 2026-08-14 from three live panes (`agentop-6b23834c1a`,
 * `agentop-d41dc788ef`, `agentop-cbf341b8c8`) with `tmux capture-pane -p`, claude 2.1.231, and
 * re-read byte by byte through `cat -A`:
 *
 * ```
 *   ⎿ ␣You've hit your session limit · resets 6:30pm (America/Sao_Paulo)
 *      /upgrade to increase your usage limit.
 * ```
 *
 * Two things in there would have been guessed wrong. The space before `You've` is a NON-BREAKING
 * space (U+00A0, `M-BM- ` under `cat -A`) and the separator is a MIDDLE DOT (U+00B7, `M-BM-7`) — a
 * pattern written with an ASCII space and an ASCII `-` matches neither. The patterns below therefore
 * anchor on the WORDS and spell every gap `\s+`, which is what makes them survive both the nbsp and
 * the tool-result indent; `limit.test.ts` fails the build if a literal space is ever typed into one.
 * The apostrophe in `You've` really is ASCII (`cat -A` left it alone), and is matched as a character
 * class anyway so a future curly one does not silently switch the feature off.
 *
 * The same sentence also arrives inside a SUBAGENT failure, captured verbatim from the third pane:
 *
 * ```
 *   ● Agent "…" failed: Agent terminated early due to an API error: You've hit your session limit · resets 6:30pm (America/Sao_Paulo)
 * ```
 *
 * That line is matched too, deliberately. The limit belongs to the ACCOUNT, not to the subagent that
 * happened to reach it first, so the parent's very next request fails the same way — and in the pane
 * it was read from, both forms were on screen together.
 *
 * ## Why the tail and not the frame
 *
 * The banner is transcript CONTENT, not chrome. It scrolls with the conversation and stays on screen
 * long after the session has resumed and done more work — so "the banner appears in the frame" would
 * pin a working session to `limit-blocked` until the text happened to scroll off. This is the exact
 * shape of the `esc to interrupt` bug that `MARKER_STALE_MS` exists to correct, met a second time.
 * `detectLimit` is therefore fed the frame TAIL — the last few meaningful lines, the same ones
 * `frameTail` already computes for the detail pane — so the banner counts only while it is still the
 * last thing that happened.
 *
 * The tail is also the only answer to the other way this pattern can misfire, and it is not
 * hypothetical here: agentop is developed with agentop, so a session editing THIS FILE has the
 * banner's words on its screen as source code. `attention-rules.ts` learned that the hard way with
 * `Esc to cancel · Tab to amend`. A quotation sits in the middle of a screen; the thing that just
 * stopped the session sits at the end of it.
 */

import type { HarnessId } from '@agentistics/core'

// See docs/specs/2026-08-14-session-limit-and-fleet-hygiene.md for the rest of the plan this file is
// the first step of. This module is deliberately the smallest honest piece: the banner and the
// clock. Nothing here decides what to DO about a blocked session — that is `limit-resume.ts`.

/** One harness's limit banner, read from real frames. */
export interface LimitRule {
  /** A tail line matching one of these is the harness refusing to continue. */
  banner: RegExp[]
  /**
   * Pulls the reset time out of the banner line.
   *
   * Optional because a harness may refuse without saying when it will stop refusing, and inventing a
   * time would be worse than having none: `limitCleared` treats an unknown reset as "may as well
   * try", while a wrong one blocks a resume that would have worked.
   */
  resetAt?: RegExp
  /** Provenance — the exact CLI version the frames came from, and the date. */
  probed: string
}

/**
 * `Record<HarnessId, … | null>` and not a `Partial`, exactly as `ATTENTION_RULES` and `SPAWN_SPECS`:
 * adding a harness must fail the build until someone decides. `null` IS the decision — "never seen
 * this harness hit a limit" — and the UI reports it as detection being unavailable rather than as
 * the harness having no limits.
 */
export const LIMIT_RULES: Record<HarnessId, LimitRule | null> = {
  claude: {
    probed: 'claude 2.1.231, 2026-08-14',
    banner: [
      // The tool-result form (`⎿ …`) and the subagent `API error: …` form are the same event
      // rendered in two places; both were on screen in the captured panes, and this one sentence is
      // the part they share.
      /(?:You|you)['’]ve\s+hit\s+your\s+session\s+limit/,
      // The second line of the banner. Kept even though the first line is almost always in the tail
      // beside it: `frameTail` cuts at a fixed number of MEANINGFUL lines, so a cut can land between
      // the two, and a limit read one line late is a row that never clears on its own. It carries no
      // reset time, which is exactly why the reset is looked up across the whole tail below.
      /\/upgrade\s+to\s+increase\s+your\s+usage\s+limit/,
    ],
    // `resets 6:30pm (America/Sao_Paulo)`. The zone is captured but deliberately NOT used to convert:
    // see `parseResetAt`.
    resetAt: /resets\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm))/i,
  },
  // Not probed. A limit was never observed on these under agentop, and a pattern nobody has seen a
  // frame of is a guess — the one thing this file exists to refuse.
  codex: null,
  gemini: null,
  copilot: null,
  antigravity: null,
  kimi: null,
  // No spawn-spec support (CLAUDE.md step 4, skipped by scope): agentop cannot drive an opencode
  // session, so no limit banner has ever been probed.
  opencode: null,
}

/** The rules for a harness, or `undefined` when it was never probed. */
export function limitRuleFor(harness: HarnessId): LimitRule | undefined {
  return LIMIT_RULES[harness] ?? undefined
}

/** What a limit banner said. */
export interface LimitHit {
  /** The banner line itself, trimmed — what the UI quotes so the state is never only a colour. */
  raw: string
  /**
   * The reset time as the banner WROTE it (`6:30pm`), not a timestamp.
   *
   * Absent when the banner named none, or when the harness has no `resetAt` rule.
   */
  resetsAtText?: string
  /** The same instant in epoch ms, when it could be resolved against `nowMs`. See `parseResetAt`. */
  resetsAtMs?: number
}

/**
 * The banner in a frame tail, or `undefined` — PURE.
 *
 * `tail` must be the MEANINGFUL last lines (what `frameTail` returns), never the raw frame — see the
 * module header.
 *
 * **The banner is TWO lines, and the newer one is the one that says nothing.** `/upgrade to increase
 * your usage limit.` is printed BELOW `You've hit your session limit · resets 6:30pm`, so a
 * newest-first scan meets it first — and reading the reset off that matched line alone came back with
 * no reset at all. An absent reset counts as cleared, so every genuinely blocked session would have
 * read as ready to resume and the mass resume would have burned the new window's first request on all
 * of them: a bug in the reassuring direction, at the one moment the feature is meant to fire.
 *
 * So the line that CARRIES the reset is preferred for both jobs — it is the reset, and it is also the
 * sentence worth quoting on the row, `/upgrade …` being an instruction to the user rather than a
 * statement about the session. The bare newest match is only the fallback, for the tail that cut
 * between the two lines.
 */
export function detectLimit(o: {
  tail: readonly string[]
  rule?: LimitRule
  nowMs: number
}): LimitHit | undefined {
  const rule = o.rule
  if (!rule) return undefined

  let newest: string | undefined
  let withReset: { line: string; text: string } | undefined
  // Newest first: when a session hit the limit twice, the recent one is the one still in force.
  for (let i = o.tail.length - 1; i >= 0; i--) {
    const line = (o.tail[i] ?? '').trim()
    if (!rule.banner.some(re => re.test(line))) continue
    if (newest === undefined) newest = line
    if (withReset === undefined && rule.resetAt) {
      const found = rule.resetAt.exec(line)?.[1]
      if (found) withReset = { line, text: found.trim() }
    }
    if (newest !== undefined && withReset !== undefined) break
  }

  if (newest === undefined) return undefined
  const hit: LimitHit = { raw: withReset?.line ?? newest }
  if (withReset) {
    hit.resetsAtText = withReset.text
    const ms = parseResetAt(withReset.text, o.nowMs)
    if (ms !== undefined) hit.resetsAtMs = ms
  }
  return hit
}

/**
 * Half a day, and the whole of the calendar rule below.
 *
 * A banner names a wall-clock time and no date, so `6:30pm` describes three instants — yesterday's,
 * today's and tomorrow's. The one it means is the one NEAREST the moment it is being read, which is
 * the same thing as saying it lands within twelve hours either side of now.
 */
export const HALF_DAY_MS = 12 * 60 * 60 * 1000

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * `6:30pm` against a reference instant → epoch ms, in the LOCAL clock — PURE.
 *
 * Two decisions here are deliberate:
 *
 *  - **The banner's zone is ignored.** It names the zone the HARNESS is reporting in, and agentop
 *    runs on the same machine as the session that printed it, so the local clock already agrees.
 *    Converting a wall-clock time into a zone with no date is arithmetic that goes wrong twice a year
 *    and buys nothing here — and getting it wrong pushes the reset into the future, which is the
 *    direction that leaves the whole fleet parked.
 *  - **The nearest reading of the clock wins, in BOTH directions.** A time that already passed today
 *    is TODAY's, never tomorrow's: a limit that reset at 18:30 and is read at 18:37 is over, and
 *    rolling it forward 24 hours would be the single worst answer this function can give, since it
 *    describes the exact moment the feature is supposed to fire. The mirror case is just as real and
 *    was missing — a banner printed at 23:50 saying `resets 1:00am` means the 1am AN HOUR AWAY, and
 *    reading it as today's 1am puts the reset 23 hours in the PAST, which reports a hard-blocked
 *    session as free to resume. Both are the same rule: take the candidate within half a day of now.
 */
export function parseResetAt(text: string, nowMs: number): number | undefined {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i.exec(text.trim())
  if (!m) return undefined
  const rawHour = Number(m[1])
  const minute = m[2] ? Number(m[2]) : 0
  if (rawHour < 1 || rawHour > 12 || minute > 59) return undefined
  const pm = (m[3] ?? '').toLowerCase() === 'pm'
  const hour = rawHour === 12 ? (pm ? 12 : 0) : pm ? rawHour + 12 : rawHour

  const at = new Date(nowMs)
  at.setHours(hour, minute, 0, 0)
  let ms = at.getTime()
  // More than half a day ahead means the banner belongs to YESTERDAY's reading of this clock; more
  // than half a day behind means TOMORROW's. Anything in between — including a time already past by
  // minutes, which is the case the whole feature turns on — is today's.
  if (ms - nowMs > HALF_DAY_MS) ms -= DAY_MS
  else if (nowMs - ms > HALF_DAY_MS) ms += DAY_MS
  return ms
}

/**
 * Whether the window this hit describes is OVER — PURE.
 *
 * An unknown reset counts as over. The alternative is a row nothing can ever clear, and the cost of
 * being wrong is one wasted prompt against the cost of a session parked forever.
 */
export function limitCleared(hit: LimitHit | undefined, nowMs: number): boolean {
  if (!hit) return true
  if (hit.resetsAtMs === undefined) return true
  return nowMs >= hit.resetsAtMs
}

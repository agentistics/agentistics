/**
 * Logs.tsx — a tailing viewer over this machine's service logs.
 *
 * This screen knows nothing about files, journals or docker: every line comes from
 * `host.readLog(source, max)`. That is deliberate — the log for the central is a `docker logs` call
 * and the one for a native server is a file, and letting the presentation layer learn that
 * difference is exactly how the TUI would grow a dependency on the host's filesystem.
 *
 * Nor does it know what the sources ARE. They come from `ControlStatus.services` through the pure
 * `logSources`, which is the fix for the one thing this file got persistently wrong: it used to
 * hold `['local', 'central', 'machine'] as const` and print those internal ids as labels, so the
 * selector offered `local` and `machine` — the native process and the container of the SAME logical
 * service — as two independent things, long after the model had made them one row everywhere else.
 *
 * It is the full-screen counterpart of the cockpit's detail pane: a viewport several times the size
 * of anything a pane could hold, a selector so it is not tied to whatever the cockpit has selected,
 * and every scroll key a document should answer. What it shares with the cockpit is the vocabulary
 * — the shell's `Pane` around it, an underlined active cell like the detail pane's action row, and
 * `● following` / `○ paused` said with a glyph as well as a color.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import type { ControlHost, ControlStatus, LogSource } from '../types'
import type { CliLang } from '../lang'
import type { TabChrome } from '../ControlCenter'
import { controlStrings } from '../i18n'
import {
  resolveLogsKey,
  scrollTailBy,
  windowOffset,
  type NavKey,
  type TailState,
} from '../nav'
import { Divider } from '../Surface'
import {
  fitsBeside,
  logRows,
  logSources,
  sourceAtColumn,
  sourceRowFit,
  sourceRowText,
  windowLabel,
  type LogSourceOption,
  type SourceRowFit,
} from '../surface.ts'
import { ACTION_SEP } from '../chrome.ts'
import { isActivation, wheelDelta } from '../mouse'
import { usePointer } from '../pointer'
import { truncate } from '../../components/Primitives'
import { COLORS } from '../../theme'

/**
 * How much history we ask for. Large enough that scrolling back is useful, small enough that a
 * re-read every second stays cheap even when the host has to shell out to docker.
 */
const MAX_LINES = 2000

const POLL_MS = 1000

export function Logs({ host, status, lang, width, height, isActive, onChrome }: {
  host: ControlHost
  /** `null` until the first refresh lands — the selector then has nothing to offer yet. */
  status: ControlStatus | null
  lang: CliLang
  width: number
  height: number
  isActive: boolean
  onChrome: (chrome: TabChrome) => void
}) {
  const s = controlStrings(lang)

  const sources = useMemo(() => logSources(status?.services ?? []), [status?.services])

  /** `null` before the first status: the screen has nothing to read until the host says what runs. */
  const [source, setSource] = useState<LogSource | null>(null)
  /** `null` is "not read yet" — distinct from an empty log, which is a legitimate state. */
  const [lines, setLines] = useState<string[] | null>(null)
  /**
   * The viewport, as ONE value.
   *
   * `index` plus `follow` in a single state rather than two is what lets `resolveTailKey` own the
   * whole behaviour — including the rule that any movement unpins the tail — and what gives a
   * driver that is not the keyboard (a mouse wheel, next) one shape to produce and one setter to
   * go through.
   */
  const [view, setView] = useState<TailState>({ index: 0, follow: true })

  // A source that vanished — the conflict was resolved, or the first status has just landed — must
  // not leave the screen reading a log nobody can select any more. Derived rather than corrected in
  // an effect, so there is never a render where the selector points at nothing.
  const selected: LogSourceOption | undefined =
    sources.find(o => o.source === source) ?? sources[0]
  const active = selected?.source ?? null

  // The selector, the rule and the viewport are BUDGETED rather than assumed: both header rows were
  // drawn unconditionally against `height - 2`, and at a two-row body that rendered three rows into
  // two — which Ink composites, silently dropping the selector and leaving a rule saying nothing.
  const budget = logRows(height)
  const page = budget.body
  const len = lines?.length ?? 0
  // Derived rather than stored: while following, the anchor must track a log that grows under us,
  // and a stored index would lag one poll behind the newest line.
  const anchor = view.follow ? Math.max(0, len - 1) : Math.min(view.index, Math.max(0, len - 1))

  useEffect(() => {
    if (!isActive || active === null) return
    // `alive` guards the async read: switching screens or sources with a poll in flight would
    // otherwise setState on an unmounted/stale view — a warning at best, the wrong log at worst.
    let alive = true
    let timer: ReturnType<typeof setInterval> | undefined

    const read = async () => {
      let out: string[]
      try {
        out = await host.readLog(active, MAX_LINES)
      } catch {
        // A missing log is an empty state, never an error frame.
        out = []
      }
      if (alive) setLines(out)
    }

    void read()
    // Paused means paused: no polling, so a user reading history is never yanked to the tail.
    if (view.follow) timer = setInterval(() => { void read() }, POLL_MS)

    return () => {
      alive = false
      if (timer) clearInterval(timer)
    }
  }, [host, active, view.follow, isActive])

  const pick = useCallback((next: LogSource) => {
    if (next === active) return
    setSource(next)
    setLines(null)
    // Asking for another service's log means asking what it is doing now, so a source switch
    // always lands on the tail.
    setView({ index: 0, follow: true })
  }, [active])

  useInput((input, key) => {
    const nav: NavKey = {
      input,
      upArrow: key.upArrow,
      downArrow: key.downArrow,
      pageUp: key.pageUp,
      pageDown: key.pageDown,
      home: key.home,
      end: key.end,
      shift: key.shift,
    }

    // The DIGITS pick a source (they are drawn on the selector, so they need no hint), and every
    // scroll key a document should answer — plus `f` to re-follow — goes through one pure reducer,
    // which is also where the rule that any movement unpins the tail lives. `[`/`]` used to step the
    // source as well, while the shell answered the same two keys for the TABS: one press did both.
    const intent = resolveLogsKey({ ...nav, ctrl: key.ctrl }, {
      sources: sources.length, state: { index: anchor, follow: view.follow }, length: len, page,
    })
    if (!intent) return
    if (intent.kind === 'source') return pick(sources[intent.index]!.source)
    setView(intent.state)
  }, { isActive })

  // Nothing to claim: the digits are this screen's outright, because the screens stopped answering
  // them when the numbered strip went away. They are drawn ON the selector and now do only what
  // they say — before, one keypress switched the source AND left the screen, and the row that
  // advertised it could describe only half of that.
  useEffect(() => {
    if (!isActive) return
    onChrome({
      capture: false,
      hints: [s.keyQuit, s.keyTabs, s.keyScroll, s.keyEnds, s.logFollow, s.keyLogSource],
    })
  }, [isActive, onChrome, s])

  const offset = windowOffset(anchor, len, page)
  const visible = useMemo(
    () => (lines ?? []).slice(offset, offset + page).map(sanitize),
    [lines, offset, page],
  )

  const sourceIndex = Math.max(0, sources.findIndex(o => o.source === active))
  // Fitted HERE and handed to the row, rather than measured again inside it: a click on the
  // selector is resolved against these exact cells, and two measurements of one row would agree
  // until the day the selector had to start dropping a source.
  const fit = useMemo(
    () => sourceRowFit(s.logSource, sources.map((o, i) => `${i + 1} ${o.label}`), sourceIndex, width),
    [s.logSource, sources, sourceIndex, width],
  )

  /**
   * The pointer, in this screen's own pane — the wheel scrolls, the selector switches.
   *
   * The wheel goes through `scrollTailBy`, which is where the rule that ANY movement unpins the tail
   * lives: a reader who rolled back and is yanked to the newest line one second later has been shown
   * that this screen cannot be read. A click on a log LINE does nothing — the lines are text to be
   * copied, and `shift` is what the footer says to hold while copying it.
   */
  usePointer(p => {
    const wheel = wheelDelta(p.button)
    if (wheel !== 0) {
      const next = scrollTailBy({ index: anchor, follow: view.follow }, wheel, len)
      if (next) setView(next)
      return
    }
    if (!isActivation(p) || !budget.source || p.y !== 0) return
    const at = sourceAtColumn(fit, p.x)
    if (at !== null) pick(sources[at]!.source)
  }, { isActive })

  return (
    // `flexShrink={0}`: the budget above is this screen's contract with the pane around it, and a
    // Box that shrinks would spend the same rows again on Yoga's terms.
    <Box flexDirection="column" width={width} flexShrink={0}>
      {budget.source ? (
        <SourceRow
          fit={fit}
          index={sourceIndex}
          status={view.follow ? s.logFollowing : s.logPaused}
          following={view.follow}
          position={windowLabel(offset, Math.min(page, len), len)}
          width={width}
        />
      ) : null}
      {budget.divider ? <Divider width={width} /> : null}

      {lines === null ? (
        <Text dimColor>{s.logLoading}</Text>
      ) : len === 0 ? (
        <Text dimColor>{s.logEmpty}</Text>
      ) : (
        <Box flexDirection="column">
          {visible.map((line, n) => (
            // Offset in the key, not the row number: identical lines are common in logs and a
            // positional key would make React reuse the wrong row after a scroll.
            <Text key={`${offset + n}`} wrap="truncate">
              {truncate(line, width) || ' '}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  )
}

/**
 * The selector, the scroll position and the follow state on one row — logs are the one screen
 * where every row spent on chrome is a row of content lost.
 *
 * Every cell is measured by `sourceRowFit` before anything is drawn. Left to Yoga this row shrank
 * its children instead of dropping one, which chopped `SOURCE` to `SOURC` and a source name to a
 * prefix of itself and then wrapped — a row the screen's budget had counted as one, so a log line
 * went missing under it as well.
 *
 * The status is dropped whole rather than shortened when the row is too narrow for both: `● foll…`
 * is not a terser way of saying "following", it is a row that has stopped answering, and the
 * selector is the half you cannot use the screen without.
 */
function SourceRow({ fit, index, status, following, position, width }: {
  /** Already fitted by the screen — the same cells a click on this row is resolved against. */
  fit: SourceRowFit
  index: number
  status: string
  following: boolean
  position: string
  width: number
}) {
  const right = `${position ? position + '   ' : ''}● ${status}`

  return (
    // `flexShrink={0}` on the left half: the fit above is the row's budget, and a Box that shrinks
    // would spend it again on its own terms.
    <Box flexDirection="row" width={width} justifyContent="space-between">
      <Box flexDirection="row" flexShrink={0}>
        <Text dimColor bold>{fit.label ? fit.label + '  ' : ''}</Text>
        <Text>{'  '}</Text>
        {fit.labels.map((cell, i) => {
          const active = fit.from + i === index
          return (
            <Text key={cell} color={active ? COLORS.accent : undefined} dimColor={!active}>
              {i > 0 ? ACTION_SEP : ''}
              {/* Underlined as well as accented, the same way the cockpit's action row marks the
                  verb it would run: which cell is selected must survive a flattened palette. */}
              <Text bold={active} underline={active}>{cell}</Text>
            </Text>
          )
        })}
      </Box>
      {fitsBeside(sourceRowText(fit), right, width) && (
        <Text>
          {position ? <Text dimColor>{position}   </Text> : null}
          {/* Glyph plus word: the follow state must survive a terminal that drops color. */}
          <Text color={following ? COLORS.success : COLORS.muted}>
            {following ? '●' : '○'} {status}
          </Text>
        </Text>
      )}
    </Box>
  )
}

/**
 * Tabs and stray carriage returns are the two things a log line can carry that a fixed-width
 * viewport cannot survive: both make the rendered width disagree with the string length, and the
 * truncation that keeps the viewport aligned is computed from the length.
 */
function sanitize(line: string): string {
  return line.replace(/\r/g, '').replace(/\t/g, '    ')
}

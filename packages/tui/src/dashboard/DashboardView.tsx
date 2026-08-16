/**
 * DashboardView — the metrics dashboard itself, drawn wherever it is asked for.
 *
 * ONE implementation, mounted by the control center's `dashboard` tab. It briefly had two entry
 * points — this and the standalone `agentop tui` — and that command is an alias now, because the
 * second one owned nothing but a duplicate of the chrome around these screens. Nothing here owns a
 * screen, a column, a key or a budget: a second copy of them is the bug this repo has already paid
 * for once (see `task-reopen.ts`), and it would show up as two surfaces quietly disagreeing about
 * what a session cost.
 *
 * What it does NOT do is fetch. The data arrives as a prop, because the server is the thing the
 * screen next door starts and stops: the tab reads the address the host already reported and says so
 * in words when there is nothing to read. Absence is stated, never rendered as a zero.
 */

import React from 'react'
import { Box, Text } from 'ink'
import type { AppData, HarnessId } from '@agentistics/core'
import { calcStreak } from '@agentistics/core'
import { Overview } from '../screens/Overview'
import { Projects } from '../screens/Projects'
import { History } from '../screens/History'
import { Costs } from '../screens/Costs'
import { Harnesses } from '../screens/Harnesses'
import { Hardware } from '../screens/Hardware'
import { FilterOverlay } from '../overlays/Overlays'
import { Divider } from '../control/Surface'
import { fitsBeside, sourceRowText } from '../control/surface.ts'
import { ACTION_SEP } from '../control/chrome.ts'
import { COLORS } from '../theme'
import type { TuiStrings } from '../i18n'
import type { ConnectionState } from '../data/useAppData'
import { applyHarnessFilter, DASHBOARD_SCREENS, dashboardRows, stripFit } from './view'
import type { DashboardNav } from './useDashboardNav'

/**
 * Kept exported here under its old name: it moved down to the pure view module, beside the paging
 * that is decided against its result, not out of the product.
 */
export { applyHarnessFilter } from './view'

export interface DashboardViewProps {
  /** `null` while nothing has been read yet — a different sentence from "there is nothing". */
  data: AppData | null
  apiBase?: string | null
  s: TuiStrings
  width: number
  height: number
  nav: DashboardNav
  connection: ConnectionState
  /**
   * Already-localized sentence to show INSTEAD of the screens.
   *
   * Its presence is the statement: the server is not running, or its state could not be read. A
   * dashboard that drew zeros in that situation would be answering a question it cannot answer.
   */
  notice?: string
}

export function DashboardView({ data, apiBase, s, width, height, nav, connection, notice }: DashboardViewProps) {
  const rows = dashboardRows(height)
  const fit = stripFit(s, nav.screen, width)

  const view = data ? applyHarnessFilter(data, nav.harness) : null
  const activeDates = new Set((data?.statsCache?.dailyActivity ?? []).map(d => d.date))
  const streak = calcStreak(activeDates)

  // The filter is a panel over the body rather than a screen of its own, so it takes the body's rows
  // and the strip above it keeps saying where you are.
  const body = nav.filter
    ? <FilterOverlay s={s} options={nav.filter.options} selected={nav.filter.index} max={rows.body - FILTER_CHROME} />
    : notice
      ? <Box marginTop={1}><Text color={COLORS.muted}>{notice}</Text></Box>
      : !view
        ? <Box marginTop={1}><Text color={COLORS.accent}>{s.loading}…</Text></Box>
        : <Screen id={nav.screen} data={view} apiBase={apiBase} s={s} width={width} height={rows.body} streak={streak} page={nav.page} />

  return (
    // `flexShrink={0}`: the budget above is this view's contract with whatever frames it, and a Box
    // that shrinks would spend the same rows again on Yoga's terms — which Ink composites rather
    // than clips.
    <Box flexDirection="column" width={width} flexShrink={0}>
      {rows.strip ? (
        <StripRow
          fit={fit}
          screen={nav.screen}
          // A notice means there is no address to read from, so there is no connection to describe.
          // `connecting` under a sentence saying the server is not running would be the frame
          // contradicting itself — and it is the half a reader would believe.
          connection={notice ? null : connection}
          s={s}
          width={width}
        />
      ) : null}
      {rows.divider ? <Divider width={width} /> : null}
      {body}
    </Box>
  )
}

function Screen({ id, data, apiBase, s, width, height, streak, page }: {
  id: DashboardNav['screen']
  data: AppData
  apiBase?: string | null
  s: TuiStrings
  width: number
  height: number
  streak: number
  /** The page the three LIST screens are on. The others draw no list and ignore it. */
  page: number
}) {
  switch (id) {
    case 'overview': return <Overview data={data} s={s} width={width} height={height} streak={streak} />
    case 'projects': return <Projects data={data} s={s} width={width} height={height} page={page} />
    case 'history': return <History data={data} s={s} width={width} height={height} page={page} />
    case 'costs': return <Costs data={data} s={s} width={width} height={height} page={page} />
    case 'harnesses': return <Harnesses data={data} s={s} width={width} height={height} />
    case 'hardware': return <Hardware data={data} apiBase={apiBase ?? null} s={s} width={width} height={height} />
  }
}

/**
 * The screen strip, with the connection state on the right — the log viewer's source row, applied to
 * the one other screen in this app that is a selector over a viewport.
 *
 * The connection is here rather than in the frame's badge for a reason: full-screen and inside a
 * pane, this row is the only chrome the dashboard reliably has, and "is this live" is the fact that
 * decides whether the numbers under it can be trusted. It is said with a GLYPH as well as a word, so
 * a terminal that flattens the palette loses only the emphasis.
 */
function StripRow({ fit, screen, connection, s, width }: {
  fit: ReturnType<typeof stripFit>
  screen: DashboardNav['screen']
  /** `null` when there is nothing to be connected TO — the row then says nothing about it. */
  connection: ConnectionState | null
  s: TuiStrings
  width: number
}) {
  const at = DASHBOARD_SCREENS.indexOf(screen)
  const dot = connection ? CONNECTION[connection] : null
  const right = dot ? `● ${s[dot.label]}` : ''

  return (
    <Box flexDirection="row" width={width} justifyContent="space-between">
      <Box flexDirection="row" flexShrink={0}>
        <Text dimColor bold>{fit.label ? fit.label + '  ' : ''}</Text>
        <Text>{'  '}</Text>
        {fit.labels.map((cell, i) => {
          const active = fit.from + i === at
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
      {dot && fitsBeside(sourceRowText(fit), right, width) && (
        <Text color={dot.color}>{dot.glyph} <Text dimColor>{s[dot.label]}</Text></Text>
      )}
    </Box>
  )
}

/**
 * The filter panel's own rows: the blank above it, its two borders, its title, and the blank plus
 * the hint under the list. Counted rather than guessed — every one of them is a row the list does
 * not have, and the last one is the line naming the keys that close it.
 */
const FILTER_CHROME = 6

/** Glyph, colour and word per connection state — never colour alone. */
const CONNECTION: Record<ConnectionState, { glyph: string; color: string; label: 'live' | 'connecting' | 'offline' }> = {
  live: { glyph: '●', color: COLORS.success, label: 'live' },
  // Polling IS live data, just slower; saying "polling" would name an implementation detail.
  polling: { glyph: '●', color: COLORS.accent, label: 'live' },
  connecting: { glyph: '○', color: COLORS.muted, label: 'connecting' },
  offline: { glyph: '○', color: COLORS.danger, label: 'offline' },
}

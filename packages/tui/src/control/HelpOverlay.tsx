/**
 * HelpOverlay — `?`, every key by screen (GL-04).
 *
 * A framed pane over the body, drawn by the SHELL (the screens underneath stay mounted, hidden, and
 * keep their state). The lines are the pure `helpLines` — the same table `keymap.test.ts` holds to
 * each screen's resolver — so what this prints is what the keys do. It scrolls with the shared
 * `resolveScrollKey` + `windowOffset` when it does not fit, and the scroll position is the shell's.
 */

import React from 'react'
import { Text } from 'ink'
import { COLORS } from '../theme'
import { truncate } from '../components/Primitives'
import { Pane, paneBody, paneRows } from './Pane'
import { helpKeyWidth, type HelpLine } from './keymap'
import { windowLabel } from './surface.ts'
import { padCell } from './sessions'
import type { TabId } from './types'

/** The last first-line that still fills the page — scrolling past it would show air under the list. */
export function helpMaxTop(lines: number, rows: number): number {
  return Math.max(0, lines - Math.max(1, rows))
}

export function HelpOverlay({ lines, current, top, title, width, height }: {
  lines: readonly HelpLine[]
  current: TabId
  /** First line shown — already clamped by the shell. */
  top: number
  title: string
  width: number
  height: number
}) {
  const inner = paneBody(width)
  const rows = paneRows(height)
  const at = Math.min(top, helpMaxTop(lines.length, rows))
  const shown = lines.slice(at, at + rows)
  const keyCol = helpKeyWidth(current, inner)
  // The position badge only while there IS more than a page: a list that silently ends at the fold
  // is one people conclude is the whole list.
  const badge = lines.length > rows ? windowLabel(at, shown.length, lines.length) : ''

  return (
    <Pane title={title} badge={badge} focused width={width} height={height}>
      {shown.map((line, i) => {
        const key = `${at + i}`
        if (line.kind === 'blank') return <Text key={key}> </Text>
        if (line.kind === 'title') {
          return <Text key={key} bold color={COLORS.label} wrap="truncate">{truncate(line.text, inner)}</Text>
        }
        if (line.kind === 'note') {
          return <Text key={key} dimColor wrap="truncate">{truncate(line.text, inner)}</Text>
        }
        // A keys cell wider than the column is written on a line of its own.
        if (line.keys.length > keyCol) {
          return <Text key={key} color={COLORS.accent} wrap="truncate">{truncate(line.keys, inner)}</Text>
        }
        return (
          <Text key={key} wrap="truncate">
            <Text color={COLORS.accent}>{padCell(line.keys, keyCol)}</Text>
            <Text>{'  ' + truncate(line.text, Math.max(1, inner - keyCol - 2))}</Text>
          </Text>
        )
      })}
    </Pane>
  )
}

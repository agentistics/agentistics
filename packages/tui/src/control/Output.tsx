/**
 * Output.tsx — what a running task says, inside the frame it was started from.
 *
 * The third thing that can occupy the cockpit's detail region, beside the facts and a question — and
 * the one that replaced leaving the application. The commands worth watching (`docker compose up
 * --build`, `bun run bin`) used to take the terminal: the app stepped out of the
 * alternate screen, the child inherited the tty, and the user pressed Enter to come back, having
 * lost their place. Now their output arrives on the host's output channel, already sanitised
 * (`control/stream.ts`), and lands here.
 *
 * This component decides nothing. The lines arrive ready to draw, the window they are sliced to is
 * `windowOffset`'s answer, and the follow state belongs to the screen that owns the keyboard.
 */

import React from 'react'
import { Box, Text } from 'ink'
import { truncate } from '../components/Primitives'

export interface OutputViewProps {
  /** Newest LAST, already sanitised — no escapes, no carriage returns, no tabs. */
  lines: readonly string[]
  /** First visible line, from `windowOffset`: the newest line is what has to stay visible. */
  offset: number
  /** Rows the pane's inside has. */
  rows: number
  width: number
}

export function OutputView({ lines, offset, rows, width }: OutputViewProps) {
  // Both are honest empties rather than a frame around nothing: the pane is only drawn once a task
  // has actually said something, so this is the backstop for a pane squeezed to no rows at all.
  if (rows <= 0 || lines.length === 0) return null

  const visible = lines.slice(offset, offset + rows)

  return (
    // `flexShrink={0}`: the row budget is this view's contract with the pane around it, and a Box
    // that shrinks would spend the same rows again on Yoga's terms — which Ink composites rather
    // than clips, so two lines of a build log would be painted into one.
    <Box flexDirection="column" width={width} flexShrink={0}>
      {visible.map((line, i) => (
        // The offset is in the key, not the row number: build output repeats itself line for line
        // (`#7 CACHED`), and a positional key makes React reuse the wrong row after a scroll.
        <Text key={`${offset + i}`} wrap="truncate">
          {truncate(line, width) || ' '}
        </Text>
      ))}
    </Box>
  )
}

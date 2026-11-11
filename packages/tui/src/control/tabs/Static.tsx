import React, { useEffect, useMemo } from 'react'
import { Box, Text } from 'ink'
import { COLORS } from '../../theme'
import { truncate } from '../../components/Primitives'
import { windowOffset } from '../nav'
import { Intro, introRows, SectionHeader } from '../Surface'
import { staticRows, windowLabel, wrapText } from '../surface.ts'
import type { ContentSection } from '../content'

/**
 * Static.tsx — the renderer shared by the Help, Cheat sheet and Contribute screens.
 *
 * All three are the same thing typographically: sections of `command → description` rows. One
 * component means the three cannot drift apart in alignment, scrolling or key handling, and a
 * change to the rhythm lands in all of them at once.
 *
 * They are LINEAR — prose and lists, not related live panes — so they are not cockpits and should
 * not pretend to be. What they share with the cockpit is the vocabulary: the shell frames each one
 * in the same `Pane`, the section headers are the same titled rule a pane's top border draws, and
 * prose is dim while the things you can type are not.
 *
 * The scroll cursor lives in the shell, not here. A component that owned it would lose its place
 * every time the screen was re-mounted, and the footer key hints would have to be duplicated.
 */

/** Left margin of the whole body, so section titles stand clear of their rows. */
const INDENT = 2
/** Gap between the command column and its description. */
const GAP = 2
/** Below this the two-column layout stops helping and the description goes on its own lines. */
const MIN_DESC = 24
/**
 * Ceiling on the command column even when the terminal is wide.
 *
 * One 74-character URL would otherwise drag the column out to half the screen and strand every
 * short command against a field of whitespace. Commands past this get a line of their own instead
 * of being ellipsised — a truncated URL or flag is not something you can copy and run.
 */
const MAX_CMD = 40
/**
 * `· ` in front of a paragraph, with its continuation rows hanging under the text.
 *
 * Prose and commands used to land at the same indent, distinguished only by dim — so on a flat
 * palette a sentence like "add --native to run the server natively" read as another command
 * to type. The marker is what carries that distinction with no color at all, and the hanging indent
 * is what keeps a three-row paragraph from looking like three separate notes.
 */
const NOTE_MARK = '· '
const NOTE_HANG = ' '.repeat(NOTE_MARK.length)

type Line =
  | { kind: 'title'; text: string }
  | { kind: 'blank' }
  | { kind: 'pair'; cmd: string; text: string }
  | { kind: 'note'; text: string; first: boolean }

/**
 * Flattens sections into the exact rows that will be printed.
 *
 * Exported for tests: everything about the scroll — the window, the position indicator, whether
 * there is anything to scroll at all — is derived from this length, so getting it wrong shows up
 * as a viewport that stops short of the end rather than as a visibly broken frame.
 */
export function layoutLines(
  sections: ContentSection[],
  width: number,
): { lines: Line[]; cmdWidth: number; twoColumn: boolean } {
  const bodyWidth = Math.max(1, width - INDENT)

  // The column is sized to the widest command that FITS the ceiling, so the outliers that get
  // their own line do not also get to set the width for everyone else.
  const limit = Math.max(10, Math.min(Math.floor(bodyWidth / 2), MAX_CMD))
  const fitting = sections
    .flatMap(s => s.rows.map(r => (r.cmd ?? '').length))
    .filter(n => n > 0 && n <= limit)
  const cmdWidth = fitting.length > 0 ? Math.max(...fitting) : limit
  const descWidth = bodyWidth - cmdWidth - GAP
  const twoColumn = descWidth >= MIN_DESC

  const noteWidth = Math.max(1, bodyWidth - NOTE_MARK.length)

  const lines: Line[] = []
  const note = (text: string) => {
    wrapText(text, noteWidth).forEach((l, i) => lines.push({ kind: 'note', text: l, first: i === 0 }))
  }

  for (const section of sections) {
    if (lines.length > 0) lines.push({ kind: 'blank' })
    lines.push({ kind: 'title', text: section.title })
    for (const row of section.rows) {
      if (!row.cmd) {
        note(row.text)
        continue
      }
      if (!twoColumn || row.cmd.length > cmdWidth) {
        lines.push({ kind: 'pair', cmd: row.cmd, text: '' })
        if (row.text) note(row.text)
        continue
      }
      const cmd = row.cmd
      const wrapped = row.text ? wrapText(row.text, descWidth) : ['']
      wrapped.forEach((l, i) => lines.push({ kind: 'pair', cmd: i === 0 ? cmd : '', text: l }))
    }
  }
  return { lines, cmdWidth, twoColumn }
}

export function StaticTab({ sections, width, height, intro, copyHint, scrollIndex, onScrollChange }: {
  sections: ContentSection[]
  width: number
  height: number
  /** Already-localized one-liner shown above the content. */
  intro?: string
  /** Already-localized reminder that the commands are selectable text. */
  copyHint?: string
  /** Cursor line, owned by the shell. The window follows it. */
  scrollIndex: number
  /** Reported when the cursor has to be clamped — a resize can shrink the content under it. */
  onScrollChange?: (index: number) => void
}) {
  const { lines, cmdWidth } = useMemo(() => layoutLines(sections, width), [sections, width])

  // The intro is measured rather than assumed to be one row: at 80 columns every one of them wraps,
  // and a body budgeted for a row it did not take would push its last row under the pane's border.
  // `staticRows` is what decides which pieces the height can afford — see the note there on why an
  // overflow here is composited rather than clipped.
  const rows = staticRows(height, introRows(intro, width))
  const bodyRows = rows.body

  const max = Math.max(0, lines.length - 1)
  const index = Math.min(Math.max(0, scrollIndex), max)

  // A narrower terminal wraps more lines and a wider one wraps fewer, so the cursor the shell
  // holds can fall outside the content it now describes. Correcting it here keeps the two in step
  // without the shell having to know how the content wrapped.
  useEffect(() => {
    if (index !== scrollIndex) onScrollChange?.(index)
  }, [index, scrollIndex, onScrollChange])

  const offset = windowOffset(index, lines.length, bodyRows)
  const visible = lines.slice(offset, offset + bodyRows)
  const scrollable = lines.length > bodyRows

  const position = scrollable ? windowLabel(offset, bodyRows, lines.length) : ''
  const footer = [position, copyHint].filter(Boolean).join('  ·  ')

  return (
    // `flexShrink={0}` is what turns an overflow into a clip. Ink's Box shrinks by default, and a
    // column taller than the pane it sits in is not cut but COMPRESSED — Yoga hands two rows the
    // same y and they are painted into the same cells.
    <Box flexDirection="column" flexShrink={0}>
      {rows.intro && intro ? <Intro text={intro} width={width} /> : null}

      {visible.map((line, i) => (
        <ContentLine
          key={offset + i}
          line={line}
          width={width}
          cmdWidth={cmdWidth}
        />
      ))}

      {rows.footer ? <Text dimColor>{truncate(footer, width)}</Text> : null}
    </Box>
  )
}

function ContentLine({ line, width, cmdWidth }: {
  line: Line
  width: number
  cmdWidth: number
}) {
  const bodyWidth = Math.max(1, width - INDENT)
  const pad = ' '.repeat(INDENT)

  if (line.kind === 'blank') return <Text> </Text>

  // Uppercase stands in for small caps, which no terminal has, and the rule carries the title to
  // the right edge exactly as a pane's top border does. These screens get one pane from the shell,
  // so this is the only structure they have — a bare title floating over its rows was what made
  // them read as a wall of text rather than as a document.
  if (line.kind === 'title') {
    return <SectionHeader title={line.text.toUpperCase()} width={width} />
  }

  if (line.kind === 'note') {
    return (
      <Text dimColor>
        {pad}{line.first ? NOTE_MARK : NOTE_HANG}
        {truncate(line.text, Math.max(1, bodyWidth - NOTE_MARK.length))}
      </Text>
    )
  }

  // One Text with nested spans, not a row of Boxes: Ink's flexbox shrinks a fixed-width Box when
  // a sibling Text is long enough to wrap, which slid the description column left by a few cells
  // on exactly the rows with the most to say. Padding the cell by hand cannot drift.
  // The command itself carries no decoration — a mouse selection of it has to paste as something
  // that runs, so nothing may end up inside the user's clipboard that they did not see.
  const cell = line.text ? line.cmd.padEnd(cmdWidth) : truncate(line.cmd, bodyWidth)
  return (
    <Text>
      <Text color={COLORS.secondary}>{pad}{cell}</Text>
      {line.text && (
        <Text dimColor>
          {' '.repeat(GAP)}{truncate(line.text, Math.max(1, bodyWidth - cmdWidth - GAP))}
        </Text>
      )}
    </Text>
  )
}

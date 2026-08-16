import React from 'react'
import { Box, Text } from 'ink'
import type { HarnessId } from '@agentistics/core'
import { COLORS, HARNESS_COLOR, HARNESS_LABEL } from '../theme'
import { windowOffset } from '../control/nav'
import type { TuiStrings } from '../i18n'

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={COLORS.accent}
      paddingX={1}
      marginTop={1}
    >
      <Text bold color={COLORS.accent}>{title}</Text>
      {children}
    </Box>
  )
}

export function FilterOverlay({ s, options, selected, max = Number.MAX_SAFE_INTEGER }: {
  s: TuiStrings
  /** null is the "all harnesses" entry, always first. */
  options: (HarnessId | null)[]
  selected: number
  /**
   * How many rows the list may draw.
   *
   * Not decoration: this panel is the BODY of the dashboard now, and a body drawn taller than its
   * pane is clipped at the bottom — which is where the cursor goes as soon as you press `↓` twice.
   * A choice you cannot see, on the control that decides what every number above it means, is the
   * one thing this list may not do, so it scrolls with the selection instead.
   */
  max?: number
}) {
  const from = windowOffset(selected, options.length, Math.max(1, max))
  const shown = options.slice(from, from + Math.max(1, max))

  return (
    <Panel title={s.filterTitle}>
      {shown.map((h, n) => {
        const i = from + n
        const label = h === null ? s.filterAll : HARNESS_LABEL[h]
        const active = i === selected
        return (
          <Text key={h ?? '__all__'} color={h ? HARNESS_COLOR[h] : undefined} inverse={active}>
            {active ? '❯ ' : '  '}{label}
          </Text>
        )
      })}
      <Box marginTop={1}><Text dimColor>{s.filterHint}</Text></Box>
    </Panel>
  )
}

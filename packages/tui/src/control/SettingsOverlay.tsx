/**
 * SettingsOverlay — the settings screen (ST-01…ST-07), drawn by the SHELL over the body like the help
 * overlay: the screens underneath stay mounted and keep their state. Every line comes from the pure
 * `settingsLines`; this only paints them.
 */
import React from 'react'
import { Box, Text } from 'ink'
import { Pane, paneBody, paneRows } from './Pane'
import type { Line } from './code'
import { settingsLines, settingsTitle, type SettingsData, type SettingsState } from './settings'

function Row({ line }: { line: Line }) {
  if (line.length === 0) return <Text> </Text>
  return (
    <Text wrap="truncate">
      {line.map((s, i) => <Text key={i} color={s.color} backgroundColor={s.bg} bold={s.bold} dimColor={s.dim}>{s.text}</Text>)}
    </Text>
  )
}

export function SettingsOverlay({ state, data, width, height }: {
  state: SettingsState
  data: SettingsData
  width: number
  height: number
}) {
  const inner = paneBody(width)
  const rows = paneRows(height)
  const narrow = width < 100
  const lines = settingsLines(state, data, inner, rows, narrow)
  return (
    <Pane title={settingsTitle(state, data.lang)} badge={data.binds.settings} focused width={width} height={height}>
      <Box flexDirection="column" width={inner} height={rows} flexShrink={0} overflow="hidden">
        {lines.map((l, i) => <Row key={i} line={l} />)}
      </Box>
    </Pane>
  )
}

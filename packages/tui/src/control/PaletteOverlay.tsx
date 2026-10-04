/**
 * Palette — the command palette overlay (GL-03): every command with its shortcut, filtered as you
 * type; the selected one's reason in words when it cannot run here. The shell owns its state and
 * runs the command; this only draws (`palette.ts` is the logic).
 */
import React from 'react'
import { Box, Text } from 'ink'
import { COLORS } from '../theme'
import { whyNot, type PaletteCommand, type PaletteContext } from './palette'

const fit = (s: string, w: number) => (s.length > w ? `${s.slice(0, Math.max(0, w - 1))}…` : s.padEnd(w))

export function Palette({ list, total, query, sel, ctx, lang, width, height }: {
  list: readonly PaletteCommand[]
  total: number
  query: string
  sel: number
  ctx: PaletteContext
  lang: 'en' | 'pt'
  width: number
  height: number
}) {
  const pw = Math.min(76, width - 4)
  const inner = pw - 4
  const rowsRoom = Math.max(3, height - 9)
  const top = Math.max(0, Math.min(sel - Math.floor(rowsRoom / 2), list.length - rowsRoom))
  const shown = list.slice(top, top + rowsRoom)
  const selected = list[sel]
  const reason = selected ? whyNot(selected, ctx, lang) : null
  const pt = lang === 'pt'
  return (
    <Box flexDirection="column" width={width} height={height} alignItems="center">
      <Box flexDirection="column" borderStyle="round" borderColor={COLORS.accent} width={pw} paddingX={1}>
        <Box justifyContent="space-between">
          <Text color={COLORS.accent} bold>{pt ? 'comandos' : 'commands'}</Text>
          <Text color={COLORS.muted}>ctrl+p</Text>
        </Box>
        <Text><Text color={COLORS.text}>› </Text><Text>{query}</Text><Text color={COLORS.accent}>▍</Text></Text>
        <Text> </Text>
        {shown.length === 0
          ? <Text color={COLORS.muted}>{pt ? 'nenhum comando corresponde — esc fecha' : 'no command matches — esc closes'}</Text>
          : shown.map((c, i) => {
            const at = top + i
            const blocked = whyNot(c, ctx, lang) !== null
            const keys = c.keys
            const left = `${at === sel ? '▸' : ' '} ${c.label.padEnd(13)} ${c.description[lang]}`
            return (
              <Text key={c.id} inverse={at === sel} dimColor={blocked && at !== sel} color={at === sel ? COLORS.accent : blocked ? COLORS.muted : undefined}>
                {fit(left, Math.max(1, inner - keys.length - 1))}<Text color={COLORS.muted}>{` ${keys}`}</Text>
              </Text>
            )
          })}
        <Text> </Text>
        {reason
          ? <Text color={COLORS.accent}>{fit(`${pt ? 'não dá aqui: ' : 'not here: '}${reason}`, inner)}</Text>
          : <Text color={COLORS.muted}>{fit(pt
            ? `${list.length} de ${total} · o atalho à direita substitui a paleta da próxima vez`
            : `${list.length} of ${total} · the shortcut on the right replaces the palette next time`, inner)}</Text>}
      </Box>
    </Box>
  )
}

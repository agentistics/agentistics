import { describe, expect, test } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { TaskVerdictCell } from './BenchTasks'
import { BenchStyle } from './BenchStyle'

const tone = (score: number | null) => /data-tone="(\w+)"/.exec(renderToStaticMarkup(<TaskVerdictCell score={score} lang="pt" />))![1]

describe('task rows keep the 55,55 / 44,45 band (prototype tomTipo), not the 52 / 48 point rule', () => {
  test.each([
    [55.55, 'good'], [55.54, 'tie'], [53, 'tie'], [52.5, 'tie'], [47, 'tie'], [44.46, 'tie'], [44.45, 'bad'], [30, 'bad'],
  ])('score %p → %p', (score, expected) => { expect(tone(score)).toBe(expected) })
  test('no score → none', () => { expect(tone(null)).toBe('none') })
})

describe('the Compensou? column may not force the table past its wrapper', () => {
  const css = renderToStaticMarkup(<BenchStyle />)
  test('no fixed min-width on the verdict cell (its nowrap word already sets the floor)', () => {
    expect(css).not.toMatch(/\.bm-tasks td\.bm-cp\{[^}]*min-width/)
  })
  test('cell padding stays tight so TAREFA keeps room (6px between columns)', () => {
    expect(css).toContain('.bm-tasks th{text-align:left;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--text-tertiary);font-weight:600;padding:6px 6px 6px 0')
    expect(css).toMatch(/\.bm-tasks td\{padding:8px 6px 8px 0;/)
  })
  test('the verdict word never wraps', () => {
    expect(renderToStaticMarkup(<TaskVerdictCell score={30} lang="pt" />)).toContain('class="bm-nw"')
  })
  test('a long task title is clamped to 3 lines (full text kept in the title attribute); phones unclamp it', () => {
    expect(css).toMatch(/\.bm-clamp\{[^}]*-webkit-line-clamp:3/)
    expect(css).toMatch(/@media[\s\S]*\.bm-clamp\{[^}]*-webkit-line-clamp:unset/)
  })
})

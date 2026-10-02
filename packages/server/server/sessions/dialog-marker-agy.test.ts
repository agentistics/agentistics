import { describe, expect, test } from 'bun:test'
import { markerReadOptions } from './approval-spec'
import { readDialog } from './dialog-choice'

/**
 * antigravity's directory-trust prompt, captured from agy 1.2.14 under tmux on 2026-10-01 (a 50-row
 * pane: the dialog sits at the TOP, with blank rows below it and the model line at the bottom).
 * Its cursor is a plain `>`, not claude's `❯`, so the numberless reader answered `none` and the web
 * offered nothing to answer it with — a session that sat on this dialog forever, never creating a
 * conversation, which is also why it never had a chat.
 */
const blank = (n: number) => Array.from({ length: n }, () => '')
const TRUST = [
  'Accessing workspace:',
  '',
  '/home/padawan/ads-next',
  '',
  'Do you trust the contents of this project?',
  '',
  'Antigravity CLI requires permission to read, edit, and execute files here.',
  '',
  '> Yes, I trust this folder',
  '  No, exit',
  '',
  '  ↑/↓ Navigate · enter Confirm',
  ...blank(36),
  '                                                                       Gemini 3.6 Flash · medium',
]

const opts = markerReadOptions('antigravity')

describe('agy trust dialog', () => {
  test('is read as two options with the cursor on "Yes"', () => {
    const r = readDialog(TRUST, opts)
    expect(r.kind).toBe('options')
    expect(r.select).toBe('marker')
    expect(r.options.map(o => [o.number, o.label, o.selected])).toEqual([
      [1, 'Yes, I trust this folder', true],
      [2, 'No, exit', false],
    ])
  })

  test('follows the cursor when it is on the other row', () => {
    const moved = TRUST.map(l => l === '> Yes, I trust this folder' ? '  Yes, I trust this folder' : l === '  No, exit' ? '> No, exit' : l)
    const r = readDialog(moved, opts)
    expect(r.options.map(o => o.selected)).toEqual([false, true])
  })
})

describe('agy chat is never read as a menu', () => {
  const chat = (...mid: string[]) => ['> only say ok', '', '  ok', '', ...mid, '', '> ', '', '? for shortcuts    Gemini 3.6 Flash · medium']

  test('a user message and the idle prompt are not options', () => {
    expect(readDialog(chat(), opts).options).toEqual([])
  })

  test('a quoted block with the same shape is not an option list without the select footer', () => {
    const quoted = ['> Yes, I trust this folder', '  No, exit', '', '? for shortcuts    Gemini 3.6 Flash · medium']
    expect(readDialog(quoted, opts).options).toEqual([])
  })

  test('the footer quoted far up in the scrollback does not arm the reader', () => {
    const lines = [
      '  ↑/↓ Navigate · enter Confirm', '', '> Yes, I trust this folder', '  No, exit', '',
      'Some long reply', 'one', 'two', 'three', 'four', 'five', '> ', '? for shortcuts',
    ]
    expect(readDialog(lines, opts).options).toEqual([])
  })
})

describe('other harnesses are untouched', () => {
  test('claude keeps reading ❯ and does not start reading >', () => {
    const o = markerReadOptions('claude')
    expect(o.glyph).toBeUndefined()
    const lines = ['> Yes, I trust this folder', '  No, exit', '', '  ↑/↓ Navigate · enter Confirm']
    expect(readDialog(lines, o).options).toEqual([])
  })

  test('a harness with no marker select reads none', () => {
    expect(markerReadOptions('gemini')).toEqual({ marker: false })
  })
})
